// Calendar dates and midnight bounds are explicit Europe/Madrid, not host TZ.
const zone = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' })
export const madridDay = (ms = Date.now()) => {
 const p = Object.fromEntries(zone.formatToParts(new Date(ms)).map(p => [p.type,p.value]))
 return `${p.year}-${p.month}-${p.day}`
}
const dayMs = day => {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('INVALID_QUERY')
 const ms = Date.parse(day+'T00:00:00.000Z')
 if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== day || day < '2000-01-01' || day > '9998-12-31') throw Error('INVALID_QUERY')
 return ms
}
const isoDay = ms => new Date(ms).toISOString().slice(0,10)
export const madridMidnight = day => {
 const target = dayMs(day)
 let ms = target
 for (let i=0;i<3;i++) {
  const p = Object.fromEntries(zone.formatToParts(new Date(ms)).map(p => [p.type,p.value]))
  const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`)
  ms += target-local
 }
 return new Date(ms).toISOString()
}
export const parseSummaryQuery = (params, now = Date.now()) => {
 if ([...params.keys()].some(k => !['from','to','account'].includes(k) || params.getAll(k).length !== 1)) throw Error('INVALID_QUERY')
 const to = params.get('to') ?? madridDay(now)
 const end = dayMs(to)
 const from = params.get('from') ?? isoDay(end-29*86400000)
 const start = dayMs(from), count = (end-start)/86400000+1
 if (count < 1 || count > 31) throw Error('INVALID_QUERY')
 const account = params.get('account')
 if (account !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(account)) throw Error('INVALID_QUERY')
 const days = Array.from({length:count},(_,i) => {
  const date = isoDay(start+i*86400000)
  return { date, from:madridMidnight(date), to:madridMidnight(isoDay(start+(i+1)*86400000)) }
 })
 return {from,to,account,days}
}
