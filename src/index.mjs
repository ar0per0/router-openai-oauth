import { loadConfig } from "./config.mjs"
import { checkUpstreams, createRouterServer } from "./server.mjs"

const writeLog = (level, event, details = {}) => {
	const timestamp = new Date().toISOString()
	const alias = details.alias
	const prefix = alias ? `[router-openai-oauth] [${alias}]` : "[router-openai-oauth]"
	console.log(`${prefix} ${level.toUpperCase()} ${timestamp} ${event} ${JSON.stringify(details)}`)
}

const logger = {
	info: (event, details) => writeLog("info", event, details),
	warn: (event, details) => writeLog("warn", event, details),
	error: (event, details) => writeLog("error", event, details),
}

let config
try {
	config = loadConfig()
} catch (error) {
	logger.error("invalid_configuration", { error: error.message })
	process.exit(2)
}

const server = createRouterServer(config, { logger })

server.on("error", (error) => {
	logger.error("server_error", { error: error.code || error.message })
	process.exitCode = 1
})

server.listen(config.port, config.host, () => {
	logger.info("server_started", {
		host: config.host,
		port: config.port,
		upstreams: config.upstreams.map((upstream) => ({
			alias: upstream.alias,
			url: upstream.url.origin,
		})),
		retryStatusCodes: config.retryStatusCodes,
		failureThreshold: config.upstreamFailureThreshold,
		cooldownMs: config.upstreamCooldownMs,
		authentication: config.apiKey ? "enabled" : "disabled",
	})
	if (!config.apiKey && config.host === "0.0.0.0") {
		logger.warn("router_exposed_without_authentication", {
			message: "Configura ROUTER_API_KEY o limita el acceso mediante red/firewall",
		})
	}
	void checkUpstreams(config, { logger }).catch((error) => {
		logger.error("upstream_healthcheck_error", { error: error.message })
	})
})

let shuttingDown = false
const shutdown = (signal) => {
	if (shuttingDown) return
	shuttingDown = true
	logger.info("shutdown_started", { signal })
	server.close((error) => {
		if (error) {
			logger.error("shutdown_error", { error: error.message })
			process.exitCode = 1
		}
	})
	const timer = setTimeout(() => {
		logger.error("shutdown_timeout", {})
		server.closeAllConnections()
	}, 10000)
	timer.unref()
}

process.once("SIGTERM", () => shutdown("SIGTERM"))
process.once("SIGINT", () => shutdown("SIGINT"))
