import { randomUUID } from 'node:crypto'
import { sanitizeClientAddress } from './client-address.mjs'
// Shared bounded quota source: observation never reserves a recovery probe.
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null
const text = (v) => typeof v === 'string' && /^[a-zA-Z0-9 ._:-]{1,128}$/.test(v) && !v.includes('@') ? v : null
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const windowValue = (v) => object(v) ? {
 usedPercent: number(v.usedPercent), windowDurationMins: number(v.windowDurationMins), resetsAt: number(v.resetsAt),
} : null
const snapshot = (v) => object(v) ? {
 limitId: text(v.limitId), limitName: text(v.limitName), normalModelSlug: text(v.normalModelSlug), primary: windowValue(v.primary), secondary: windowValue(v.secondary),
 credits: v.credits && typeof v.credits === 'object' ? { hasCredits: typeof v.credits.hasCredits === 'boolean' ? v.credits.hasCredits : null, unlimited: typeof v.credits.unlimited === 'boolean' ? v.credits.unlimited : null, balance: typeof v.credits.balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.credits.balance) && v.credits.balance.length <= 128 ? v.credits.balance : null } : null,
 planType: text(v.planType),
} : null
export const sanitizeRateLimits = (v) => {
 if (!object(v) || (!Object.hasOwn(v, 'rateLimits') && !Object.hasOwn(v, 'rateLimitsByLimitId'))) throw new Error('INVALID_SCHEMA')
 if (v.rateLimits != null && !object(v.rateLimits)) throw new Error('INVALID_SCHEMA')
 if (v.rateLimitsByLimitId != null && !object(v.rateLimitsByLimitId)) throw new Error('INVALID_SCHEMA')
 for (const s of [v.rateLimits, ...Object.values(v.rateLimitsByLimitId ?? {})]) {
  if (s == null) continue
  if (!object(s) || ['primary', 'secondary', 'credits'].some((key) => s[key] != null && !object(s[key]))) throw new Error('INVALID_SCHEMA')
 }
 const entries = v.rateLimitsByLimitId && typeof v.rateLimitsByLimitId === 'object' && !Array.isArray(v.rateLimitsByLimitId) ? Object.entries(v.rateLimitsByLimitId).slice(0, 64).filter(([key]) => text(key)).map(([key, value]) => [key, snapshot(value)]) : []
 return { rateLimits: snapshot(v.rateLimits), rateLimitsByLimitId: v.rateLimitsByLimitId == null ? null : Object.fromEntries(entries) }
}
export const createQuotaReader = (config, { fetchImpl = fetch, now = Date.now } = {}) => {
 let cached, inFlight
 const readOne = async (upstream) => {
  const controller = new AbortController()
  let timer
  try {
   const task = async () => {
    const response = await fetchImpl(new URL('/oauth/rate-limits', upstream.url), { redirect: 'manual', signal: controller.signal })
    if (!response.ok) { await response.body?.cancel(); return { error: `HTTP_${response.status}`, rateLimits: null } }
    let size = 0
    const chunks = []
    for await (const chunk of response.body) { size += chunk.length; if (size > 262144) { controller.abort(); throw new Error('RESPONSE_TOO_LARGE') } chunks.push(chunk) }
    return { error: null, rateLimits: sanitizeRateLimits(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
   }
   return await Promise.race([task(), new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ error: 'TIMEOUT', rateLimits: null }) }, config.quotaTimeoutMs ?? 10000) })])
  } catch { return { error: 'INVALID_OR_UNAVAILABLE', rateLimits: null } }
  finally { clearTimeout(timer) }
 }
 const read = async ({ refresh = false } = {}) => {
  if (inFlight) return inFlight
  if (!refresh && cached && now() - cached.time < (config.quotaCacheMs ?? 15000)) return cached.value
  inFlight = (async () => {
   const accounts = await Promise.all(config.upstreams.map(async (upstream) => ({ alias: upstream.alias, ...await readOne(upstream) })))
   const value = { accounts, fetchedAt: new Date(now()).toISOString() }
   cached = { time: now(), value }
   return value
  })()
  try { return await inFlight } finally { inFlight = null }
 }
 read.peek = () => cached && now() - cached.time < (config.quotaCacheMs ?? 15000) ? cached.value : null
 return read
}
// Only the aggregate/default limit is unambiguously account-wide. Model-specific
// IDs cannot safely disable the whole upstream. Unix seconds are never local time.
const validUsed = (window) => typeof window?.usedPercent === 'number' &&
 Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100
