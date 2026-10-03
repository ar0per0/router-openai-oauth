import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { loadConfig, parseRetryStatusCodes, parseUpstreams } from "../src/config.mjs"
import { createLogger } from "../src/logger.mjs"
import {
	checkUpstreams,
	createRouterServer,
	validateUpstreamsAtStartup,
} from "../src/server.mjs"

const listen = async (server) => {
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const { port } = server.address()
	return `http://127.0.0.1:${port}`
}

const close = async (server) => {
	server.closeAllConnections?.()
	if (!server.listening) return
	await new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()))
	})
}

const startUpstream = async (handler) => {
	const server = http.createServer(handler)
	const url = await listen(server)
	return { server, url }
}

const startRouter = async (upstreamUrls, overrides = {}, routerOptions = {}) => {
	const config = loadConfig({
		HOST: "127.0.0.1",
		PORT: "10530",
		UPSTREAMS: upstreamUrls.join(" | "),
		UPSTREAM_TIMEOUT_MS: "1000",
		MAX_REQUEST_BODY_BYTES: "1048576",
		RETRY_STATUS_CODES: "401,403,408,429,500-599",
		RUNTIME_FAILOVER: "true",
		ROUTER_API_KEY: "",
		...overrides,
	})
	const server = createRouterServer(config, routerOptions)
	const url = await listen(server)
	return { server, url }
}

const readBody = async (request) => {
	const chunks = []
	for await (const chunk of request) chunks.push(chunk)
	return Buffer.concat(chunks).toString("utf8")
}

const json = (response, statusCode, payload, headers = {}) => {
	const body = JSON.stringify(payload)
	response.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		...headers,
	})
	response.end(body)
}

test("valida upstreams y reglas de estado", () => {
	assert.deepEqual(
		parseUpstreams("principal=http://127.0.0.1:10531 | https://oauth.example:443").map(
			({ alias, url }) => ({ alias, url: url.origin }),
		),
		[
			{ alias: "principal", url: "http://127.0.0.1:10531" },
			{ alias: "upstream-2", url: "https://oauth.example" },
		],
	)
	assert.throws(() => parseUpstreams("ftp://127.0.0.1:21"), /http o https/)
	assert.throws(() => parseUpstreams("http://127.0.0.1:10531/v1"), /solo esquema/)
	assert.throws(
		() => parseUpstreams("duplicado=http://127.0.0.1:10531 | duplicado=http://127.0.0.1:10532"),
		/alias duplicado/,
	)
	assert.throws(() => parseRetryStatusCodes("429,600"), /rango no válido/)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531", UPSTREAM_COOLDOWN: "10m" })
			.upstreamCooldownMs,
		600000,
	)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531", UPSTREAM_COOLDOWN: "1d" })
			.upstreamCooldownMs,
		86400000,
	)
	assert.throws(
		() => loadConfig({ UPSTREAMS: "http://127.0.0.1:10531", UPSTREAM_COOLDOWN: "valor" }),
		/5000ms, 30s, 10m, 1h o 1d/,
	)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531", TZ: "Europe/Madrid" }).timeZone,
		"Europe/Madrid",
	)
	assert.throws(
		() => loadConfig({ UPSTREAMS: "http://127.0.0.1:10531", TZ: "zona/inexistente" }),
		/TZ debe ser una zona horaria IANA válida/,
	)
	assert.equal(
		loadConfig({
			UPSTREAMS: "http://127.0.0.1:10531",
			STARTUP_HEALTHCHECK_MODEL: "gpt-5.6-luna",
		}).startupHealthcheckModel,
		"gpt-5.6-luna",
	)
	assert.throws(
		() =>
			loadConfig({
				UPSTREAMS: "http://127.0.0.1:10531",
				STARTUP_HEALTHCHECK_MODEL: "modelo no válido",
			}),
		/STARTUP_HEALTHCHECK_MODEL/,
	)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531" }).clientErrorFailureThreshold,
		5,
	)
	assert.equal(
		loadConfig({
			UPSTREAMS: "http://127.0.0.1:10531",
			CLIENT_ERROR_FAILURE_THRESHOLD: "7",
		}).clientErrorFailureThreshold,
		7,
	)
	assert.throws(
		() =>
			loadConfig({
				UPSTREAMS: "http://127.0.0.1:10531",
				CLIENT_ERROR_FAILURE_THRESHOLD: "0",
			}),
		/CLIENT_ERROR_FAILURE_THRESHOLD/,
	)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531" }).runtimeFailover,
		false,
	)
	assert.equal(
		loadConfig({
			UPSTREAMS: "http://127.0.0.1:10531",
			RUNTIME_FAILOVER: "true",
		}).runtimeFailover,
		true,
	)
	assert.throws(
		() =>
			loadConfig({
				UPSTREAMS: "http://127.0.0.1:10531",
				RUNTIME_FAILOVER: "sí",
			}),
		/RUNTIME_FAILOVER debe ser true o false/,
	)
	assert.equal(
		loadConfig({ UPSTREAMS: "http://127.0.0.1:10531" }).startupHealthcheckEnabled,
		true,
	)
	assert.equal(
		loadConfig({
			UPSTREAMS: "http://127.0.0.1:10531",
			STARTUP_HEALTHCHECK_ENABLED: "false",
		}).startupHealthcheckEnabled,
		false,
	)
	assert.throws(
		() =>
			loadConfig({
				UPSTREAMS: "http://127.0.0.1:10531",
				STARTUP_HEALTHCHECK_ENABLED: "1",
			}),
		/STARTUP_HEALTHCHECK_ENABLED debe ser true o false/,
	)
})

