import http from "node:http"
import https from "node:https"
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto"
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

class UpstreamValidationError extends Error {
	constructor(code, { status, stage } = {}) {
		super(code)
		this.code = code
		this.status = status
		this.stage = stage
	}
}

const responseJson = async (response, stage) => {
	if (!response.ok) {
		await response.body?.cancel()
		throw new UpstreamValidationError(`HTTP_${response.status}`, {
			status: response.status,
			stage,
		})
	}
	try {
		return await response.json()
	} catch {
		throw new UpstreamValidationError("INVALID_JSON", { status: response.status, stage })
	}
}

const createValidationPrompt = () => {
	const first = randomInt(12, 100)
	const second = randomInt(11, 50)
	const subtract = randomInt(20, 250)
	const result = first * second - subtract
	return `Realiza esta comprobación internamente: calcula (${first} × ${second}) - ${subtract} y comprueba que el resultado sea ${result}. Si es correcto, responde única y exactamente con la palabra OK, en mayúsculas, sin comillas, explicaciones, puntuación ni espacios adicionales. Si no es correcto, responde ERROR.`
}

const checkUpstreamOnce = async (config, upstream, fetchImpl) => {
	const signal = AbortSignal.timeout(config.startupHealthcheckTimeoutMs)
	let model = config.startupHealthcheckModel
	if (!model) {
		const modelsResponse = await fetchImpl(new URL("/v1/models", upstream.url), {
			headers: { authorization: "Bearer openai-oauth" },
			redirect: "manual",
			signal,
		})
		const models = await responseJson(modelsResponse, "models")
		model = models.data
			?.map(({ id }) => id)
			.find((id) => typeof id === "string" && !/image/i.test(id))
		if (!model) throw new UpstreamValidationError("NO_MODELS", { stage: "models" })
	}

	const completionResponse = await fetchImpl(
		new URL("/v1/chat/completions", upstream.url),
		{
			method: "POST",
			headers: {
				authorization: "Bearer openai-oauth",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: createValidationPrompt() }],
				max_completion_tokens: 128,
			}),
			redirect: "manual",
			signal,
		},
	)
	const completion = await responseJson(completionResponse, "chat_completion")
	const answer = completion.choices?.[0]?.message?.content
	if (answer !== "OK") {
		throw new UpstreamValidationError("UNEXPECTED_RESPONSE", {
			status: completionResponse.status,
			stage: "chat_completion",
		})
	}
	return { model, status: completionResponse.status }
}

export const checkUpstreams = async (config, { logger = silentLogger, fetchImpl = fetch } = {}) => {
	const results = await Promise.all(
		config.upstreams.map(async (upstream, index) => {
			const startedAt = Date.now()
			let lastError
			for (let attempt = 1; attempt <= config.upstreamFailureThreshold; attempt += 1) {
				try {
					const { model, status } = await checkUpstreamOnce(config, upstream, fetchImpl)
					const result = {
						index: index + 1,
						alias: upstream.alias,
						upstream: upstream.url.origin,
						model,
						status,
						healthy: true,
						attempt,
						maxAttempts: config.upstreamFailureThreshold,
						failures: attempt - 1,
						response: "OK",
						durationMs: Date.now() - startedAt,
					}
					logger.info("upstream_healthcheck_ok", result)
					return result
				} catch (error) {
					lastError = error
				}
			}

			const result = {
				index: index + 1,
				alias: upstream.alias,
				upstream: upstream.url.origin,
				healthy: false,
				failures: config.upstreamFailureThreshold,
				error: errorCode(lastError),
				...(lastError?.status ? { status: lastError.status } : {}),
				...(lastError?.stage ? { stage: lastError.stage } : {}),
				durationMs: Date.now() - startedAt,
			}
			logger.warn("upstream_healthcheck_failed", result)
			return result
		}),
	)

	logger.info("upstream_healthcheck_complete", {
		healthy: results.filter((result) => result.healthy).length,
		total: results.length,
	})
	return results
}

