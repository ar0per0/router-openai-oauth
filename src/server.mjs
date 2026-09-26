import http from "node:http"
import https from "node:https"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { pipeline } from "node:stream/promises"
import { isRetryableStatus } from "./config.mjs"

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
])

class RequestError extends Error {
	constructor(statusCode, code, message) {
		super(message)
		this.statusCode = statusCode
		this.code = code
	}
}

const silentLogger = {
	info() {},
	warn() {},
	error() {},
}

const errorCode = (error) => error?.code || error?.name || "UPSTREAM_ERROR"

const safeEqual = (left, right) => {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const isAuthorized = (request, apiKey) =>
	!apiKey || safeEqual(request.headers.authorization || "", `Bearer ${apiKey}`)

const connectionHeaderNames = (headers) =>
	new Set(
		String(headers.connection || "")
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
	)

const copyHeaders = (headers) => {
	const connectionHeaders = connectionHeaderNames(headers)
	const result = {}
	for (const [name, value] of Object.entries(headers)) {
		const normalizedName = name.toLowerCase()
		if (
			value === undefined ||
			HOP_BY_HOP_HEADERS.has(normalizedName) ||
			connectionHeaders.has(normalizedName) ||
			normalizedName === "host" ||
			normalizedName === "content-length"
		) {
			continue
		}
		result[name] = value
	}
	return result
}

const responseHeaders = (headers) => {
	const connectionHeaders = connectionHeaderNames(headers)
	const result = {}
	for (const [name, value] of Object.entries(headers)) {
		const normalizedName = name.toLowerCase()
		if (
			value === undefined ||
			HOP_BY_HOP_HEADERS.has(normalizedName) ||
			connectionHeaders.has(normalizedName)
		) {
			continue
		}
		result[name] = value
	}
	return result
}

const sendJson = (response, statusCode, payload, extraHeaders = {}) => {
	if (response.headersSent || response.destroyed) return
	const body = Buffer.from(JSON.stringify(payload))
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.length,
		...extraHeaders,
	})
	response.end(body)
}

const sendError = (response, statusCode, code, message, requestId, extraHeaders = {}) =>
	sendJson(
		response,
		statusCode,
		{
			error: {
				message,
				type: "router_error",
				code,
			},
		},
		{ "x-router-request-id": requestId, ...extraHeaders },
	)

const readRequestBody = (request, maximumBytes) =>
	new Promise((resolve, reject) => {
		const chunks = []
		let total = 0
		let settled = false

		const cleanup = () => {
			request.off("data", onData)
			request.off("end", onEnd)
			request.off("aborted", onAborted)
			request.off("error", onError)
		}

		const fail = (error) => {
			if (settled) return
			settled = true
			cleanup()
			reject(error)
		}

		const onData = (chunk) => {
			total += chunk.length
			if (total > maximumBytes) {
				request.resume()
				fail(
					new RequestError(
						413,
						"request_body_too_large",
						`El cuerpo supera el límite de ${maximumBytes} bytes`,
					),
				)
				return
			}
			chunks.push(chunk)
		}

		const onEnd = () => {
			if (settled) return
			settled = true
			cleanup()
			resolve(Buffer.concat(chunks, total))
		}

		const onAborted = () => fail(new RequestError(400, "request_aborted", "Petición cancelada"))
		const onError = (error) => fail(error)

		request.on("data", onData)
		request.once("end", onEnd)
		request.once("aborted", onAborted)
		request.once("error", onError)
	})

const parseRequestTarget = (requestUrl) => {
	const base = new URL("http://router.invalid")
	let parsed
	try {
		parsed = new URL(requestUrl || "/", base)
	} catch {
		throw new RequestError(400, "invalid_request_target", "La URL de la petición no es válida")
	}
	if (parsed.origin !== base.origin) {
		throw new RequestError(400, "invalid_request_target", "La URL de la petición no es válida")
	}
	return `${parsed.pathname}${parsed.search}`
}