test("formatea los logs con la fecha local indicada por TZ", () => {
	const lines = []
	const logger = createLogger({
		timeZone: "Europe/Madrid",
		now: () => new Date("2026-10-03T06:04:21.000Z"),
		output: (line) => lines.push(line),
	})

	logger.info("request_complete", { alias: "principal", status: 200 })
	logger.warn("upstream_client_error", {
		alias: "principal",
		logProgress: "4/5",
		clientErrors: 4,
		threshold: 5,
	})

	assert.deepEqual(lines, [
		'[router-openai-oauth] [principal] INFO 2026-10-03 08:04:21 request_complete {"alias":"principal","status":200}',
		'[router-openai-oauth] [principal] [4/5] WARN 2026-10-03 08:04:21 upstream_client_error {"alias":"principal","clientErrors":4,"threshold":5}',
	])
})

test("omite completamente la validación inicial cuando está desactivada", async () => {
	const events = []
	let checkerCalls = 0
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const config = loadConfig({
		UPSTREAMS: "principal=http://127.0.0.1:10531",
		STARTUP_HEALTHCHECK_ENABLED: "false",
	})

	const results = await validateUpstreamsAtStartup(config, {
		logger,
		checker: async () => {
			checkerCalls += 1
			throw new Error("no debe ejecutarse")
		},
	})

	assert.deepEqual(results, [])
	assert.equal(checkerCalls, 0)
	assert.deepEqual(events, [
		{
			level: "warn",
			event: "upstream_healthcheck_skipped",
			details: {
				upstreams: 1,
				message: "La validación inicial está desactivada",
			},
		},
	])
})

test("comprueba todos los upstreams al arrancar y genera un resumen", async (t) => {
	const paths = []
	const healthy = await startUpstream(async (request, response) => {
		paths.push(request.url)
		if (request.url === "/v1/models") {
			json(response, 200, { data: [{ id: "gpt-image-2" }, { id: "test-model" }] })
			return
		}
		const payload = JSON.parse(await readBody(request))
		assert.equal(payload.model, "test-model")
		assert.match(payload.messages[0].content, /responde única y exactamente con la palabra OK/)
		json(response, 200, { choices: [{ message: { content: "OK" } }] })
	})
	const unhealthy = await startUpstream((request, response) => {
		paths.push(request.url)
		if (request.url === "/v1/models") {
			json(response, 200, { data: [{ id: "gpt-image-2" }, { id: "test-model" }] })
			return
		}
		json(response, 500, { error: { message: "usage limit reached" } })
	})
	t.after(async () => Promise.all([close(healthy.server), close(unhealthy.server)]))

	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const config = loadConfig({
		UPSTREAMS: `${healthy.url} | ${unhealthy.url}`,
		STARTUP_HEALTHCHECK_TIMEOUT_MS: "1000",
	})
	const results = await checkUpstreams(config, { logger })

	assert.deepEqual(paths.sort(), [
		"/v1/chat/completions",
		"/v1/chat/completions",
		"/v1/chat/completions",
		"/v1/chat/completions",
		"/v1/models",
		"/v1/models",
		"/v1/models",
		"/v1/models",
	])
	assert.equal(results[0].healthy, true)
	assert.equal(results[0].alias, "upstream-1")
	assert.equal(results[0].status, 200)
	assert.equal(results[0].model, "test-model")
	assert.equal(results[0].response, "OK")
	assert.equal(results[1].healthy, false)
	assert.equal(results[1].failures, 3)
	assert.equal(results[1].status, 500)
	assert.equal(results[1].stage, "chat_completion")
	assert.equal(events.filter(({ event }) => event === "upstream_healthcheck_attempt_failed").length, 0)
	assert.equal(
		events.filter(({ event, details }) => event === "upstream_healthcheck_ok" && details.healthy)
			.length,
		1,
	)
	assert.equal(
		events.filter(
			({ event, details }) => event === "upstream_healthcheck_failed" && !details.healthy,
		).length,
		1,
	)
	assert.deepEqual(events.at(-1), {
		level: "info",
		event: "upstream_healthcheck_complete",
		details: { healthy: 1, total: 2 },
	})
})