export const validateUpstreamsAtStartup = async (
	config,
	{ logger = silentLogger, checker = checkUpstreams } = {},
) => {
	if (!config.startupHealthcheckEnabled) {
		logger.warn("upstream_healthcheck_skipped", {
			upstreams: config.upstreams.length,
			message: "La validación inicial está desactivada",
		})
		return []
	}

	logger.info("upstream_healthcheck_started", {
		upstreams: config.upstreams.length,
		model: config.startupHealthcheckModel || "auto",
		timeoutMs: config.startupHealthcheckTimeoutMs,
		maxAttempts: config.upstreamFailureThreshold,
	})
	return checker(config, { logger })
}

const createCircuitBreaker = (config, logger, initialUpstreamHealth = []) => {
	const initializedAt = Date.now()
	const states = config.upstreams.map((_upstream, index) => {
		const initiallyHealthy = initialUpstreamHealth[index]?.healthy !== false
		const initialFailures = initiallyHealthy
			? 0
			: Math.min(
				initialUpstreamHealth[index]?.failures || config.upstreamFailureThreshold,
				config.upstreamFailureThreshold,
			)
		const initiallyOpen = initialFailures >= config.upstreamFailureThreshold
		return {
			consecutiveFailures: initialFailures,
			consecutiveClientErrors: 0,
			openUntil: initiallyOpen ? initializedAt + config.upstreamCooldownMs : 0,
			probeInFlight: false,
			generation: initiallyOpen ? 1 : 0,
		}
	})

	const details = (index) => ({
		index: index + 1,
		alias: config.upstreams[index].alias,
		upstream: config.upstreams[index].url.origin,
	})

	for (let index = 0; index < states.length; index += 1) {
		if (initialUpstreamHealth[index]?.healthy !== false) continue
		if (states[index].openUntil > 0) {
			logger.warn("upstream_initially_disabled", {
				...details(index),
				reason: "startup_healthcheck_failed",
				failures: states[index].consecutiveFailures,
				threshold: config.upstreamFailureThreshold,
				cooldownMs: config.upstreamCooldownMs,
				disabledUntil: new Date(states[index].openUntil).toISOString(),
			})
			continue
		}
		logger.warn("upstream_initial_failure", {
			...details(index),
			reason: "startup_healthcheck_failed",
			failures: states[index].consecutiveFailures,
			threshold: config.upstreamFailureThreshold,
		})
	}

	const acquire = (index, requestId) => {
		const state = states[index]
		const now = Date.now()
		if (state.openUntil > now) {
			const remainingMs = state.openUntil - now
			return { allowed: false, remainingMs }
		}

		if (state.openUntil > 0) {
			if (state.probeInFlight) {
				return { allowed: false, remainingMs: 1000 }
			}
			state.probeInFlight = true
			logger.info("upstream_circuit_half_open", {
				requestId,
				...details(index),
			})
			return { allowed: true, recoveryProbe: true, generation: state.generation }
		}

		return { allowed: true, recoveryProbe: false, generation: state.generation }
	}

	const succeeded = (index, requestId, reservation) => {
		const state = states[index]
		if (reservation.generation !== state.generation) return
		const previousFailures = state.consecutiveFailures
		const previousClientErrors = state.consecutiveClientErrors
		const recovered = reservation.recoveryProbe || state.openUntil > 0
		state.consecutiveFailures = 0
		state.consecutiveClientErrors = 0
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
		} else if (previousClientErrors > 0) {
			logger.info("upstream_client_error_count_reset", {
				requestId,
				...details(index),
				previousClientErrors,
			})
		}
	}

	const failed = (index, requestId, reservation, reason) => {
		const state = states[index]
		if (reservation.generation !== state.generation) {
			return { ignored: true, opened: state.openUntil > Date.now() }
		}
		state.consecutiveClientErrors = 0
		if (reservation.recoveryProbe) {
			state.consecutiveFailures = config.upstreamFailureThreshold
			state.openUntil = Date.now() + config.upstreamCooldownMs
			state.probeInFlight = false
			state.generation += 1
			logger.warn("upstream_circuit_open", {
				requestId,
				...details(index),
				reason,
				failures: state.consecutiveFailures,
				cooldownMs: config.upstreamCooldownMs,
				disabledUntil: new Date(state.openUntil).toISOString(),
				reopened: true,
			})
			return {
				count: state.consecutiveFailures,
				threshold: config.upstreamFailureThreshold,
				opened: true,
			}
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
			state.generation += 1
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
		return {
			count: state.consecutiveFailures,
			threshold: config.upstreamFailureThreshold,
			opened: state.openUntil > Date.now(),
		}
	}

	const clientDisconnected = (index, requestId, reservation, reason) => {
		const state = states[index]
		if (reservation.generation !== state.generation) {
			return { ignored: true, opened: state.openUntil > Date.now() }
		}
		state.probeInFlight = false
		state.consecutiveClientErrors += 1
		logger.warn("upstream_client_error", {
			requestId,
			...details(index),
			logProgress: `${state.consecutiveClientErrors}/${config.clientErrorFailureThreshold}`,
			reason,
			clientErrors: state.consecutiveClientErrors,
			threshold: config.clientErrorFailureThreshold,
		})

		if (
			!reservation.recoveryProbe &&
			state.consecutiveClientErrors < config.clientErrorFailureThreshold
		) {
			return {
				count: state.consecutiveClientErrors,
				threshold: config.clientErrorFailureThreshold,
				opened: false,
			}
		}

		state.openUntil = Date.now() + config.upstreamCooldownMs
		state.generation += 1
		logger.warn("upstream_circuit_open", {
			requestId,
			...details(index),
			reason: "CLIENT_ERROR_THRESHOLD",
			clientErrors: state.consecutiveClientErrors,
			threshold: config.clientErrorFailureThreshold,
			cooldownMs: config.upstreamCooldownMs,
			disabledUntil: new Date(state.openUntil).toISOString(),
			reopened: reservation.recoveryProbe,
		})
		return {
			count: state.consecutiveClientErrors,
			threshold: config.clientErrorFailureThreshold,
			opened: true,
		}
	}

	const release = (index, reservation) => {
		if (
			reservation.recoveryProbe &&
			reservation.generation === states[index].generation
		) {
			states[index].probeInFlight = false
		}
	}

	const snapshot = (now = Date.now()) =>
		states.map((state, index) => {
			const remainingMs = Math.max(0, state.openUntil - now)
			const circuitState =
				state.openUntil === 0 ? "closed" : remainingMs > 0 ? "open" : "half_open"
			return {
				index: index + 1,
				alias: config.upstreams[index].alias,
				state: circuitState,
				failures: state.consecutiveFailures,
				clientErrors: state.consecutiveClientErrors,
				remainingMs,
				disabledUntil:
					circuitState === "open" ? new Date(state.openUntil).toISOString() : null,
				probeInFlight: state.probeInFlight,
			}
		})

	return { acquire, succeeded, failed, clientDisconnected, release, snapshot }
}