const buildRequestHeaders = (request, body, requestId, apiKey) => {
	const headers = copyHeaders(request.headers)
	const hasRequestBody = body.length > 0 || request.headers["content-length"] !== undefined
	if (hasRequestBody) headers["content-length"] = String(body.length)
	if (apiKey) headers.authorization = "Bearer openai-oauth"
	headers["x-forwarded-for"] = request.socket.remoteAddress || "unknown"
	headers["x-forwarded-proto"] = request.socket.encrypted ? "https" : "http"
	if (request.headers.host) headers["x-forwarded-host"] = request.headers.host
	headers["x-router-request-id"] = requestId
	return headers
}

const requestUpstream = ({
	upstream,
	target,
	method,
	headers,
	body,
	timeoutMs,
	signal,
}) =>
	new Promise((resolve, reject) => {
		const targetUrl = new URL(target, upstream)
		const transport = targetUrl.protocol === "https:" ? https : http
		let settled = false
		const timeoutError = () => {
			const error = new Error(`El upstream no respondió durante ${timeoutMs} ms`)
			error.code = "UPSTREAM_TIMEOUT"
			return error
		}
		const timer = setTimeout(() => outgoing.destroy(timeoutError()), timeoutMs)
		timer.unref()
		const outgoing = transport.request(
			targetUrl,
			{
				method,
				headers,
				signal,
			},
			(upstreamResponse) => {
				if (settled) {
					upstreamResponse.destroy()
					return
				}
				settled = true
				clearTimeout(timer)
				upstreamResponse.setTimeout(timeoutMs, () => upstreamResponse.destroy(timeoutError()))
				resolve(upstreamResponse)
			},
		)

		outgoing.once("error", (error) => {
			clearTimeout(timer)
			if (settled) return
			settled = true
			reject(error)
		})
		outgoing.end(body)
	})

export const checkUpstreams = async (config, { logger = silentLogger, fetchImpl = fetch } = {}) => {
	const results = await Promise.all(
		config.upstreams.map(async (upstream, index) => {
			const startedAt = Date.now()
			const healthUrl = new URL("/health", upstream.url)
			try {
				const response = await fetchImpl(healthUrl, {
					headers: { authorization: "Bearer openai-oauth" },
					redirect: "manual",
					signal: AbortSignal.timeout(config.startupHealthcheckTimeoutMs),
				})
				await response.body?.cancel()
				const result = {
					index: index + 1,
					alias: upstream.alias,
					upstream: upstream.url.origin,
					status: response.status,
					healthy: response.ok,
					durationMs: Date.now() - startedAt,
				}
				if (result.healthy) logger.info("upstream_healthcheck_ok", result)
				else logger.warn("upstream_healthcheck_failed", result)
				return result
			} catch (error) {
				const result = {
					index: index + 1,
					alias: upstream.alias,
					upstream: upstream.url.origin,
					healthy: false,
					error: errorCode(error),
					durationMs: Date.now() - startedAt,
				}
				logger.warn("upstream_healthcheck_failed", result)
				return result
			}
		}),
	)

	logger.info("upstream_healthcheck_complete", {
		healthy: results.filter((result) => result.healthy).length,
		total: results.length,
	})
	return results
}

