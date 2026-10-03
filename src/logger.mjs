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
} = {}) => {
	const formatter = createTimestampFormatter(timeZone)

	const writeLog = (level, event, details = {}) => {
		const timestamp = formatTimestamp(formatter, now())
		const alias = details.alias
		const progress = details.logProgress
		const serializedDetails = { ...details }
		delete serializedDetails.logProgress
		const aliasPrefix = alias ? ` [${alias}]` : ""
		const progressPrefix = progress ? ` [${progress}]` : ""
		const prefix = `[router-openai-oauth]${aliasPrefix}${progressPrefix}`
		output(
			`${prefix} ${level.toUpperCase()} ${timestamp} ${event} ${JSON.stringify(serializedDetails)}`,
		)
	}

	return {
		info: (event, details) => writeLog("info", event, details),
		warn: (event, details) => writeLog("warn", event, details),
		error: (event, details) => writeLog("error", event, details),
	}
}