test("la validación inicial reintenta hasta el umbral y acepta un éxito posterior", async (t) => {
	let completionCalls = 0
	const upstream = await startUpstream((_request, response) => {
		completionCalls += 1
		if (completionCalls < 3) {
			json(response, 500, { error: { message: "fallo temporal" } })
			return
		}
		json(response, 200, { choices: [{ message: { content: "OK" } }] })
	})
	t.after(async () => close(upstream.server))

	const config = loadConfig({
		UPSTREAMS: `temporal=${upstream.url}`,
		STARTUP_HEALTHCHECK_MODEL: "test-model",
		STARTUP_HEALTHCHECK_TIMEOUT_MS: "1000",
		UPSTREAM_FAILURE_THRESHOLD: "3",
	})
	const results = await checkUpstreams(config)

	assert.equal(completionCalls, 3)
	assert.equal(results[0].healthy, true)
	assert.equal(results[0].attempt, 3)
	assert.equal(results[0].failures, 2)
})

test("una validación inicial agotada desactiva el upstream durante el cooldown", async (t) => {
	let firstCalls = 0
	const first = await startUpstream((_request, response) => {
		firstCalls += 1
		json(response, 200, { upstream: 1 })
	})
	const second = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`sin-cuota=${first.url}`, `disponible=${second.url}`],
		{ UPSTREAM_COOLDOWN: "10m" },
		{
			initialUpstreamHealth: [
				{ healthy: false, status: 500, failures: 3 },
				{ healthy: true, status: 200 },
			],
			logger,
		},
	)
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)

	assert.equal(response.status, 200)
	assert.equal(firstCalls, 0)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.equal(response.headers.get("x-router-upstream-alias"), "disponible")
	assert.deepEqual(await response.json(), { upstream: 2 })
	const disabled = events.find(({ event }) => event === "upstream_initially_disabled")
	assert.equal(disabled?.level, "warn")
	assert.deepEqual(
		{
			index: disabled?.details.index,
			alias: disabled?.details.alias,
			reason: disabled?.details.reason,
			failures: disabled?.details.failures,
			threshold: disabled?.details.threshold,
			cooldownMs: disabled?.details.cooldownMs,
		},
		{
			index: 1,
			alias: "sin-cuota",
			reason: "startup_healthcheck_failed",
			failures: 3,
			threshold: 3,
			cooldownMs: 600000,
		},
	)
	assert.match(disabled?.details.disabledUntil, /^\d{4}-\d{2}-\d{2}T/)
})

test("todos los upstreams agotados al inicio responden 503 sin volver a probarlos", async (t) => {
	let upstreamCalls = 0
	const first = await startUpstream((_request, response) => {
		upstreamCalls += 1
		json(response, 500, { upstream: 1 })
	})
	const second = await startUpstream((_request, response) => {
		upstreamCalls += 1
		json(response, 500, { upstream: 2 })
	})
	const router = await startRouter(
		[first.url, second.url],
		{ UPSTREAM_COOLDOWN: "10m" },
		{
			initialUpstreamHealth: [{ healthy: false }, { healthy: false }],
		},
	)
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	const payload = await response.json()

	assert.equal(response.status, 503)
	assert.equal(upstreamCalls, 0)
	assert.equal(response.headers.get("retry-after"), "600")
	assert.equal(payload.error.code, "all_upstreams_temporarily_disabled")
})

