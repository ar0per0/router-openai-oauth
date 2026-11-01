// Public metadata only; never forward inbound headers, filters or usage to providers.
export const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const FX_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rate/USD/EUR'
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
export const normalizeModel = m => {
 if (!m || !text(m.id, 256) || !text(m.provider, 80) || !['chat','completion'].includes(m.mode)) return null
 const rates = { input:finite(m.input_cost_per_token), output:finite(m.output_cost_per_token), cache:finite(m.cache_read_input_token_cost), reasoning:finite(m.output_cost_per_reasoning_token) }
 if (rates.input === null && rates.output === null) return null
 return { id:m.id, provider:m.provider, mode:m.mode, rates }
}
async function json(fetchImpl, url, signal, maxBytes, allowText = false) {
 const r = await fetchImpl(url, { signal, redirect:'error', credentials:'omit', headers:{accept:'application/json'} })
 const contentType = r.headers.get('content-type') ?? ''
 if (!r.ok || !(/^application\/json\b/i.test(contentType) || (allowText && /^text\/plain\b/i.test(contentType))) || Number(r.headers.get('content-length')) > maxBytes) {
  await r.body?.cancel().catch(()=>{})
  throw Error('PUBLIC_METADATA_UNAVAILABLE')
 }
 const reader=r.body.getReader(); let bytes=0; const chunks=[]
 try {
  while (true) { const {done,value}=await reader.read(); if(done) break; bytes+=value.byteLength; if(bytes>maxBytes) throw Error('METADATA_LIMIT'); chunks.push(value) }
 } finally { await reader.cancel().catch(()=>{}); reader.releaseLock() }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
// Independent success TTLs; failed loads have a cooldown and never reuse expired FX.
// Each refresh is single-flight and bounded as a whole.
export const createPricingReader = ({fetchImpl=fetch, now=Date.now, catalogTTL=86400000, fxTTL=21600000, failureTTL=60000, timeoutMs=20000, maxCatalogBytes=8388608}={}) => {
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
  const d=await json(fetchImpl,CATALOG_URL,signal,maxCatalogBytes,true)
  if(!d||typeof d!=='object'||Array.isArray(d)) throw Error('INVALID_CATALOG')
  const models=[]
  for(const [id,raw] of Object.entries(d)) {
   if(id==='sample_spec'||!raw||typeof raw!=='object'||Array.isArray(raw)) continue
   const m=normalizeModel({...raw,id,provider:raw.litellm_provider})
   if(m) models.push(m)
   if(models.length>15000) throw Error('MODEL_LIMIT')
  }
  if(!models.length) throw Error('EMPTY_CATALOG')
  return {models:models.sort((a,b)=>a.provider.localeCompare(b.provider)||a.id.localeCompare(b.id)), fetchedAt:new Date(now()).toISOString(), source:CATALOG_URL,currency:'USD'}
 },catalogTTL)
 const fx=cached(async signal=>{
  const d=await json(fetchImpl,FX_URL,signal,16384)
  const ms=typeof d.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)?Date.parse(d.date+'T00:00:00Z'):NaN
  if(d.base!=='USD'||d.quote!=='EUR'||finite(d.rate)===null||d.rate===0||!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==d.date||ms>now()||now()-ms>7*86400000) throw Error('INVALID_FX')
  return {base:'USD',quote:'EUR',rate:d.rate,date:d.date,source:FX_URL,fetchedAt:new Date(now()).toISOString()}
 },fxTTL)
 return async()=>{const [c,f]=await Promise.all([catalog(),fx()]);return {catalog:c,fx:f, catalogTTL,fxTTL}}
}