export const createRouterServer = (
	config,
	{ logger = silentLogger, initialUpstreamHealth = [] } = {},
) => {
	const circuitBreaker = createCircuitBreaker(config, logger, initialUpstreamHealth)
	const activeRequests = new WeakMap()
	const server = http.createServer(async (request, response) => {
		const requestId = randomUUID()
		const startedAt = Date.now()
		const requestContext = {
			requestId,
			startedAt,
			target: request.url,
			abortController: undefined,
			currentUpstream: undefined,
			currentUpstreamIndex: undefined,
			currentReservation: undefined,
			upstreamResponded: false,
			clientErrorCounted: false,
			completed: false,
			clientError: undefined,
		}
		activeRequests.set(request.socket, requestContext)
		response.once("finish", () => {
			requestContext.completed = true
		})
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

		if (
			(request.method === "GET" || request.method === "HEAD") &&
			request.url === "/router/status"
		) {
			const payload = {
				status: "ok",
				runtimeFailover: config.runtimeFailover,
				upstreams: circuitBreaker.snapshot(),
			}
			if (request.method === "HEAD") {
				response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
				response.end()
			} else {
				sendJson(response, 200, payload)
			}
			return
		}

		if (request.method === "CONNECT") {
			request.resume()
			sendError(response, 405, "method_not_allowed", "El método CONNECT no está permitido", requestId)
			return
		}

		const controller = new AbortController()
		requestContext.abortController = controller
		let clientDisconnectReason
		request.once("aborted", () => {
			clientDisconnectReason = "REQUEST_ABORTED"
			controller.abort()
		})
		response.once("close", () => {
			if (!response.writableEnded) {
				clientDisconnectReason ||= "ECONNRESET"
				controller.abort()
			}
		})

		try {
			const target = parseRequestTarget(request.url)
			requestContext.target = target
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
				let failureResult
				requestContext.currentUpstream = {
					index: upstreamIndex,
					alias: upstream.alias,
					upstream: upstream.url.origin,
					attempt: attemptNumber,
				}
				requestContext.currentUpstreamIndex = index
				requestContext.currentReservation = reservation
				requestContext.upstreamResponded = false
				requestContext.clientErrorCounted = false

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
					requestContext.upstreamResponded = true

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
						failureResult = circuitBreaker.failed(
							index,
							requestId,
							reservation,
							`HTTP_${statusCode}`,
						)
						failureRecorded = true
					}

					if (config.runtimeFailover && retryable && hasNext) {
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
						if (
							!requestContext.clientErrorCounted &&
							!response.headersSent &&
							!requestContext.upstreamResponded
						) {
							circuitBreaker.clientDisconnected(
								index,
								requestId,
								reservation,
								requestContext.clientError || clientDisconnectReason || "CLIENT_DISCONNECT",
							)
							requestContext.clientErrorCounted = true
						} else if (!requestContext.clientErrorCounted) {
							circuitBreaker.release(index, reservation)
						}
						return
					}
					const code = errorCode(error)
					if (response.headersSent) {
						if (!failureRecorded) {
							if (code === "ECONNRESET") {
								circuitBreaker.clientDisconnected(
									index,
									requestId,
									reservation,
									code,
								)
							} else {
								circuitBreaker.failed(
									index,
									requestId,
									reservation,
									`STREAM_${code}`,
								)
							}
						}
						logger.error("response_stream_error", {
							requestId,
							attempt: attemptNumber,
							index: upstreamIndex,
							alias: upstream.alias,
							error: code,
						})
						response.destroy(error)
						return
					}
					if (!failureRecorded) {
						if (code === "ECONNRESET") {
							failureResult = circuitBreaker.clientDisconnected(
								index,
								requestId,
								reservation,
								code,
							)
						} else {
							failureResult = circuitBreaker.failed(index, requestId, reservation, code)
						}
						failureRecorded = true
					}
					attempts.push({
						attempt: attemptNumber,
						index: upstreamIndex,
						alias: upstream.alias,
						error: code,
					})
					if (code !== "ECONNRESET") {
						logger.warn("upstream_error", {
							requestId,
							attempt: attemptNumber,
							index: upstreamIndex,
							alias: upstream.alias,
							upstream: upstream.url.origin,
							error: code,
						})
					} else if (failureResult?.ignored) {
						logger.info("client_error_ignored", {
							requestId,
							attempt: attemptNumber,
							index: upstreamIndex,
							alias: upstream.alias,
							upstream: upstream.url.origin,
							error: code,
							reason: "STALE_CIRCUIT_GENERATION",
						})
					}
					if (!config.runtimeFailover || code === "ECONNRESET") break
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
		const code = errorCode(error)
		const context = activeRequests.get(socket)
		const activeContext = context && !context.completed ? context : undefined
		let countedResult
		let counted = false
		if (activeContext) {
			activeContext.clientError = code
			if (
				activeContext.currentReservation &&
				Number.isInteger(activeContext.currentUpstreamIndex) &&
				!activeContext.clientErrorCounted
			) {
				activeContext.clientErrorCounted = true
				counted = true
				countedResult = circuitBreaker.clientDisconnected(
					activeContext.currentUpstreamIndex,
					activeContext.requestId,
					activeContext.currentReservation,
					code,
				)
			}
			activeContext.abortController?.abort()
		}
		if (countedResult?.ignored) {
			logger.info("client_error_ignored", {
				error: code,
				requestId: activeContext.requestId,
				target: activeContext.target,
				durationMs: Date.now() - activeContext.startedAt,
				...activeContext.currentUpstream,
				reason: "STALE_CIRCUIT_GENERATION",
			})
		} else if (
			!counted &&
			!activeContext?.clientErrorCounted &&
			(activeContext || code !== "ECONNRESET")
		) {
			logger.warn("client_error", {
				error: code,
				...(activeContext
					? {
							requestId: activeContext.requestId,
							target: activeContext.target,
							durationMs: Date.now() - activeContext.startedAt,
							...activeContext.currentUpstream,
						}
					: { activeRequest: false }),
			})
		}
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
	})

	server.on("upgrade", (_request, socket) => {
		socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
	})

	return server
}