test("abre el circuito tras desconexiones atribuibles y usa el siguiente upstream", async (t) => {
	let firstCalls = 0
	const first = await startUpstream((_request, response) => {
		firstCalls += 1
		const timer = setTimeout(() => json(response, 200, { upstream: 1 }), 1000)
		timer.unref()
		response.once("close", () => clearTimeout(timer))
	})
	const second = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))

	let resolveCircuitOpened
	const circuitOpened = new Promise((resolve) => {
		resolveCircuitOpened = resolve
	})
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => {
			events.push({ level: "warn", event, details })
			if (event === "upstream_circuit_open" && details.reason === "CLIENT_ERROR_THRESHOLD") {
				resolveCircuitOpened()
			}
		},
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`lento=${first.url}`, `respaldo=${second.url}`],
		{
			CLIENT_ERROR_FAILURE_THRESHOLD: "2",
			UPSTREAM_COOLDOWN: "10m",
		},
		{ logger },
	)
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const abortClientRequest = () =>
		new Promise((resolve) => {
			const request = http.request(`${router.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
			})
			request.once("error", resolve)
			request.once("close", resolve)
			request.end('{"model":"test"}')
			setTimeout(() => request.destroy(), 25).unref()
		})

	await abortClientRequest()
	await abortClientRequest()
	await Promise.race([
		circuitOpened,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("No se abrió el circuito")), 1000),
		),
	])

	const response = await fetch(`${router.url}/v1/models`)

	assert.equal(response.status, 200)
	assert.equal(firstCalls, 2)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
	assert.deepEqual(await response.json(), { upstream: 2 })
	assert.deepEqual(
		events
			.filter(({ event }) => event === "upstream_client_error")
			.map(({ details }) => details.clientErrors),
		[1, 2],
	)
})

test("cuenta un ECONNRESET de clientError después de las cabeceras y cambia de upstream", async (t) => {
	let firstCalls = 0
	const first = await startUpstream((_request, response) => {
		firstCalls += 1
		response.writeHead(200, { "content-type": "text/event-stream" })
		response.write("data: esperando\n\n")
		const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 1000)
		timer.unref()
		response.once("close", () => clearTimeout(timer))
	})
	const second = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))

	let resolveCircuitOpened
	const circuitOpened = new Promise((resolve) => {
		resolveCircuitOpened = resolve
	})
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => {
			events.push({ level: "warn", event, details })
			if (event === "upstream_circuit_open" && details.reason === "CLIENT_ERROR_THRESHOLD") {
				resolveCircuitOpened()
			}
		},
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`principal=${first.url}`, `respaldo=${second.url}`],
		{
			CLIENT_ERROR_FAILURE_THRESHOLD: "1",
			UPSTREAM_COOLDOWN: "10m",
		},
		{ logger },
	)
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	let serverSocket
	router.server.once("connection", (socket) => {
		serverSocket = socket
	})
	let activeRequest
	const responseStarted = new Promise((resolve, reject) => {
		activeRequest = http.request(
			`${router.url}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
			},
			(response) => {
				response.resume()
				resolve()
			},
		)
		activeRequest.once("error", reject)
	})
	activeRequest.end('{"model":"test"}')

	await responseStarted
	activeRequest.removeAllListeners("error")
	activeRequest.on("error", () => {})
	const reset = new Error("socket hang up")
	reset.code = "ECONNRESET"
	router.server.emit("clientError", reset, serverSocket)
	await Promise.race([
		circuitOpened,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("No se abrió el circuito desde clientError")), 1000),
		),
	])

	const response = await fetch(`${router.url}/v1/models`)

	assert.equal(response.status, 200)
	assert.equal(firstCalls, 1)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
	assert.deepEqual(await response.json(), { upstream: 2 })
	assert.equal(
		events.filter(({ event }) => event === "upstream_client_error").at(-1)?.details.reason,
		"ECONNRESET",
	)
	assert.equal(events.filter(({ event }) => event === "client_error").length, 0)
})

test("identifica y omite un clientError concurrente de una generación antigua", async (t) => {
	let primaryCalls = 0
	const primary = await startUpstream((_request, response) => {
		primaryCalls += 1
		response.writeHead(200, { "content-type": "text/event-stream" })
		response.write(`data: petición-${primaryCalls}\n\n`)
	})
	const backup = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))

	let resolveCircuitOpened
	const circuitOpened = new Promise((resolve) => {
		resolveCircuitOpened = resolve
	})
	const events = []
	const logger = {
		info(event, details) {
			events.push({ level: "info", event, details })
		},
		warn(event, details) {
			events.push({ level: "warn", event, details })
			if (event === "upstream_circuit_open" && details.reason === "CLIENT_ERROR_THRESHOLD") {
				resolveCircuitOpened()
			}
		},
		error() {},
	}
	const router = await startRouter(
		[`principal=${primary.url}`, `respaldo=${backup.url}`],
		{
			CLIENT_ERROR_FAILURE_THRESHOLD: "1",
			UPSTREAM_COOLDOWN: "10m",
		},
		{ logger },
	)
	t.after(async () => Promise.all([close(router.server), close(primary.server), close(backup.server)]))

	const serverSockets = []
	router.server.on("connection", (socket) => serverSockets.push(socket))
	const beginStreamingRequest = () =>
		new Promise((resolve, reject) => {
			const request = http.request(
				`${router.url}/v1/chat/completions`,
				{
					method: "POST",
					agent: false,
					headers: { "content-type": "application/json" },
				},
				(response) => {
					response.resume()
					const ended = new Promise((resolveEnded) => {
						response.once("end", resolveEnded)
						response.once("aborted", resolveEnded)
						response.once("error", resolveEnded)
					})
					resolve({ request, ended })
				},
			)
			request.once("error", reject)
			request.end('{"model":"test"}')
		})

	const firstRequest = await beginStreamingRequest()
	const secondRequest = await beginStreamingRequest()
	assert.equal(serverSockets.length, 2)

	const reset = new Error("socket hang up")
	reset.code = "ECONNRESET"
	router.server.emit("clientError", reset, serverSockets[0])
	await circuitOpened
	firstRequest.request.on("error", () => {})
	router.server.emit("clientError", reset, serverSockets[1])
	secondRequest.request.on("error", () => {})
	await secondRequest.ended

	const response = await fetch(`${router.url}/v1/models`)

	assert.equal(response.status, 200)
	assert.equal(primaryCalls, 2)
	assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
	assert.deepEqual(await response.json(), { upstream: 2 })
	assert.equal(events.filter(({ event }) => event === "upstream_client_error").length, 1)
	assert.equal(events.filter(({ event }) => event === "client_error").length, 0)
	assert.equal(events.filter(({ event }) => event === "client_error_ignored").length, 1)
	assert.equal(
		events.find(({ event }) => event === "client_error_ignored")?.details.reason,
		"STALE_CIRCUIT_GENERATION",
	)
})

