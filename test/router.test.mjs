import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { loadConfig, parseRetryStatusCodes, parseUpstreams } from "../src/config.mjs"
import { checkUpstreams, createRouterServer } from "../src/server.mjs"

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

const startRouter = async (upstreamUrls, overrides = {}) => {
	const config = loadConfig({
		HOST: "127.0.0.1",
		PORT: "10530",
		UPSTREAMS: upstreamUrls.join(" | "),
		UPSTREAM_TIMEOUT_MS: "1000",
		MAX_REQUEST_BODY_BYTES: "1048576",
		RETRY_STATUS_CODES: "401,403,408,429,500-599",
		ROUTER_API_KEY: "",
		...overrides,
	})
	const server = createRouterServer(config)
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
})

test("comprueba todos los upstreams al arrancar y genera un resumen", async (t) => {
	const paths = []
	const healthy = await startUpstream((request, response) => {
		paths.push(request.url)
		json(response, 200, { status: "ok" })
	})
	const unhealthy = await startUpstream((request, response) => {
		paths.push(request.url)
		json(response, 503, { status: "error" })
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

	assert.deepEqual(paths, ["/health", "/health"])
	assert.equal(results[0].healthy, true)
	assert.equal(results[0].alias, "upstream-1")
	assert.equal(results[0].status, 200)
	assert.equal(results[1].healthy, false)
	assert.equal(results[1].status, 503)
	assert.deepEqual(events.at(-1), {
		level: "info",
		event: "upstream_healthcheck_complete",
		details: { healthy: 1, total: 2 },
	})
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
	const router = await startRouter(
		[`principal=${primary.url}`, `respaldo=${backup.url}`],
		{
			UPSTREAM_FAILURE_THRESHOLD: "3",
			UPSTREAM_COOLDOWN: "100ms",
		},
	)
	t.after(async () => Promise.all([close(router.server), close(primary.server), close(backup.server)]))

	for (let count = 0; count < 3; count += 1) {
		const response = await fetch(`${router.url}/v1/models`)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get("x-router-upstream-alias"), "respaldo")
		assert.equal(response.headers.get("x-router-attempts"), "2")
	}
	assert.equal(primaryCalls, 3)

	const skipped = await fetch(`${router.url}/v1/models`)
	assert.equal(skipped.status, 200)
	assert.equal(skipped.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(skipped.headers.get("x-router-attempts"), "1")
	assert.equal(primaryCalls, 3)

	await new Promise((resolve) => setTimeout(resolve, 120))
	const failedProbe = await fetch(`${router.url}/v1/models`)
	assert.equal(failedProbe.status, 200)
	assert.equal(failedProbe.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(primaryCalls, 4)

	const skippedAgain = await fetch(`${router.url}/v1/models`)
	assert.equal(skippedAgain.headers.get("x-router-upstream-alias"), "respaldo")
	assert.equal(primaryCalls, 4)

	await new Promise((resolve) => setTimeout(resolve, 120))
	primaryStatus = 200
	const recovered = await fetch(`${router.url}/v1/models`)
	assert.equal(recovered.status, 200)
	assert.equal(recovered.headers.get("x-router-upstream-alias"), "principal")
	assert.equal(primaryCalls, 5)

	const remainsHealthy = await fetch(`${router.url}/v1/models`)
	assert.equal(remainsHealthy.headers.get("x-router-upstream-alias"), "principal")
	assert.equal(primaryCalls, 6)
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

	const unauthorized = await fetch(`${router.url}/v1/models`)
	assert.equal(unauthorized.status, 401)

	const authorized = await fetch(`${router.url}/v1/models`, {
		headers: { authorization: "Bearer clave-secreta" },
	})
	assert.equal(authorized.status, 200)
	assert.equal(upstreamAuthorization, "Bearer openai-oauth")
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
