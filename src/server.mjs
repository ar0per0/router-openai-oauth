import { createPricingReader } from "./pricing-catalog.mjs"
import http from "node:http"
import { AsyncLocalStorage } from "node:async_hooks"
import { formatClientAddress } from "./client-address.mjs"
import https from "node:https"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { pipeline } from "node:stream/promises"
import { isRetryableStatus } from "./config.mjs"
import { readFileSync } from "node:fs"
import { createQuotaReader, quotaBlockedUntil, quotaAvailable } from "./observability.mjs"

import { createUsageObserver } from "./usage.mjs"
import { parseSummaryQuery } from './usage-summary.mjs'
import { parseUsageQuery } from "./usage-store.mjs"

const panelAssets = new Map([
 ["/router/", ["index.html", "text/html; charset=utf-8"]],
 ["/router/pricing.js", ["pricing.js", "text/javascript; charset=utf-8"]],
 ["/router/usage-chart.js", ["usage-chart.js", "text/javascript; charset=utf-8"]],
 ["/router/app.js", ["app.js", "text/javascript; charset=utf-8"]],
 ["/router/style.css", ["style.css", "text/css; charset=utf-8"]],
])
const panelHeaders = {
 "cache-control": "no-store",
 "x-content-type-options": "nosniff",
 "referrer-policy": "no-referrer",
 "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
}
const validPanelOrigin = (request) => {
 if (request.headers['sec-fetch-site'] === 'cross-site') return false
 if (!request.headers.origin) return true
 try {
  const origin = new URL(request.headers.origin)
  return origin.origin === `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`
 } catch { return false }
}

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
		// Assign path/query without resolving target as a new authority.
		const targetUrl = new URL(upstream)
		const queryIndex = target.indexOf("?")
		targetUrl.pathname = queryIndex < 0 ? target : target.slice(0, queryIndex)
		targetUrl.search = queryIndex < 0 ? "" : target.slice(queryIndex)
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