test("omite ECONNRESET sin petición activa", async (t) => {
	const upstream = await startUpstream((_request, response) => json(response, 200, { ok: true }))
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter([upstream.url], {}, { logger })
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	const reset = new Error("socket hang up")
	reset.code = "ECONNRESET"
	router.server.emit("clientError", reset, { writable: false })

	assert.equal(events.filter(({ event }) => event === "client_error").length, 0)
	assert.equal(events.filter(({ event }) => event === "upstream_client_error").length, 0)
})

test("requiere requestId distintos antes de cambiar tras ECONNRESET", async (t) => {
	let firstCalls = 0
	let secondCalls = 0
	const first = await startUpstream((request) => {
		firstCalls += 1
		request.socket.destroy()
	})
	const second = await startUpstream((_request, response) => {
		secondCalls += 1
		json(response, 200, { upstream: "second" })
	})
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`primero=${first.url}`, `segundo=${second.url}`],
		{
			UPSTREAM_FAILURE_THRESHOLD: "3",
			CLIENT_ERROR_FAILURE_THRESHOLD: "5",
			UPSTREAM_COOLDOWN: "10m",
		},
		{ logger },
	)
	t.after(async () =>
		Promise.all([
			close(router.server),
			close(first.server),
			close(second.server),
		]),
	)

	for (let count = 1; count <= 5; count += 1) {
		const response = await fetch(`${router.url}/v1/models`)
		assert.equal(response.status, 502)
		assert.equal(firstCalls, count)
		assert.equal(secondCalls, 0)
		await response.body.cancel()
	}

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-alias"), "segundo")
	assert.equal(response.headers.get("x-router-attempts"), "1")
	assert.deepEqual(await response.json(), { upstream: "second" })

	const opened = events.filter(
		({ event, details }) =>
			event === "upstream_circuit_open" && details.reason === "CLIENT_ERROR_THRESHOLD",
	)
	assert.deepEqual(
		opened.map(({ details }) => [details.alias, details.clientErrors, details.threshold]),
		[["primero", 5, 5]],
	)

	assert.equal(firstCalls, 5)
	assert.equal(secondCalls, 1)
	const resetEvents = events.filter(
		({ event, details }) =>
			event === "upstream_client_error" && details.alias === "primero",
	)
	assert.deepEqual(
		resetEvents.map(({ details }) => details.logProgress),
		["1/5", "2/5", "3/5", "4/5", "5/5"],
	)
	assert.equal(new Set(resetEvents.map(({ details }) => details.requestId)).size, 5)
	assert.notEqual(
		response.headers.get("x-router-request-id"),
		resetEvents.at(-1).details.requestId,
	)
})

test("usa el primer upstream y no llama al segundo cuando responde correctamente", async (t) => {
	let secondCalls = 0
	const first = await startUpstream(async (request, response) => {
		const body = await readBody(request)
		json(response, 200, { upstream: 1, body })
	})
	const second = await startUpstream((_request, response) => {
		secondCalls += 1
		json(response, 200, { upstream: 2 })
	})
	const router = await startRouter([`primario=${first.url}`, `respaldo=${second.url}`])
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/chat/completions?source=test`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "test" }),
	})

	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-index"), "1")
	assert.equal(response.headers.get("x-router-upstream-alias"), "primario")
	assert.equal(response.headers.get("x-router-attempts"), "1")
	assert.equal(secondCalls, 0)
	assert.deepEqual(await response.json(), { upstream: 1, body: '{"model":"test"}' })
})

test("reenvía sin alterar mensajes multimodales con imágenes data:base64", async (t) => {
	let receivedBody
	const upstream = await startUpstream(async (request, response) => {
		receivedBody = await readBody(request)
		json(response, 200, { ok: true })
	})
	const router = await startRouter([`multimodal=${upstream.url}`])
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
	const payload = JSON.stringify({
		model: "test",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe la imagen" },
					{ type: "image_url", image_url: { url: image } },
				],
			},
		],
	})
	const response = await fetch(`${router.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: payload,
	})

	assert.equal(response.status, 200)
	assert.equal(receivedBody, payload)
	assert.equal(JSON.parse(receivedBody).messages[0].content[1].image_url.url, image)
})