export const quotaAvailable = (account) => {
 if (account?.error) return false
 const limits = account?.rateLimits?.rateLimits
 return [limits?.primary, limits?.secondary].every(w => validUsed(w) && w.usedPercent < 100)
}
export const quotaBlockedUntil = (account, now = Date.now()) => {
 if (account?.error) return 0
 const limits = account?.rateLimits?.rateLimits
 // Weekly exhaustion takes precedence, even when its reset is unknown/expired.
 // Unknown weekly availability is not evidence that the weekly quota is positive.
 const weekly = limits?.secondary, primary = limits?.primary
 const window = validUsed(weekly) && weekly.usedPercent === 100 ? weekly :
  validUsed(weekly) && weekly.usedPercent < 100 && validUsed(primary) && primary.usedPercent === 100 ? primary : null
 const ms = window?.resetsAt * 1000
 return typeof window?.resetsAt === 'number' && Number.isFinite(ms) &&
  ms > now && ms <= 8640000000000000 ? ms : 0
}
const numericFields = ['index','attempt','status','durationMs','failures','threshold','clientErrors','cooldownMs','previousFailures','previousClientErrors','total','maxAttempts','timeoutMs','port','dropped','errors']
const tokenFields = ['alias','reason','error','stage','disabledUntil','signal','authentication','requestId','method']
export const sanitizeLog = (level, event, details = {}, timestamp = new Date().toISOString()) => {
 const safe = { timestamp, level: ['info','warn','error'].includes(level) ? level : 'info', event: /^[a-z_]{1,80}$/.test(event) ? event : 'redacted_event' }
 const clientAddress = sanitizeClientAddress(details.clientAddress)
 if (clientAddress !== undefined) safe.clientAddress = clientAddress
 if (typeof details.healthy === 'boolean') safe.healthy = details.healthy
 else if (typeof details.healthy === 'number' && Number.isFinite(details.healthy)) safe.healthy = details.healthy
 for (const key of numericFields) if (typeof details[key] === 'number' && Number.isFinite(details[key])) safe[key] = details[key]
 for (const key of tokenFields) {
  const value = details[key]
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && !/bearer|token|secret|password|sk-/i.test(value)) safe[key] = value
 }
 for (const key of ['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens']) if (details[key] === null || Number.isSafeInteger(details[key]) && details[key] >= 0) safe[key] = details[key]
 for (const key of ['outcome','usageStatus','provenance','modelStatus']) if (typeof details[key] === 'string' && /^[a-z_]{1,80}$/.test(details[key])) safe[key] = details[key]
 if (['/v1/responses','/v1/chat/completions'].includes(details.endpoint)) safe.endpoint = details.endpoint
 return safe
}
export const createLogHub = ({
 maxEntries = 200, maxSubscribers = 16, maxFrameBytes = 2048,
 maxQueueFrames = 256, maxQueueBytes = 1024 * 1024,
 drainTimeoutMs = 30000, heartbeatMs = 15000,
} = {}) => {
 const entries = [], subscribers = new Set()
 const epoch = randomUUID(); let sequence = 0n
 const publish = (level, event, details) => {
  const dataFrame = `data: ${JSON.stringify(sanitizeLog(level, event, details))}\n\n`
  if (Buffer.byteLength(dataFrame) > maxFrameBytes) return
  const frame = `id: ${epoch}:${++sequence}\n${dataFrame}`
  entries.push(frame); if (entries.length > maxEntries) entries.shift()
  for (const subscriber of subscribers) subscriber.enqueue(frame)
 }
 const connect = (response, lastEventId) => {
  if (subscribers.size >= maxSubscribers) { response.writeHead(503); response.end(); return }
  let closed = false, paused = false, pumping = false, queuedBytes = 0, heartbeat, drainTimer
  const queue = []
  const cleanup = () => {
   if (closed) return
   closed = true
   subscribers.delete(subscriber)
   clearInterval(heartbeat); clearTimeout(drainTimer)
   response.off('drain', onDrain); response.off('close', cleanup); response.off('error', disconnect)
   queue.length = 0; queuedBytes = 0
  }
  const disconnect = () => {
   cleanup()
   // A viewer's faulty transport must never throw through publish/logger.
   try { response.destroy() } catch {}
  }
  const pump = () => {
   if (closed || paused || pumping) return
   pumping = true
   try {
    while (queue.length && !closed && !paused) {
     if (response.destroyed || response.writableEnded) { disconnect(); break }
     const frame = queue.shift(); queuedBytes -= Buffer.byteLength(frame)
     // false means accepted: remove once, and never replay it on drain.
     if (!response.write(frame) && !closed) {
      paused = true
      response.once('drain', onDrain)
      drainTimer = setTimeout(disconnect, drainTimeoutMs); drainTimer.unref?.()
     }
    }
   } catch { disconnect() }
   finally { pumping = false }
  }
  const onDrain = () => {
   if (closed) return
   clearTimeout(drainTimer); drainTimer = undefined; paused = false
   pump()
  }
  const subscriber = {
   enqueue(frame) {
    if (closed) return
    const bytes = Buffer.byteLength(frame)
    if (queue.length >= maxQueueFrames || queuedBytes + bytes > maxQueueBytes) { disconnect(); return }
    queue.push(frame); queuedBytes += bytes; pump()
   },
   disconnect,
  }
  response.on('close', cleanup); response.on('error', disconnect)
  subscribers.add(subscriber)
  try {
   response.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','connection':'keep-alive' })
   response.flushHeaders?.()
   if (closed) return
   heartbeat = setInterval(() => subscriber.enqueue(': keepalive\n\n'), heartbeatMs); heartbeat.unref?.()
   // Only skip through an exact retained cursor; unknown/evicted epochs replay the ring.
   const cursor = typeof lastEventId === 'string' && lastEventId.length <= 128 ? entries.findIndex(frame => frame.startsWith(`id: ${lastEventId}\n`)) : -1
   for (const frame of entries.slice(cursor + 1)) subscriber.enqueue(frame)
  } catch { disconnect() }
 }
 const close = () => { for (const subscriber of subscribers) subscriber.disconnect() }
 return { publish, connect, close, get size() { return entries.length }, get subscriberCount() { return subscribers.size } }
}
