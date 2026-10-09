// Public metadata only; never forward inbound headers, filters or usage to providers.
export const CATALOG_URL = 'https://api.litellm.ai/model_catalog'
export const FX_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rate/USD/EUR'
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
export const normalizeModel = m => {
 if (!m || !text(m.id, 256) || !text(m.provider, 80) || !['chat','completion'].includes(m.mode)) return null
 const rates = { input:finite(m.input_cost_per_token), output:finite(m.output_cost_per_token), cache:finite(m.cache_read_input_token_cost), reasoning:finite(m.output_cost_per_reasoning_token) }
 if (rates.input === null && rates.output === null) return null
 return { id:m.id, provider:m.provider, mode:m.mode, rates }
}
async function json(fetchImpl, url, signal, maxBytes) {
 const r = await fetchImpl(url, { signal, redirect:'error', credentials:'omit', headers:{accept:'application/json'} })
 if (!r.ok || !/^application\/json\b/i.test(r.headers.get('content-type') ?? '') || Number(r.headers.get('content-length')) > maxBytes) throw Error('PUBLIC_METADATA_UNAVAILABLE')
 const reader=r.body.getReader(); let bytes=0; const chunks=[]
 try {
  while (true) { const {done,value}=await reader.read(); if(done) break; bytes+=value.byteLength; if(bytes>maxBytes) throw Error('METADATA_LIMIT'); chunks.push(value) }
 } finally { await reader.cancel().catch(()=>{}); reader.releaseLock() }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
// Independent success TTLs; failed loads have a cooldown and never reuse expired FX.
// Each refresh is single-flight, bounded as a whole, and all-or-nothing for pagination.
export const createPricingReader = ({fetchImpl=fetch, now=Date.now, catalogTTL=86400000, fxTTL=21600000, failureTTL=60000, timeoutMs=20000, maxPages=30, maxPageBytes=2097152}={}) => {
 const cached = (load, ttl) => {
  let value=null, expires=0, pending=null
  return () => {
   if (now()<expires) return Promise.resolve(value)
   if(pending) return pending
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs)
   pending=(async()=>{
    try {value=await load(controller.signal);expires=now()+ttl}
    catch {value=null;expires=now()+failureTTL}
    finally {clearTimeout(timer);pending=null}
    return value
   })()
   return pending
  }
 }
 const catalog=cached(async signal=>{
  const models=new Map(); let count=0
  for(let page=1;page<=maxPages;page++) {
   const d=await json(fetchImpl,`${CATALOG_URL}?page=${page}&page_size=500`,signal,maxPageBytes)
   if(!Array.isArray(d.data)||d.data.length>500||typeof d.has_more!=='boolean'||d.page!==page||d.page_size!==500||!Number.isSafeInteger(d.total_count)||d.total_count<0) throw Error('INVALID_CATALOG')
   count+=d.data.length
   for(const raw of d.data) {const m=normalizeModel(raw);if(m) {const key=JSON.stringify([m.provider,m.id]);const previous=models.get(key);if(previous && JSON.stringify(previous)!==JSON.stringify(m)) throw Error('CONFLICTING_MODEL');models.set(key,m)}}
   if(!d.has_more) { if(count!==d.total_count||!models.size) throw Error('INCOMPLETE_CATALOG');return {models:[...models.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.id.localeCompare(b.id)), fetchedAt:new Date(now()).toISOString(), source:CATALOG_URL,currency:'USD'} }
   if(!d.data.length) throw Error('EMPTY_PAGE')
  }
  throw Error('PAGE_LIMIT')
 },catalogTTL)
 const fx=cached(async signal=>{
  const d=await json(fetchImpl,FX_URL,signal,16384)
  const ms=typeof d.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)?Date.parse(d.date+'T00:00:00Z'):NaN
  if(d.base!=='USD'||d.quote!=='EUR'||finite(d.rate)===null||d.rate===0||!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==d.date||ms>now()||now()-ms>7*86400000) throw Error('INVALID_FX')
  return {base:'USD',quote:'EUR',rate:d.rate,date:d.date,source:FX_URL,fetchedAt:new Date(now()).toISOString()}
 },fxTTL)
 return async()=>{const [c,f]=await Promise.all([catalog(),fx()]);return {catalog:c,fx:f, catalogTTL,fxTTL}}
}
