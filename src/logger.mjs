import { sanitizeLog } from './observability.mjs'

const createTimestampFormatter = (timeZone) =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	})

const formatTimestamp = (formatter, date) => {
	const parts = Object.fromEntries(
		formatter
			.formatToParts(date)
			.filter(({ type }) => type !== "literal")
			.map(({ type, value }) => [type, value]),
	)
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export const createLogger = ({
	timeZone = "Etc/UTC",
	output = (message) => console.log(message),
	now = () => new Date(),
 onRecord = () => {},
} = {}) => {
	const formatter = createTimestampFormatter(timeZone)

	const writeLog = (level, event, details = {}) => {
		const record = sanitizeLog(level, event, details)
		const serializedDetails = Object.fromEntries(Object.keys(details).filter((key) => key in record && !['timestamp', 'level', 'event'].includes(key)).map((key) => [key, record[key]]))
		onRecord(record.level, record.event, serializedDetails)
		const timestamp = formatTimestamp(formatter, now())
		const alias = serializedDetails.alias
		const progress = typeof details.logProgress === 'string' && /^\d{1,3}\/\d{1,3}$/.test(details.logProgress) ? details.logProgress : ''
		const aliasPrefix = alias ? ` [${alias}]` : ""
		const progressPrefix = progress ? ` [${progress}]` : ""
		const prefix = `[router-openai-oauth]${aliasPrefix}${progressPrefix}`
		output(
			`${prefix} ${record.level.toUpperCase()} ${timestamp} ${record.event} ${JSON.stringify(serializedDetails)}`,
		)
	}

	return {
		info: (event, details) => writeLog("info", event, details),
		warn: (event, details) => writeLog("warn", event, details),
		error: (event, details) => writeLog("error", event, details),
	}
}