test("reenvía el mismo cuerpo al segundo upstream después de un 500", async (t) => {
	const received = {}
	const first = await startUpstream(async (request, response) => {
		received.firstBody = await readBody(request)
		json(response, 500, { error: "fallo primario" })
	})
	const second = await startUpstream(async (request, response) => {
		received.secondBody = await readBody(request)
		received.attempt = request.headers["x-router-attempt"]
		json(response, 200, { upstream: 2 })
	})
	const router = await startRouter([`primario=${first.url}`, `respaldo=${second.url}`])
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const payload = JSON.stringify({ messages: [{ role: "user", content: "hola" }] })
	const response = await fetch(`${router.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: payload,
	})

	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(response.headers.get("x-router-attempts"), "2")
	assert.equal(received.firstBody, payload)
	assert.equal(received.secondBody, payload)
	assert.equal(received.attempt, "2")
})

test("con RUNTIME_FAILOVER desactivado devuelve el error sin probar el siguiente", async (t) => {
	let secondCalls = 0
	const first = await startUpstream((_request, response) =>
		json(response, 500, { error: "fallo observado" }),
	)
	const second = await startUpstream((_request, response) => {
		secondCalls += 1
		json(response, 200, { upstream: 2 })
	})
	const router = await startRouter(
		[`primario=${first.url}`, `respaldo=${second.url}`],
		{ RUNTIME_FAILOVER: "false" },
	)
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)

	assert.equal(response.status, 500)
	assert.equal(response.headers.get("x-router-upstream-alias"), "primario")
	assert.equal(response.headers.get("x-router-attempts"), "1")
	assert.equal(secondCalls, 0)
	assert.deepEqual(await response.json(), { error: "fallo observado" })
})

test("con RUNTIME_FAILOVER desactivado un error de red tampoco prueba el siguiente", async (t) => {
	const unavailable = http.createServer()
	const unavailableUrl = await listen(unavailable)
	await close(unavailable)
	let secondCalls = 0
	const second = await startUpstream((_request, response) => {
		secondCalls += 1
		json(response, 200, { upstream: 2 })
	})
	const router = await startRouter(
		[`primario=${unavailableUrl}`, `respaldo=${second.url}`],
		{ RUNTIME_FAILOVER: "false" },
	)
	t.after(async () => Promise.all([close(router.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	const payload = await response.json()

	assert.equal(response.status, 502)
	assert.equal(payload.error.code, "all_upstreams_failed")
	assert.equal(secondCalls, 0)
})

test("devuelve un 400 sin probar el siguiente upstream", async (t) => {
	let secondCalls = 0
	const first = await startUpstream((_request, response) =>
		json(response, 400, { error: "petición inválida" }),
	)
	const second = await startUpstream((_request, response) => {
		secondCalls += 1
		json(response, 200, { upstream: 2 })
	})
	const router = await startRouter([first.url, second.url])
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 400)
	assert.equal(response.headers.get("x-router-upstream-index"), "1")
	assert.equal(secondCalls, 0)
	assert.deepEqual(await response.json(), { error: "petición inválida" })
})

test("prueba el siguiente upstream ante un 401 de la instancia OAuth", async (t) => {
	const first = await startUpstream((_request, response) =>
		json(response, 401, { error: "credenciales OAuth caducadas" }),
	)
	const second = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))
	const router = await startRouter([first.url, second.url])
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.deepEqual(await response.json(), { upstream: 2 })
})

test("respeta el orden con tres upstreams y distintos tipos de error", async (t) => {
	const unavailable = http.createServer()
	const unavailableUrl = await listen(unavailable)
	await close(unavailable)

	const second = await startUpstream((_request, response) => json(response, 500, { upstream: 2 }))
	const third = await startUpstream((_request, response) => json(response, 200, { upstream: 3 }))
	const router = await startRouter([unavailableUrl, second.url, third.url])
	t.after(async () =>
		Promise.all([close(router.server), close(second.server), close(third.server)]),
	)

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-index"), "3")
	assert.equal(response.headers.get("x-router-attempts"), "3")
	assert.deepEqual(await response.json(), { upstream: 3 })
})

test("salta al segundo upstream al superar el timeout", async (t) => {
	const first = await startUpstream(() => {})
	const second = await startUpstream((_request, response) => json(response, 200, { upstream: 2 }))
	const router = await startRouter([first.url, second.url], { UPSTREAM_TIMEOUT_MS: "50" })
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
})

test("devuelve la respuesta del último upstream si todos responden con error", async (t) => {
	const first = await startUpstream((_request, response) => json(response, 500, { upstream: 1 }))
	const second = await startUpstream((_request, response) => json(response, 503, { upstream: 2 }))
	const router = await startRouter([first.url, second.url])
	t.after(async () => Promise.all([close(router.server), close(first.server), close(second.server)]))

	const response = await fetch(`${router.url}/v1/models`)
	assert.equal(response.status, 503)
	assert.equal(response.headers.get("x-router-upstream-index"), "2")
	assert.deepEqual(await response.json(), { upstream: 2 })
})

test("abre el circuito tras tres errores, omite el upstream y lo prueba después del periodo", async (t) => {
	let primaryCalls = 0
	let primaryStatus = 500
	const primary = await startUpstream((_request, response) => {
		primaryCalls += 1
		json(response, primaryStatus, { upstream: "primary", status: primaryStatus })
	})
	const backup = await startUpstream((_request, response) =>
		json(response, 200, { upstream: "backup" }),
	)
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`principal=${primary.url}`, `respaldo=${backup.url}`],
		{
			UPSTREAM_FAILURE_THRESHOLD: "3",
			UPSTREAM_COOLDOWN: "100ms",
		},
		{ logger },
	)
	t.after(async () => Promise.all([close(router.server), close(primary.server), close(backup.server)]))

	for (let count = 0; count < 3; count += 1) {
		const response = await fetch(`${router.url}/v1/models`)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
		assert.equal(response.headers.get("x-router-attempts"), "2")
	}
	assert.equal(primaryCalls, 3)
	const openStatus = await fetch(`${router.url}/router/status`).then((response) => response.json())
	assert.equal(openStatus.upstreams[0].state, "open")
	assert.ok(openStatus.upstreams[0].remainingMs > 0)

	const skipped = await fetch(`${router.url}/v1/models`)
	assert.equal(skipped.status, 200)
	assert.equal(skipped.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(skipped.headers.get("x-router-attempts"), "1")
	assert.equal(primaryCalls, 3)

	await new Promise((resolve) => setTimeout(resolve, 120))
	const firstHalfOpenStatus = await fetch(`${router.url}/router/status`).then((response) =>
		response.json(),
	)
	assert.equal(firstHalfOpenStatus.upstreams[0].state, "half_open")
	const failedProbe = await fetch(`${router.url}/v1/models`)
	assert.equal(failedProbe.status, 200)
	assert.equal(failedProbe.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(primaryCalls, 4)
	const reopenedStatus = await fetch(`${router.url}/router/status`).then((response) =>
		response.json(),
	)
	assert.equal(reopenedStatus.upstreams[0].state, "open")

	const skippedAgain = await fetch(`${router.url}/v1/models`)
	assert.equal(skippedAgain.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(primaryCalls, 4)

	await new Promise((resolve) => setTimeout(resolve, 120))
	const secondHalfOpenStatus = await fetch(`${router.url}/router/status`).then((response) =>
		response.json(),
	)
	assert.equal(secondHalfOpenStatus.upstreams[0].state, "half_open")
	primaryStatus = 200
	const recovered = await fetch(`${router.url}/v1/models`)
	assert.equal(recovered.status, 200)
	assert.equal(recovered.headers.get("x-router-upstream-alias"), "principal")
	assert.equal(primaryCalls, 5)
	const closedStatus = await fetch(`${router.url}/router/status`).then((response) => response.json())
	assert.deepEqual(closedStatus.upstreams[0], {
		index: 1,
		alias: "principal",
		state: "closed",
		failures: 0,
		clientErrors: 0,
		remainingMs: 0,
		disabledUntil: null,
		probeInFlight: false,
	})

	const remainsHealthy = await fetch(`${router.url}/v1/models`)
	assert.equal(remainsHealthy.headers.get("x-router-upstream-alias"), "principal")
	assert.equal(primaryCalls, 6)
	assert.equal(events.filter(({ event }) => event === "upstream_circuit_half_open").length, 2)
	assert.equal(events.filter(({ event }) => event === "upstream_circuit_closed").length, 1)
	assert.equal(
		events.filter(
			({ event, details }) => event === "upstream_circuit_open" && details.reopened === true,
		).length,
		1,
	)
})

test("permite una sola sonda simultánea durante half-open", async (t) => {
	let primaryCalls = 0
	let mode = "fail"
	let finishProbe
	let resolveProbeStarted
	const probeStarted = new Promise((resolve) => {
		resolveProbeStarted = resolve
	})
	const primary = await startUpstream((_request, response) => {
		primaryCalls += 1
		if (mode === "fail") {
			json(response, 500, { upstream: "primary" })
			return
		}
		resolveProbeStarted()
		finishProbe = () => json(response, 200, { upstream: "primary" })
	})
	const backup = await startUpstream((_request, response) =>
		json(response, 200, { upstream: "backup" }),
	)
	const events = []
	const logger = {
		info: (event, details) => events.push({ level: "info", event, details }),
		warn: (event, details) => events.push({ level: "warn", event, details }),
		error: (event, details) => events.push({ level: "error", event, details }),
	}
	const router = await startRouter(
		[`principal=${primary.url}`, `respaldo=${backup.url}`],
		{
			UPSTREAM_FAILURE_THRESHOLD: "1",
			UPSTREAM_COOLDOWN: "100ms",
		},
		{ logger },
	)
	t.after(async () => {
		finishProbe?.()
		await Promise.all([close(router.server), close(primary.server), close(backup.server)])
	})

	const initial = await fetch(`${router.url}/v1/models`)
	assert.equal(initial.status, 200)
	assert.equal(initial.headers.get("x-router-upstream-alias"), "respaldo")
	await new Promise((resolve) => setTimeout(resolve, 120))

	mode = "probe"
	const probeResponsePromise = fetch(`${router.url}/v1/models`)
	await probeStarted
	const concurrent = await fetch(`${router.url}/v1/models`)
	assert.equal(concurrent.status, 200)
	assert.equal(concurrent.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(primaryCalls, 2)

	finishProbe()
	finishProbe = undefined
	const probeResponse = await probeResponsePromise
	assert.equal(probeResponse.status, 200)
	assert.equal(probeResponse.headers.get("x-router-upstream-alias"), "principal")
	assert.equal(events.filter(({ event }) => event === "upstream_circuit_half_open").length, 1)
	assert.equal(events.filter(({ event }) => event === "upstream_circuit_closed").length, 1)
})

test("responde 503 con Retry-After cuando todos los circuitos están abiertos", async (t) => {
	let calls = 0
	const upstream = await startUpstream((_request, response) => {
		calls += 1
		json(response, 500, { error: "no disponible" })
	})
	const router = await startRouter([`unico=${upstream.url}`], {
		UPSTREAM_FAILURE_THRESHOLD: "2",
		UPSTREAM_COOLDOWN: "1s",
	})
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	assert.equal((await fetch(`${router.url}/v1/models`)).status, 500)
	assert.equal((await fetch(`${router.url}/v1/models`)).status, 500)
	const unavailable = await fetch(`${router.url}/v1/models`)
	assert.equal(unavailable.status, 503)
	assert.equal(unavailable.headers.get("retry-after"), "1")
	assert.equal((await unavailable.json()).error.code, "all_upstreams_temporarily_disabled")
	assert.equal(calls, 2)
})

test("protege las rutas proxificadas y no reenvía la clave del router", async (t) => {
	let upstreamAuthorization
	const upstream = await startUpstream((request, response) => {
		upstreamAuthorization = request.headers.authorization
		json(response, 200, { ok: true })
	})
	const router = await startRouter([upstream.url], { ROUTER_API_KEY: "clave-secreta" })
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	const health = await fetch(`${router.url}/health`)
	assert.equal(health.status, 200)
	const unauthorizedStatus = await fetch(`${router.url}/router/status`)
	assert.equal(unauthorizedStatus.status, 401)

	const unauthorized = await fetch(`${router.url}/v1/models`)
	assert.equal(unauthorized.status, 401)

	const authorized = await fetch(`${router.url}/v1/models`, {
		headers: { authorization: "Bearer clave-secreta" },
	})
	assert.equal(authorized.status, 200)
	assert.equal(upstreamAuthorization, "Bearer openai-oauth")

	const status = await fetch(`${router.url}/router/status`, {
		headers: { authorization: "Bearer clave-secreta" },
	})
	assert.equal(status.status, 200)
	const statusPayload = await status.json()
	assert.equal(statusPayload.status, "ok")
	assert.equal(statusPayload.runtimeFailover, true)
	assert.equal(statusPayload.upstreams[0].alias, "upstream-1")
	assert.equal(statusPayload.upstreams[0].state, "closed")
	assert.equal("upstream" in statusPayload.upstreams[0], false)
})

test("rechaza cuerpos superiores al límite antes de llamar al upstream", async (t) => {
	let upstreamCalls = 0
	const upstream = await startUpstream((_request, response) => {
		upstreamCalls += 1
		json(response, 200, { ok: true })
	})
	const router = await startRouter([upstream.url], { MAX_REQUEST_BODY_BYTES: "4" })
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	const response = await fetch(`${router.url}/v1/chat/completions`, {
		method: "POST",
		body: "12345",
	})
	assert.equal(response.status, 413)
	assert.equal(upstreamCalls, 0)
	assert.equal((await response.json()).error.code, "request_body_too_large")
})

test("impide que una URL absoluta del cliente cambie el destino configurado", async (t) => {
	let upstreamCalls = 0
	const upstream = await startUpstream((_request, response) => {
		upstreamCalls += 1
		json(response, 200, { ok: true })
	})
	const router = await startRouter([upstream.url])
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))
	const routerUrl = new URL(router.url)

	const response = await new Promise((resolve, reject) => {
		const outgoing = http.request(
			{
				host: routerUrl.hostname,
				port: routerUrl.port,
				path: "http://example.invalid/v1/models",
				method: "GET",
			},
			resolve,
		)
		outgoing.once("error", reject)
		outgoing.end()
	})

	assert.equal(response.statusCode, 400)
	assert.equal(upstreamCalls, 0)
	assert.equal(JSON.parse(await readBody(response)).error.code, "invalid_request_target")
})

test("transmite respuestas por fragmentos sin alterar su contenido", async (t) => {
	const upstream = await startUpstream((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" })
		response.write("data: uno\n\n")
		setTimeout(() => response.end("data: [DONE]\n\n"), 20)
	})
	const router = await startRouter([upstream.url])
	t.after(async () => Promise.all([close(router.server), close(upstream.server)]))

	const response = await fetch(`${router.url}/v1/chat/completions`)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("content-type"), "text/event-stream")
	assert.equal(await response.text(), "data: uno\n\ndata: [DONE]\n\n")
})