export const createCircuitBreaker = (config, logger, quotaSnapshot = () => null) => {
	// No startup probes: eligibility starts closed, not as a claim of OAuth health.
	const states = config.upstreams.map(() => ({
		consecutiveFailures: 0,
		consecutiveClientErrors: 0,
		openUntil: 0,
		probeInFlight: false,
		probeReservation: null,
		quotaUntil: 0,
		quotaRecovery: false,
		generation: 0,
	}))

	const details = (index) => ({
		index: index + 1,
		alias: config.upstreams[index].alias,
		upstream: config.upstreams[index].url.origin,
	})

 // Pure effective quota view shared by readonly snapshots and routing boundaries.
 // Positive evidence never clears generic recovery or detaches an active probe.
 const effectiveQuota = (index, now) => {
  const state = states[index], account = quotaSnapshot()?.accounts[index]
  const until = quotaBlockedUntil(account, now)
  if (until > now) return { until, recovery: true }
  if (quotaAvailable(account) && !state.probeInFlight) return { until: 0, recovery: false }
  return { until: state.quotaUntil, recovery: state.quotaRecovery }
 }
 const syncQuota = (index) => {
  const state = states[index], now = Date.now()
  const quota = effectiveQuota(index, now)
  if (quota.until === state.quotaUntil && quota.recovery === state.quotaRecovery) return
  const blocking = quota.until > now
  state.quotaUntil = quota.until
  state.quotaRecovery = quota.recovery
  // New blocks invalidate all prior completions. Quota-only release invalidates
  // old traffic; generic recovery keeps its reservation and counters untouched.
  if (blocking || state.openUntil === 0) {
   state.generation += 1
  }
  logger[blocking ? 'warn' : 'info'](blocking ? 'upstream_quota_blocked' : 'upstream_quota_released', {
   ...details(index), ...(blocking ? { disabledUntil: new Date(quota.until).toISOString() } : {}),
  })
 }

	const acquire = (index, requestId) => {
		syncQuota(index)
		const state = states[index]
		const now = Date.now()
		const blockedUntil = Math.max(state.openUntil, state.quotaUntil)
		if (blockedUntil > now) {
			const remainingMs = blockedUntil - now
			return { allowed: false, remainingMs }
		}

		if (state.openUntil > 0 || state.quotaRecovery) {
			if (state.probeInFlight) {
				return { allowed: false, remainingMs: 1000 }
			}
			state.probeInFlight = true
			logger.info("upstream_circuit_half_open", {
				requestId,
				...details(index),
			})
			const reservation = { allowed: true, recoveryProbe: true, generation: state.generation }
			state.probeReservation = reservation
			return reservation
		}

		return { allowed: true, recoveryProbe: false, generation: state.generation }
	}

 const finishProbe = (state, reservation) => {
  if (state.probeReservation !== reservation) return
  state.probeReservation = null
  state.probeInFlight = false
 }

	const succeeded = (index, requestId, reservation) => {
		syncQuota(index)
		const state = states[index]
		finishProbe(state, reservation)
		if (reservation.generation !== state.generation) return
		const previousFailures = state.consecutiveFailures
		const previousClientErrors = state.consecutiveClientErrors
		const recovered = reservation.recoveryProbe || state.openUntil > 0
		state.consecutiveFailures = 0
		state.consecutiveClientErrors = 0
		state.openUntil = 0
		state.quotaUntil = 0
		state.quotaRecovery = false
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
		finishProbe(state, reservation)
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
		finishProbe(state, reservation)
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

	const release = (index, reservation) => finishProbe(states[index], reservation)

	const snapshot = (now = Date.now()) =>
		states.map((state, index) => {
			const quota = effectiveQuota(index, now)
			const until = Math.max(state.openUntil, quota.until)
			const remainingMs = Math.max(0, until - now)
			const circuitState = remainingMs > 0 ? "open" :
				state.openUntil > 0 || quota.recovery ? "half_open" : "closed"
			return {
				index: index + 1,
				alias: config.upstreams[index].alias,
				state: circuitState,
				recoveryOrigin: circuitState === "closed" ? null :
					state.openUntil > 0 && quota.recovery ? "generic_and_quota" :
					state.openUntil > 0 ? "generic" : "quota",
				failures: state.consecutiveFailures,
				clientErrors: state.consecutiveClientErrors,
				remainingMs,
				disabledUntil:
					circuitState === "open" ? new Date(until).toISOString() : null,
				probeInFlight: state.probeInFlight,
			}
		})

	return { acquire, succeeded, failed, clientDisconnected, release, snapshot }
}

export const createRouterServer = (
	config,
	{ logger = silentLogger, logHub, usageStore, quotaFetchImpl = fetch, pricingFetchImpl = fetch } = {},
) => {
	// Async-local correlation retains the captured peer across awaits, streaming and
	// breaker callbacks without a request-ID registry or additional log events.
	const logContext = new AsyncLocalStorage()
	const baseLogger = logger
	logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (event, details = {}) => {
		const context = logContext.getStore()
		baseLogger[level](event, context && details.requestId === context.requestId
			? { ...details, clientAddress: context.clientAddress } : details)
	}]))
	const readPricing = createPricingReader({ fetchImpl: pricingFetchImpl })
	const readQuotas = createQuotaReader(config, { fetchImpl: quotaFetchImpl })
	const circuitBreaker = createCircuitBreaker(config, logger, readQuotas.peek)
	const activeRequests = new WeakMap()
	const server = http.createServer(async (request, response) => {
		const requestId = randomUUID()
		const startedAt = Date.now()
		const requestContext = {
			clientAddress: formatClientAddress(request.socket.remoteAddress, request.socket.remotePort),
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
		return logContext.run(requestContext, async () => {
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

		// Public static shell only: no credentials or account data are embedded.
  const asset = panelAssets.get(request.url === "/router" ? "/router/" : request.url)
  if (asset && request.method === 'GET') {
   response.writeHead(200, { ...panelHeaders, 'content-type': asset[1] })
   response.end(readFileSync(new URL(`./web/${asset[0]}`, import.meta.url)))
   return
  }
  if (request.url?.split('?')[0].startsWith('/router/')) {
   Object.entries(panelHeaders).forEach(([key, value]) => response.setHeader(key, value))
   if (!validPanelOrigin(request)) {
    request.resume(); sendError(response, 403, 'invalid_origin', 'Origin no permitido', requestId); return
   }
  }
		if (!request.url?.split("?")[0].startsWith("/router/") && !isAuthorized(request, config.apiKey)) {
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

  if (request.url?.split('?')[0] === '/router/accounts/rate-limits' && request.method === 'GET') {
   const params = new URL(request.url, 'http://router.invalid').searchParams
   if ([...params.keys()].some((key) => key !== 'refresh') || (params.has('refresh') && params.get('refresh') !== '1')) {
    sendError(response, 400, 'invalid_query', 'Solo se permite refresh=1', requestId); return
   }
   const result = await readQuotas({ refresh: params.get('refresh') === '1' })
   const circuits = circuitBreaker.snapshot()
   sendJson(response, 200, { ...result, accounts: result.accounts.map((account, index) => ({ ...account, circuit: circuits[index] })) })
   return
  }
  if (request.url?.split('?')[0] === '/router/pricing' && request.method === 'GET') {
   if (new URL(request.url, 'http://router.invalid').search) {
    sendError(response,400,'invalid_query','No se permiten parámetros',requestId); return
   }
   sendJson(response,200,await readPricing()); return
  }
  if (request.url?.split('?')[0] === '/router/usage/summary' && request.method === 'GET') {
   let query
   try { query = parseSummaryQuery(new URL(request.url, 'http://router.invalid').searchParams) }
   catch { sendError(response,400,'invalid_query','Fechas YYYY-MM-DD inclusivas, máximo 31 días; account alias opcional',requestId); return }
   try { if (!usageStore) throw Error(); sendJson(response,200,{ ...await usageStore.summary(query), storage:usageStore.health() }) }
   catch { sendError(response,503,'usage_unavailable','Almacenamiento no disponible',requestId) }
   return
  }
  if (request.url?.split('?')[0] === '/router/usage' && request.method === 'GET') {
   let query
   try { query = parseUsageQuery(new URL(request.url, 'http://router.invalid').searchParams) }
   catch { sendError(response,400,'invalid_query','Rango UTC requerido (máximo 31 días), limit 1..500 y cursor entero',requestId); return }
   try { if (!usageStore) throw Error(); sendJson(response,200,{ ...await usageStore.query(query), storage:usageStore.health() }) }
   catch { sendError(response,503,'usage_unavailable','Almacenamiento no disponible',requestId) }
   return
  }
  if (request.url === '/router/logs' && request.method === 'GET') {
   if (!logHub) { sendError(response, 503, 'logs_unavailable', 'Visor no disponible', requestId); return }
   logHub.connect(response, request.headers['last-event-id']); return
  }
  if (request.url?.split('?')[0].startsWith('/router/')) {
   request.resume(); sendError(response, 404, 'router_route_not_found', 'Ruta no disponible', requestId); return
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
			// Same cached/in-flight source as the panel, independent of UI visits.
			await readQuotas()
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

                const endpoint = target.split('?')[0]
                const observed = request.method === 'POST' && ['/v1/responses','/v1/chat/completions'].includes(endpoint)
                let upstreamStreamError
                let observer, terminal = false, outcome = 'transport_error', usageHttpStatus = null
                const finalizeUsage = () => {
                 if (terminal || !observed) return
                 terminal = true
                 const record = { schemaVersion:1, timestamp:new Date().toISOString(), requestId,
                  attempt:attemptNumber, index:upstreamIndex, alias:upstream.alias, endpoint, method:request.method,
                  outcome, status:usageHttpStatus, durationMs:Date.now()-startedAt,
                  ...(observer?.snapshot() ?? { inputTokens:null,outputTokens:null,totalTokens:null,cachedTokens:null,reasoningTokens:null,usageStatus:'unknown',provenance:'none',modelStatus:'unknown' }) }
                 // Accounting is independent of console/SSE logging. Capture duration
                 // once and persist before any logger callback can fail or filter it.
                 try { usageStore?.write(record) } catch { logger.warn('usage_storage_error',{}) }
                 logger.info('usage_attempt',record)
                }
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
                    upstreamResponse.once("error", error => { if (!controller.signal.aborted && error.code !== "ABORT_ERR") upstreamStreamError = error })

					const statusCode = upstreamResponse.statusCode || 502
					usageHttpStatus = statusCode
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
						outcome = "discarded"
                        upstreamResponse.destroy()
						continue
					}

					const outgoingHeaders = responseHeaders(upstreamResponse.headers)
					outgoingHeaders["x-router-request-id"] = requestId
					outgoingHeaders["x-router-upstream-index"] = String(upstreamIndex)
					outgoingHeaders["x-router-upstream-alias"] = upstream.alias
					outgoingHeaders["x-router-attempts"] = String(attemptNumber)
					response.writeHead(statusCode, outgoingHeaders)

					if (observed) { try { observer = createUsageObserver(endpoint,upstreamResponse.headers) } catch { /* Observation must not break forwarding. */ } }
                    if (observer) await pipeline(upstreamResponse,observer.stream,response)
                    else await pipeline(upstreamResponse,response)
                    outcome = statusCode >= 400 ? "http_error" : "complete"
					if (!retryable) circuitBreaker.succeeded(index, requestId, reservation)
					// Observed attempts have one merged terminal in finally, including
					// method and usage. Keep legacy completion for other endpoints.
					if (!observed) logger.info("request_complete", {
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
                    outcome = controller.signal.aborted || response.headersSent ? "interrupted" : "transport_error"
					if (controller.signal.aborted && !upstreamStreamError) {
						if (
							!requestContext.clientErrorCounted &&
							!response.headersSent &&
							!requestContext.upstreamResponded &&
                            (requestContext.clientError || clientDisconnectReason) === "ECONNRESET"
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
					const code = errorCode(upstreamStreamError || error)
					if (response.headersSent) {
						if (!failureRecorded && !requestContext.clientErrorCounted) {
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
						if (code !== "ECONNRESET") logger.error("response_stream_error", {
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
				} finally { finalizeUsage() }
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
	})

	server.on("clientError", (error, socket) => {
		const code = errorCode(error)
		const context = activeRequests.get(socket)
		const activeContext = context && !context.completed ? context : undefined
		logContext.run(activeContext, () => {
		let countedResult
		let counted = false
		if (activeContext) {
			activeContext.clientError = code
			if (
				code === "ECONNRESET" &&
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
	})

	server.on("upgrade", (_request, socket) => {
		socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
	})

	return server
}
