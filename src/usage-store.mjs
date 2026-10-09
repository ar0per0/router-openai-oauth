import { Worker } from 'node:worker_threads'
import { metrics } from './usage.mjs'
export const parseUsageQuery = params => {
 const allowed = ['from','to','after','limit','account']
 if ([...params.keys()].some(k => !allowed.includes(k) || params.getAll(k).length !== 1)) throw Error('INVALID_QUERY')
 const date = key => { const v = params.get(key); if (!v || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw Error('INVALID_QUERY'); return v }
 const from = date('from'), to = date('to')
 if (from >= to || Date.parse(to)-Date.parse(from) > 31*86400000) throw Error('INVALID_QUERY')
 const num = (key, fallback, max) => { const v = params.get(key) ?? String(fallback); if (!/^\d{1,16}$/.test(v) || !Number.isSafeInteger(+v) || +v > max) throw Error('INVALID_QUERY'); return +v }
 const account = params.get('account'); if (account !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(account)) throw Error('INVALID_QUERY')
 const limit = num('limit',100,500); if (!limit) throw Error('INVALID_QUERY')
 return { from,to,account,limit,after:num('after',0,Number.MAX_SAFE_INTEGER) }
}
export const safeUsageRecord = r => {
 const value = { schemaVersion:1 }
 for (const key of ['timestamp','requestId','alias','endpoint','outcome','usageStatus','provenance','modelStatus']) value[key] = r[key]
 value.modelStatus ??= 'unknown'
 if (!['unknown','completed','failed','incomplete'].includes(value.modelStatus)) throw Error('INVALID_RECORD')
 for (const key of ['attempt','index','status','durationMs',...metrics]) value[key] = r[key] ?? null
 if (!/^\d{4}-\d\d-\d\dT/.test(value.timestamp) || !/^[a-f0-9-]{36}$/.test(value.requestId) || !/^[A-Za-z0-9._-]{1,64}$/.test(value.alias) || !['/v1/responses','/v1/chat/completions'].includes(value.endpoint) || !['complete','http_error','discarded','interrupted','transport_error'].includes(value.outcome) || !['unknown','upstream_reported'].includes(value.usageStatus) || !['none','observation_unavailable','chat_adapter_reported_zero_ambiguous','responses_upstream_reported'].includes(value.provenance)) throw Error('INVALID_RECORD')
 for (const key of ['attempt','index','status','durationMs',...metrics]) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key]<0)) throw Error('INVALID_RECORD')
 return value
}
export const createUsageStore = (path, { logger = { warn() {} }, capacity = 256 } = {}) => {
 const worker = new Worker(new URL('./usage-worker.mjs',import.meta.url), { workerData:{ path } })
 let sequence = 0, closing = false, failed = false, dropped = 0, errors = 0
 const pending = new Map()
 const warn = () => { errors++; logger.warn('usage_storage_error', { errors, dropped }) }
 const fail = () => { if (failed) return; failed = true; warn(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('STORAGE_UNAVAILABLE')) } pending.clear() }
 worker.on('error',fail); worker.on('exit',code => { if (!closing || code) fail() })
 worker.on('message',m => { if (m.failed) { fail(); return } const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); if (m.ok) p.resolve(m.value); else { warn(); p.reject(Error('STORAGE_UNAVAILABLE')) } })
 const send = (type, extra = {}) => new Promise((resolve,reject) => {
  if (failed || closing && type !== 'close' || pending.size >= capacity && type !== 'close') { reject(Error('STORAGE_UNAVAILABLE')); return }
  const id = ++sequence; const timer = setTimeout(() => { fail() },5000); timer.unref()
  pending.set(id,{ resolve,reject,timer }); worker.postMessage({ id,type,...extra })
 })
 return {
  write(record) { let safe; try { safe = safeUsageRecord(record) } catch { warn(); return false }
   if (failed || closing || pending.size >= capacity) { dropped++; logger.warn('usage_storage_drop',{ dropped, errors }); return false }
   send('write',{record:safe}).catch(() => {}); return true
  },
  query: query => send('query',{query}),
  summary: query => send('summary',{query}),
  health: () => ({ pending:pending.size,dropped,errors,available:!failed && !closing }),
  async close() { if (closing) return; closing = true; try { await send('close') } finally { await worker.terminate() } },
 }
}
