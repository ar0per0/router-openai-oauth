import { isIP } from 'node:net'

// Socket peer only. Unknown/invalid ports are omitted, never replaced by the listener port.
export const formatClientAddress = (address, port) => {
 if (typeof address !== 'string' || address.length > 45 || !isIP(address) || address.includes('%')) return undefined
 if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) address = address.slice(7)
 const hasPort = Number.isInteger(port) && port >= 1 && port <= 65535 && port !== 80 && port !== 443
 return hasPort ? `${isIP(address) === 6 ? `[${address}]` : address}:${port}` : address
}

// A dedicated IP validator, not the general free-form log token allowlist.
export const sanitizeClientAddress = (value) => {
 if (typeof value !== 'string' || value.length > 64) return undefined
 if (isIP(value)) return formatClientAddress(value)
 const match = /^(?:\[([0-9a-fA-F:.]+)\]|(\d+\.\d+\.\d+\.\d+)):(\d{1,5})$/.exec(value)
 if (!match || isIP(match[1] ?? match[2]) !== (match[1] ? 6 : 4)) return undefined
 const port = Number(match[3])
 if (port < 1 || port > 65535) return undefined
 return formatClientAddress(match[1] ?? match[2], port)
}
