import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { metrics } from './usage.mjs'
let db
try {
 mkdirSync(dirname(workerData.path), { recursive:true, mode:0o700 })
 db = new DatabaseSync(workerData.path)
 const version = db.prepare('PRAGMA user_version').get().user_version
 if (version !== 0 && version !== 1) { db.close(); db = null; throw Error() }
 db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, requestId TEXT NOT NULL, attempt INTEGER NOT NULL, alias TEXT NOT NULL, outcome TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(requestId,attempt));
 CREATE INDEX IF NOT EXISTS usage_time ON usage(timestamp,id);
 PRAGMA user_version=1;`)
 parentPort.postMessage({ ready:true })
} catch { try { db?.close() } catch {} db = null; parentPort.postMessage({ failed:true }) }
parentPort.on('message', ({ id, type, record, query }) => {
 try {
  if (!db) throw Error()
  if (type === 'write') db.prepare('INSERT OR IGNORE INTO usage(timestamp,requestId,attempt,alias,outcome,record) VALUES(?,?,?,?,?,?)').run(record.timestamp,record.requestId,record.attempt,record.alias,record.outcome,JSON.stringify(record))
  let value
  if (type === 'query') {
   const rows = db.prepare('SELECT id,record FROM usage WHERE timestamp>=? AND timestamp<? AND id>? AND (? IS NULL OR alias=?) ORDER BY id LIMIT ?').all(query.from,query.to,query.after,query.account,query.account,query.limit+1)
   const more = rows.length > query.limit; if (more) rows.pop()
   value = { schemaVersion:1, records:rows.map(r => ({ id:r.id,...JSON.parse(r.record) })), nextCursor:more ? rows.at(-1).id : null }
  }
  if (type === 'summary') {
   // Only bounded calendar ranges, parameters and fixed metric names reach SQL.
   if (!Array.isArray(query.days) || query.days.length < 1 || query.days.length > 31) throw Error()
   const ranges = query.days.map(() => '(?,?,?)').join(',')
   const columns = metrics.map((m,i) => `SUM(json_extract(u.record,'$.${m}')) AS sum${i}, COUNT(json_extract(u.record,'$.${m}')) AS known${i}`).join(',')
   const rows = db.prepare(`WITH days(date,start,end) AS (VALUES ${ranges})
    SELECT d.date, COUNT(u.id) AS attempts,
    SUM(CASE WHEN u.id IS NOT NULL AND (u.outcome!='complete' OR json_extract(u.record,'$.modelStatus') IN ('failed','incomplete')) THEN 1 ELSE 0 END) AS incomplete,
    ${columns} FROM days d LEFT JOIN usage u ON u.timestamp>=d.start AND u.timestamp<d.end AND (? IS NULL OR u.alias=?)
    GROUP BY d.date ORDER BY d.date`).all(...query.days.flatMap(d => [d.date,d.from,d.to]),query.account,query.account)
   if (rows.some(r => metrics.some((m,i) => r['sum'+i] !== null && !Number.isSafeInteger(r['sum'+i])))) throw Error()
   // Historical aliases are range-scoped, distinct and bounded; no full-history list.
   const accounts = db.prepare('SELECT DISTINCT alias FROM usage WHERE timestamp>=? AND timestamp<? ORDER BY alias LIMIT 501').all(query.days[0].from,query.days.at(-1).to)
   value = { schemaVersion:1, timeZone:'Europe/Madrid', from:query.from,to:query.to,
    accounts:accounts.slice(0,500).map(r=>r.alias), accountsTruncated:accounts.length>500,
    days:rows.map(r=>({ date:r.date,attempts:r.attempts,incomplete:r.incomplete,
     metrics:Object.fromEntries(metrics.map((m,i)=>[m,{sum:r['sum'+i],known:r['known'+i],unknown:r.attempts-r['known'+i]}])) })) }
  }
  if (type === 'close') { db.close(); db = null }
  parentPort.postMessage({ id, value, ok:true })
 } catch { parentPort.postMessage({ id, ok:false }) }
})
