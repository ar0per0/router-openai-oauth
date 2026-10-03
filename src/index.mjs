import { loadConfig } from "./config.mjs"
import { createLogger } from "./logger.mjs"
import { createRouterServer, validateUpstreamsAtStartup } from "./server.mjs"

let config
try {
	config = loadConfig()
} catch (error) {
	createLogger().error("invalid_configuration", { error: error.message })
	process.exit(2)
}

const logger = createLogger({ timeZone: config.timeZone })

const initialUpstreamHealth = await validateUpstreamsAtStartup(config, { logger })
const server = createRouterServer(config, { logger, initialUpstreamHealth })

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
		clientErrorFailureThreshold: config.clientErrorFailureThreshold,
		startupHealthcheckEnabled: config.startupHealthcheckEnabled,
		runtimeFailover: config.runtimeFailover,
		cooldownMs: config.upstreamCooldownMs,
		authentication: config.apiKey ? "enabled" : "disabled",
	})
	if (!config.apiKey && config.host === "0.0.0.0") {
		logger.warn("router_exposed_without_authentication", {
			message: "Configura ROUTER_API_KEY o limita el acceso mediante red/firewall",
		})
	}
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
