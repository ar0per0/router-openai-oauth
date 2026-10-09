import { resolve } from "node:path"

const parseInteger = (name, value, { minimum, maximum }) => {
	if (!/^[0-9]+$/.test(String(value))) {
		throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`)
	}
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`)
	}
	return parsed
}

const parseDuration = (name, value, { minimum, maximum }) => {
	const match = /^(\d+)(ms|s|m|h|d)?$/.exec(String(value))
	if (!match) {
		throw new Error(`${name} debe usar un valor como 5000ms, 30s, 10m, 1h o 1d`)
	}
	const factors = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
	const milliseconds = Number(match[1]) * factors[match[2] || "ms"]
	if (!Number.isSafeInteger(milliseconds) || milliseconds < minimum || milliseconds > maximum) {
		throw new Error(`${name} debe estar entre ${minimum} y ${maximum} milisegundos`)
	}
	return milliseconds
}

const parseTimeZone = (value) => {
	const timeZone = String(value || "")
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone }).format()
	} catch {
		throw new Error("TZ debe ser una zona horaria IANA válida, como Europe/Madrid")
	}
	return timeZone
}

const parseBoolean = (name, value) => {
	const normalized = String(value).trim().toLowerCase()
	if (normalized === "true") return true
	if (normalized === "false") return false
	throw new Error(`${name} debe ser true o false`)
}

export const parseUpstreams = (value) => {
	const entries = String(value || "")
		.split("|")
		.map((entry) => entry.trim())
		.filter(Boolean)

	if (entries.length === 0) {
		throw new Error("UPSTREAMS debe contener al menos una URL")
	}

	const upstreams = entries.map((entry, index) => {
		const separatorIndex = entry.indexOf("=")
		const alias = separatorIndex === -1 ? `upstream-${index + 1}` : entry.slice(0, separatorIndex).trim()
		const urlValue = separatorIndex === -1 ? entry : entry.slice(separatorIndex + 1).trim()
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias)) {
			throw new Error(
				`UPSTREAMS[${index + 1}] contiene un alias no válido; usa entre 1 y 64 caracteres alfanuméricos, punto, guion o guion bajo`,
			)
		}

		let url
		try {
			url = new URL(urlValue)
		} catch {
			throw new Error(`UPSTREAMS[${index + 1}] no es una URL válida: ${urlValue}`)
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`UPSTREAMS[${index + 1}] debe utilizar http o https`)
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(`UPSTREAMS[${index + 1}] no puede contener credenciales, query ni fragmento`)
		}
		if (url.pathname !== "/") {
			throw new Error(`UPSTREAMS[${index + 1}] debe contener solo esquema, host y puerto`)
		}

		return { alias, url }
	})

	const aliases = new Set()
	for (const upstream of upstreams) {
		if (aliases.has(upstream.alias)) {
			throw new Error(`UPSTREAMS contiene un alias duplicado: ${upstream.alias}`)
		}
		aliases.add(upstream.alias)
	}
	return upstreams
}

export const parseRetryStatusCodes = (value) => {
	const rules = String(value || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const match = /^(\d{3})(?:-(\d{3}))?$/.exec(entry)
			if (!match) throw new Error(`RETRY_STATUS_CODES contiene un valor no válido: ${entry}`)
			const minimum = Number(match[1])
			const maximum = Number(match[2] || match[1])
			if (minimum < 100 || maximum > 599 || minimum > maximum) {
				throw new Error(`RETRY_STATUS_CODES contiene un rango no válido: ${entry}`)
			}
			return { minimum, maximum }
		})

	if (rules.length === 0) throw new Error("RETRY_STATUS_CODES no puede estar vacío")
	return rules
}

export const isRetryableStatus = (statusCode, rules) =>
	rules.some(({ minimum, maximum }) => statusCode >= minimum && statusCode <= maximum)

export const loadConfig = (environment = process.env) => {
	const host = environment.HOST || "127.0.0.1"
	if (!host.trim() || /\s/.test(host)) throw new Error("HOST no es válido")

	return {
		host,
		usageDbPath: environment.USAGE_DB_PATH || resolve(process.cwd(), "data/usage.sqlite"),
		timeZone: parseTimeZone(environment.TZ || "Etc/UTC"),
		port: parseInteger("PORT", environment.PORT || "10530", {
			minimum: 1,
			maximum: 65535,
		}),
		upstreams: parseUpstreams(environment.UPSTREAMS || "http://127.0.0.1:10531"),
		upstreamTimeoutMs: parseInteger(
			"UPSTREAM_TIMEOUT_MS",
			environment.UPSTREAM_TIMEOUT_MS || "180000",
			{ minimum: 1, maximum: 3600000 },
		),
		upstreamFailureThreshold: parseInteger(
			"UPSTREAM_FAILURE_THRESHOLD",
			environment.UPSTREAM_FAILURE_THRESHOLD || "3",
			{ minimum: 1, maximum: 100 },
		),
		clientErrorFailureThreshold: parseInteger(
			"CLIENT_ERROR_FAILURE_THRESHOLD",
			environment.CLIENT_ERROR_FAILURE_THRESHOLD || "5",
			{ minimum: 1, maximum: 100 },
		),
		runtimeFailover: parseBoolean(
			"RUNTIME_FAILOVER",
			environment.RUNTIME_FAILOVER || "false",
		),
		// Legacy override for generic failures only; quota resets use provider timestamps.
		upstreamCooldownMs: parseDuration(
			"UPSTREAM_COOLDOWN",
			environment.UPSTREAM_COOLDOWN || "10m",
			{ minimum: 100, maximum: 86400000 },
		),
		maxRequestBodyBytes: parseInteger(
			"MAX_REQUEST_BODY_BYTES",
			environment.MAX_REQUEST_BODY_BYTES || "33554432",
			{ minimum: 1, maximum: 1073741824 },
		),
		retryStatusCodes: parseRetryStatusCodes(
			environment.RETRY_STATUS_CODES || "401,403,408,429,500-599",
		),
		apiKey: environment.ROUTER_API_KEY || "",
  quotaTimeoutMs: parseInteger('QUOTA_TIMEOUT_MS', environment.QUOTA_TIMEOUT_MS || '10000', { minimum: 1, maximum: 60000 }),
  quotaCacheMs: parseInteger('QUOTA_CACHE_MS', environment.QUOTA_CACHE_MS || '15000', { minimum: 1, maximum: 300000 }),
	}
}