const createCircuitBreaker = (config, logger) => {
	const states = config.upstreams.map(() => ({
		consecutiveFailures: 0,
		openUntil: 0,
		probeInFlight: false,
	}))

	const details = (index) => ({
		index: index + 1,
		alias: config.upstreams[index].alias,
		upstream: config.upstreams[index].url.origin,
	})

	const acquire = (index, requestId) => {
		const state = states[index]
		const now = Date.now()
		if (state.openUntil > now) {
			const remainingMs = state.openUntil - now
			logger.warn("upstream_skipped", {
				requestId,
				...details(index),
				remainingMs,
			})
			return { allowed: false, remainingMs }
		}

		if (state.openUntil > 0) {
			if (state.probeInFlight) {
				logger.warn("upstream_skipped", {
					requestId,
					...details(index),
					reason: "recovery_probe_in_progress",
				})
				return { allowed: false, remainingMs: 1000 }
			}
			state.probeInFlight = true
			logger.info("upstream_circuit_half_open", {
				requestId,
				...details(index),
			})
			return { allowed: true, recoveryProbe: true }
		}

		return { allowed: true, recoveryProbe: false }
	}

	const succeeded = (index, requestId, reservation) => {
		const state = states[index]
		const previousFailures = state.consecutiveFailures
		const recovered = reservation.recoveryProbe || state.openUntil > 0
		state.consecutiveFailures = 0
		state.openUntil = 0
		state.probeInFlight = false
		if (recovered) {
			logger.info("upstream_circuit_closed", {
				requestId,
				...details(index),
			})
		} else if (previousFailures > 0) {
			logger.info("upstream_failure_count_reset", {
				requestId,
				...details(index),
				previousFailures,
			})
		}
	}

	const failed = (index, requestId, reservation, reason) => {
		const state = states[index]
		if (reservation.recoveryProbe) {
			state.consecutiveFailures = config.upstreamFailureThreshold
			state.openUntil = Date.now() + config.upstreamCooldownMs
			state.probeInFlight = false
			logger.warn("upstream_circuit_open", {
				requestId,
				...details(index),
				reason,
				failures: state.consecutiveFailures,
				cooldownMs: config.upstreamCooldownMs,
				disabledUntil: new Date(state.openUntil).toISOString(),
				reopened: true,
			})
			return
		}

		state.consecutiveFailures += 1
		logger.warn("upstream_failure", {
			requestId,
			...details(index),
			reason,
			failures: state.consecutiveFailures,
			threshold: config.upstreamFailureThreshold,
		})

		if (state.consecutiveFailures >= config.upstreamFailureThreshold && state.openUntil === 0) {
			state.openUntil = Date.now() + config.upstreamCooldownMs
			logger.warn("upstream_circuit_open", {
				requestId,
				...details(index),
				reason,
				failures: state.consecutiveFailures,
				cooldownMs: config.upstreamCooldownMs,
				disabledUntil: new Date(state.openUntil).toISOString(),
				reopened: false,
			})
		}
	}

	const release = (index, reservation) => {
		if (reservation.recoveryProbe) states[index].probeInFlight = false
	}

	return { acquire, succeeded, failed, release }
}

export const createRouterServer = (config, { logger = silentLogger } = {}) => {
	const circuitBreaker = createCircuitBreaker(config, logger)
	const server = http.createServer(async (request, response) => {
		const requestId = randomUUID()
		const startedAt = Date.now()
		response.setHeader("x-router-request-id", requestId)

		if ((request.method === "GET" || request.method === "HEAD") && request.url === "/health") {
			const payload = {
				status: "ok",
				upstreams: config.upstreams.length,
			}
			if (request.method === "HEAD") {
				response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
				response.end()
			} else {
				sendJson(response, 200, payload)
			}
			return
		}

		if (!isAuthorized(request, config.apiKey)) {
			request.resume()
			sendError(response, 401, "invalid_api_key", "API key no válida", requestId)
			return
		}

		if (request.method === "CONNECT") {
			request.resume()
			sendError(response, 405, "method_not_allowed", "El método CONNECT no está permitido", requestId)
			return
		}

		const controller = new AbortController()
		request.once("aborted", () => controller.abort())
		response.once("close", () => {
			if (!response.writableEnded) controller.abort()
		})

		try {
			const target = parseRequestTarget(request.url)
			const body = await readRequestBody(request, config.maxRequestBodyBytes)
			const headers = buildRequestHeaders(request, body, requestId, config.apiKey)
			const attempts = []
			const skipped = []
			let attemptNumber = 0

			for (let index = 0; index < config.upstreams.length; index += 1) {
				const upstream = config.upstreams[index]
				const upstreamIndex = index + 1
				if (controller.signal.aborted) return
				const reservation = circuitBreaker.acquire(index, requestId)
				if (!reservation.allowed) {
					skipped.push({
						index: upstreamIndex,
						alias: upstream.alias,
						remainingMs: reservation.remainingMs,
					})
					continue
				}
				attemptNumber += 1
				let failureRecorded = false

				try {
					const upstreamResponse = await requestUpstream({
						upstream: upstream.url,
						target,
						method: request.method,
						headers: { ...headers, "x-router-attempt": String(attemptNumber) },
						body,
						timeoutMs: config.upstreamTimeoutMs,
						signal: controller.signal,
					})

					const statusCode = upstreamResponse.statusCode || 502
					const retryable = isRetryableStatus(statusCode, config.retryStatusCodes)
					const hasNext = index + 1 < config.upstreams.length
					attempts.push({
						attempt: attemptNumber,
						index: upstreamIndex,
						alias: upstream.alias,
						status: statusCode,
					})

					if (retryable) {
						circuitBreaker.failed(
							index,
							requestId,
							reservation,
							`HTTP_${statusCode}`,
						)
						failureRecorded = true
					}

					if (retryable && hasNext) {
						logger.warn("upstream_retry", {
							requestId,
							attempt: attemptNumber,
							index: upstreamIndex,
							alias: upstream.alias,
							upstream: upstream.url.origin,
							status: statusCode,
						})
						upstreamResponse.destroy()
						continue
					}

					const outgoingHeaders = responseHeaders(upstreamResponse.headers)
					outgoingHeaders["x-router-request-id"] = requestId
					outgoingHeaders["x-router-upstream-index"] = String(upstreamIndex)
					outgoingHeaders["x-router-upstream-alias"] = upstream.alias
					outgoingHeaders["x-router-attempts"] = String(attemptNumber)
					response.writeHead(statusCode, outgoingHeaders)

					await pipeline(upstreamResponse, response)
					if (!retryable) circuitBreaker.succeeded(index, requestId, reservation)
					logger.info("request_complete", {
						requestId,
						method: request.method,
						target,
						attempt: attemptNumber,
						index: upstreamIndex,
						alias: upstream.alias,
						status: statusCode,
						durationMs: Date.now() - startedAt,
					})
					return
				} catch (error) {
					if (controller.signal.aborted) {
						circuitBreaker.release(index, reservation)
						return
					}
					if (response.headersSent) {
						if (!failureRecorded) {
							circuitBreaker.failed(
								index,
								requestId,
								reservation,
								`STREAM_${errorCode(error)}`,
							)
						}
						logger.error("response_stream_error", {
							requestId,
							attempt: attemptNumber,
							index: upstreamIndex,
							alias: upstream.alias,
							error: errorCode(error),
						})
						response.destroy(error)
						return
					}
					if (!failureRecorded) {
						circuitBreaker.failed(index, requestId, reservation, errorCode(error))
						failureRecorded = true
					}
					attempts.push({
						attempt: attemptNumber,
						index: upstreamIndex,
						alias: upstream.alias,
						error: errorCode(error),
					})
					logger.warn("upstream_error", {
						requestId,
						attempt: attemptNumber,
						index: upstreamIndex,
						alias: upstream.alias,
						upstream: upstream.url.origin,
						error: errorCode(error),
					})
				}
			}

			if (attemptNumber === 0 && skipped.length > 0) {
				const remainingValues = skipped
					.map(({ remainingMs }) => remainingMs)
					.filter((remainingMs) => Number.isFinite(remainingMs) && remainingMs > 0)
				const retryAfterSeconds = Math.max(
					1,
					Math.ceil((remainingValues.length > 0 ? Math.min(...remainingValues) : 1000) / 1000),
				)
				logger.warn("all_upstreams_temporarily_disabled", { requestId, skipped })
				sendError(
					response,
					503,
					"all_upstreams_temporarily_disabled",
					"Todos los upstreams están temporalmente deshabilitados",
					requestId,
					{ "retry-after": String(retryAfterSeconds) },
				)
				return
			}

			logger.error("all_upstreams_failed", { requestId, attempts })
			sendError(
				response,
				502,
				"all_upstreams_failed",
				"No ha sido posible obtener respuesta de ningún upstream",
				requestId,
			)
		} catch (error) {
			if (controller.signal.aborted || response.headersSent) return
			const statusCode = error instanceof RequestError ? error.statusCode : 500
			const code = error instanceof RequestError ? error.code : "internal_router_error"
			logger.error("request_error", {
				requestId,
				error: errorCode(error),
			})
			sendError(response, statusCode, code, error.message || "Error interno del router", requestId)
		}
	})

	server.on("clientError", (error, socket) => {
		logger.warn("client_error", { error: errorCode(error) })
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
	})

	server.on("upgrade", (_request, socket) => {
		socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
	})

	return server
}
