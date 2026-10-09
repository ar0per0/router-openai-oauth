import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createUsageObserver, normalizeUsage } from '../src/usage.mjs'
import { createUsageStore, parseUsageQuery } from '../src/usage-store.mjs'
import { sanitizeLog } from '../src/observability.mjs'
import { createLogger } from '../src/logger.mjs'
import { createRouterServer } from '../src/server.mjs'
import { loadConfig } from '../src/config.mjs'
const observe = async (body, endpoint='/v1/responses', headers={'content-type':'application/json'}, options={}) => {
 const bytes=Buffer.from(body), observer=createUsageObserver(endpoint,headers,options), chunks=[]
 await pipeline(Readable.from(Array.from(bytes,b=>Buffer.from([b]))),observer.stream,new Writable({write(c,e,cb){ chunks.push(c); setImmediate(cb) }}))
 assert.deepEqual(Buffer.concat(chunks),bytes)
 return observer.snapshot()
}
const u = {input_tokens:12,output_tokens:4,total_tokens:16,input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:2}}
const empty = {inputTokens:null,outputTokens:null,totalTokens:null,cachedTokens:null,reasoningTokens:null}
test('JSON selectively discards output, handles UTF8 fragments, nested detail subsets, unknown and zero',async()=>{
 const r=await observe(JSON.stringify({output:[{text:'privado 💡'.repeat(10000)}],usage:u}))
 assert.deepEqual(Object.fromEntries(Object.keys(empty).map(k=>[k,r[k]])),{inputTokens:12,outputTokens:4,totalTokens:16,cachedTokens:5,reasoningTokens:2})
 assert.equal(r.usageStatus,'upstream_reported')
 for (const v of [null,-1,1.2,'4',Number.MAX_SAFE_INTEGER+1]) assert.equal(normalizeUsage({input_tokens:v}).inputTokens,null)
 assert.equal(normalizeUsage({input_tokens:0}).inputTokens,0)
 assert.equal((await observe('{"usage":{"input_tokens":0}}')).totalTokens,null)
 assert.equal((await observe('{"usage":null}')).usageStatus,'unknown')
 assert.equal((await observe('{"status":"incomplete","usage":null}')).modelStatus,'incomplete')
})
test('SSE Responses CRLF multiline completed, identical repetitions and DONE are not summed',async()=>{
 const event='data: '+JSON.stringify({type:'response.completed',response:{output:[{text:'privado 💡'}],usage:u}})+'\r\n\r\n'
 const r=await observe('event: response.output_text.delta\r\ndata: {"delta":"secret"}\r\n\r\n'+event+event+'data: [DONE]\r\n\r\n','/v1/responses',{'content-type':'text/event-stream'})
 assert.equal(r.totalTokens,16); assert.equal(r.usageStatus,'upstream_reported')
 const multi=await observe('data: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":7}}}\n\n','/v1/responses',{'content-type':'text/event-stream'})
 assert.equal(multi.inputTokens,7)
 for (const type of ['response.failed','response.incomplete']) assert.equal((await observe(`data: ${JSON.stringify({type,response:{usage:u}})}\n\n`,'/v1/responses',{'content-type':'text/event-stream'})).totalTokens,16)
})
test('Chat JSON and final empty choices chunk; adapter provenance, no include_usage request mutation',async()=>{
 const usage={prompt_tokens:0,completion_tokens:2,total_tokens:2,prompt_tokens_details:{cached_tokens:0}}
 assert.equal((await observe(JSON.stringify({choices:[{message:{content:'private'}}],usage}),'/v1/chat/completions')).inputTokens,0)
 const r=await observe(`data: {"choices":[{"delta":{"content":"private"}}],"usage":null}\n\ndata: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`,'/v1/chat/completions',{'content-type':'text/event-stream'})
 assert.equal(r.totalTokens,2); assert.equal(r.provenance,'chat_adapter_reported_zero_ambiguous')
 assert.equal((await observe(`data: ${JSON.stringify({choices:[{}],usage})}\n\n`,'/v1/chat/completions',{'content-type':'text/event-stream'})).usageStatus,'unknown')
})
test('bounds, invalid UTF8, malformed JSON, gzip, depth and conflicting terminal chunks fail observer only',async()=>{
 for (const body of ['{"usage":', '{"usage":{"input_tokens":1},}', '['.repeat(65)+']'.repeat(65)]) assert.equal((await observe(body)).usageStatus,'unknown')
 assert.equal((await observe(JSON.stringify({usage:u}),undefined,undefined,{maxBytes:8})).usageStatus,'unknown')
 assert.equal((await observe(JSON.stringify({usage:u}),undefined,{'content-type':'application/json','content-encoding':'gzip'})).usageStatus,'unknown')
 assert.equal((await observe(Buffer.from([255,254]))).usageStatus,'unknown')
 const events=[u,{...u,total_tokens:20}].map(usage=>'data: '+JSON.stringify({type:'response.completed',response:{usage}})+'\n\n').join('')
 assert.equal((await observe(events,undefined,{'content-type':'text/event-stream'})).usageStatus,'unknown')
})
const record=(n=1)=>({timestamp:'2026-10-07T17:00:00.000Z',requestId:'00000000-0000-0000-0000-000000000001',attempt:n,index:n,alias:'principal',endpoint:'/v1/responses',outcome:'complete',usageStatus:'upstream_reported',provenance:'responses_upstream_reported',...normalizeUsage(u),status:200,durationMs:10})
const params=()=>new URLSearchParams({from:'2026-10-07T00:00:00.000Z',to:'2026-10-08T00:00:00.000Z',limit:'1'})
test('SQLite persist/reopen dedupe pagination date/account filters and privacy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-usage-')); const path=join(root,'usage.sqlite')
 let store=createUsageStore(path)
 try {
  store.write({...record(),clientAddress:'192.0.2.1',prompt:'NEVER_PERSIST',auth:'NEVER_PERSIST'}); store.write(record());store.write({...record(2),outcome:'discarded'})
  const q=parseUsageQuery(params()); const first=await store.query(q)
  assert.equal(first.records.length,1);assert.equal(first.nextCursor,first.records[0].id);assert.equal(first.records[0].inputTokens,12)
  assert.ok(!JSON.stringify(first).includes('NEVER_PERSIST'));assert.ok(!('clientAddress' in first.records[0]))
  await store.close(); store=createUsageStore(path)
  const second=await store.query({...q,after:first.nextCursor});assert.equal(second.records[0].attempt,2);assert.equal(second.nextCursor,null)
  assert.equal((await store.query({...q,account:'other'})).records.length,0)
  assert.equal((await store.query({...q,to:q.from})).records.length,0)
  await store.close()
  assert.ok(!(await readFile(path)).includes(Buffer.from('NEVER_PERSIST')))
 } finally { await store.close(); await rm(root,{recursive:true,force:true}) }
})
test('query caps and disk/queue errors are safe and observable',async()=>{
 for (const suffix of ['&sql=select','&limit=501','&after=-1','&account=../secret','&limit=2']) assert.throws(()=>parseUsageQuery(new URLSearchParams(params().toString()+suffix)))
 const logs=[];const store=createUsageStore('/dev/null/NEVER_LOG_PATH.sqlite',{logger:{warn:(e,d)=>logs.push([e,d])},capacity:1})
 store.write(record()); assert.equal(store.write(record(2)),false)
 await assert.rejects(store.query(parseUsageQuery(params())))
 await store.close().catch(()=>{})
 assert.ok(logs.length);assert.ok(!JSON.stringify(logs).includes('NEVER_LOG_PATH'))
})
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return `http://127.0.0.1:${s.address().port}`}
const close=async s=>{s.closeAllConnections();await new Promise(r=>s.close(r))}
test('HTTP failover terminal once per attempt, unchanged bytes/headers/auth, public bounded query',async()=>{
 const requests=[],logs=[],persisted=[]
 const payload=JSON.stringify({usage:u,output:[{text:'PRIVATE_RESPONSE'}]})
 const a=http.createServer(async(req,res)=>{for await(const c of req){};res.writeHead(500);res.end('discarded')})
 const b=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({body,headers:req.headers});res.writeHead(200,{'content-type':'application/json','x-test':'kept'});res.end(payload)})
 const ua=await listen(a),ub=await listen(b)
 const store={write:r=>persisted.push(r),query:async()=>({records:[]}),health:()=>({available:true})}
 const router=createRouterServer(loadConfig({UPSTREAMS:`first=${ua}|second=${ub}`,RUNTIME_FAILOVER:'true',ROUTER_API_KEY:'synthetic'}),{usageStore:store,logger:createLogger({output:l=>logs.push(l)}),quotaFetchImpl:async()=>Response.json({rateLimits:null})})
 const url=await listen(router)
 try {
  const body=JSON.stringify({model:'PRIVATE_MODEL',input:'PRIVATE_PROMPT',stream:false})
  assert.equal((await fetch(url+'/v1/responses',{method:'POST',body})).status,401)
  const r=await fetch(url+'/v1/responses?private_query=NEVER_LOG',{method:'POST',body,headers:{authorization:'Bearer synthetic','content-type':'application/json'}})
  assert.equal(r.status,200);assert.equal(r.headers.get('x-test'),'kept');assert.equal(await r.text(),payload)
  // HTTP finish/pipeline completion may resolve after client has read the body.
  await new Promise(r=>setImmediate(r))
  assert.equal(persisted.length,2);assert.deepEqual(persisted.map(r=>r.outcome),['discarded','complete']);assert.equal(persisted[0].totalTokens,null);assert.equal(persisted[1].totalTokens,16)
  assert.equal(requests[0].body,body);assert.equal(requests[0].headers.authorization,'Bearer openai-oauth')
  assert.equal(logs.filter(l=>l.includes(' usage_attempt ')).length,2)
  assert.equal(logs.filter(l=>l.includes(' request_complete ')).length,0)
  assert.ok(logs.some(l=>l.includes(' upstream_retry ')))
  for (const line of logs.filter(l=>l.includes(' usage_attempt '))) {
   const terminal=JSON.parse(line.slice(line.indexOf('{')))
   const row=persisted.find(r=>r.attempt===terminal.attempt)
   assert.equal(terminal.method,'POST');assert.equal(terminal.durationMs,row.durationMs)
   assert.equal(terminal.totalTokens,row.totalTokens)
  }
  for(const secret of ['PRIVATE_MODEL','PRIVATE_PROMPT','PRIVATE_RESPONSE','NEVER_LOG','synthetic']) assert.ok(!logs.join('').includes(secret))
  assert.ok(logs.find(l=>l.includes('usage_attempt')).includes('clientAddress'))
  assert.equal((await fetch(url+'/router/usage?'+params())).status,200)
  assert.equal((await fetch(url+'/router/usage?limit=999')).status,400)
 } finally {await close(router);await close(a);await close(b)}
})
test('observer preserves measurement after downstream cancellation, unknown before terminal',async()=>{
 for (const terminal of [false,true]) {
  const records=[],logs=[]
  const a=http.createServer(async(req,res)=>{for await(const c of req){};res.writeHead(200,{'content-type':'text/event-stream'});res.write(terminal?'data: '+JSON.stringify({type:'response.completed',response:{usage:u}})+'\n\n':'data: {"type":"response.output_text.delta","delta":"private"}\n\n')})
  const ua=await listen(a)
  const router=createRouterServer(loadConfig({UPSTREAMS:ua}),{usageStore:{write:r=>records.push(r)},logger:createLogger({output:l=>logs.push(l)}),quotaFetchImpl:async()=>Response.json({rateLimits:null})})
  const url=await listen(router)
  try {
   const response=await fetch(url+'/v1/responses',{method:'POST',body:'{}'});const reader=response.body.getReader();await reader.read();await reader.cancel()
   await new Promise(resolve=>{const end=setTimeout(resolve,1000);const check=()=>{if(records.length){clearTimeout(end);resolve()}else setImmediate(check)};check()})
   assert.equal(records.length,1);assert.equal(records[0].outcome,'interrupted');assert.equal(records[0].totalTokens,terminal?16:null)
   assert.equal(logs.filter(l=>l.includes(' usage_attempt ')).length,1)
   assert.equal(logs.filter(l=>l.includes(' request_complete ')).length,0)
  } finally {await close(router);await close(a)}
 }
})
test('console and SSE sanitizer retain scalar tokens and omit payloads',()=>{
 const safe=sanitizeLog('info','usage_attempt',{...record(),prompt:'PRIVATE',usage:{text:'PRIVATE'},inputTokens:-1})
 assert.ok(!('inputTokens'in safe));assert.equal(safe.totalTokens,16);assert.equal(safe.endpoint,'/v1/responses');assert.ok(!JSON.stringify(safe).includes('PRIVATE'))
})

test('observer pipeline backpressure bounds source advancement with stalled downstream',async()=>{
 let produced=0,release
 const observer=createUsageObserver('/v1/responses',{'content-type':'application/json'})
 const source=Readable.from((function*(){for(let n=0;n<128;n++){produced++;yield Buffer.alloc(8192,32)}})(),{highWaterMark:8192,objectMode:false})
 const sink=new Writable({highWaterMark:8192,write(c,e,cb){release=cb}})
 const task=pipeline(source,observer.stream,sink).catch(()=>{})
 await new Promise(r=>setImmediate(r));assert.ok(produced<32,`produced ${produced}`)
 sink.destroy();release?.();await task
})
test('close drains full bounded writer queue before reopen and future schema fails safe',async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-usage-drain-')),path=join(root,'usage.sqlite')
 let store=createUsageStore(path,{capacity:1})
 try {
  assert.equal(store.write(record()),true);await store.close()
  store=createUsageStore(path);assert.equal((await store.query(parseUsageQuery(params()))).records.length,1);await store.close()
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path);db.exec('PRAGMA user_version=999');db.close()
  store=createUsageStore(path);await assert.rejects(store.query(parseUsageQuery(params())));await store.close().catch(()=>{})
 }finally{await store.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
})

// Exercise the real worker, not a logger callback masquerading as persistence.
test('merged JSON/SSE terminal matches one SQLite row and unchanged summary/pricing with silent stdout',async()=>{
 const {parseSummaryQuery,madridDay}=await import('../src/usage-summary.mjs')
 const vm=await import('node:vm')
 const context={Intl};vm.runInNewContext(await readFile(new URL('../src/web/pricing.js',import.meta.url),'utf8'),context)
 for (const endpoint of ['/v1/responses','/v1/chat/completions']) for (const streaming of [false,true]) for (const silent of [false,true]) {
  const root=await mkdtemp(join(tmpdir(),'merged-')),store=createUsageStore(join(root,'usage.sqlite')),logs=[],published=[]
  const usage=endpoint.endsWith('responses')?u:{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:5},completion_tokens_details:{reasoning_tokens:0}}
  const obj=endpoint.endsWith('responses')?{type:'response.completed',response:{usage}}:{choices:[],usage}
  const payload=streaming?`data: ${JSON.stringify(obj)}\n\ndata: ${JSON.stringify(obj)}\n\ndata: [DONE]\n\n`:JSON.stringify({usage})
  const a=http.createServer(async(req,res)=>{for await(const c of req){};res.writeHead(200,{'content-type':streaming?'text/event-stream':'application/json'});res.end(payload)})
  const ua=await listen(a)
  const router=createRouterServer(loadConfig({UPSTREAMS:`account=${ua}`}),{usageStore:store,logger:createLogger({output:silent?()=>{}:l=>logs.push(l),onRecord:(level,event,details)=>published.push({event,...details})}),quotaFetchImpl:async()=>Response.json({rateLimits:null})})
  const url=await listen(router)
  try {
   const response=await fetch(url+endpoint,{method:'POST',body:'{}'});assert.equal(await response.text(),payload)
   await new Promise(r=>setImmediate(r))
   const rows=(await store.query({from:'2000-01-01T00:00:00.000Z',to:'9998-01-01T00:00:00.000Z',after:0,limit:100,account:null})).records
   assert.equal(rows.length,1)
   const terminals=published.filter(r=>['usage_attempt','request_complete'].includes(r.event));assert.equal(terminals.length,1)
   const terminal=terminals[0],row=rows[0]
   assert.equal(terminal.event,'usage_attempt');assert.equal(terminal.method,'POST');assert.equal(terminal.endpoint,endpoint)
   for(const k of ['requestId','attempt','index','alias','status','durationMs','outcome','usageStatus','provenance','modelStatus',...Object.keys(empty)]) assert.equal(terminal[k],row[k],k)
   assert.ok(!('method'in row));assert.ok(!('clientAddress'in row))
   assert.equal(logs.filter(l=>l.includes(' usage_attempt ')).length,silent?0:1)
   const summary=await store.summary(parseSummaryQuery(new URLSearchParams({from:madridDay(Date.parse(row.timestamp)),to:madridDay(Date.parse(row.timestamp))})))
   assert.equal(summary.days[0].attempts,1)
   for(const k of Object.keys(empty)) assert.deepEqual(summary.days[0].metrics[k],{sum:row[k],known:1,unknown:0})
   const model={rates:{input:.01,output:.02,cache:.001,reasoning:.03}}
   const expected=Object.fromEntries(Object.keys(empty).map(k=>[k,{sum:row[k],known:1,unknown:0}]))
   assert.deepEqual(context.RouterPricing.estimate(summary.days[0].metrics,model),context.RouterPricing.estimate(expected,model))
   if(endpoint.endsWith('completions'))assert.equal(row.reasoningTokens,0)
  } finally {await close(router);await close(a);await store.close();await rm(root,{recursive:true,force:true})}
 }
})

test('HTTP errors, partial usage, transport timeout retry and broken streams retain distinct events without duplicate terminals',async()=>{
 for(const mode of ['http_error','partial','timeout_retry','stream_error']) {
  const records=[],logs=[]
  const a=http.createServer(async(req,res)=>{
   for await(const c of req){}
   if(mode==='timeout_retry')return
   if(mode==='stream_error'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({type:'response.incomplete',response:{usage:u}})}\n\n`);setTimeout(()=>res.destroy(),20);return}
   res.writeHead(mode==='http_error'?400:200,{'content-type':'application/json'});res.end(JSON.stringify({status:'incomplete',usage:{input_tokens:0}}))
  })
  const b=http.createServer(async(req,res)=>{for await(const c of req){};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({usage:u}))})
  const ua=await listen(a),ub=await listen(b)
  const router=createRouterServer(loadConfig({UPSTREAMS:`first=${ua}|second=${ub}`,RUNTIME_FAILOVER:'true',UPSTREAM_TIMEOUT_MS:'100'}),{usageStore:{write:r=>records.push(r)},logger:createLogger({output:l=>logs.push(l)}),quotaFetchImpl:async()=>Response.json({rateLimits:null})})
  const url=await listen(router)
  try {
   const response=await fetch(url+'/v1/responses',{method:'POST',body:'{}'});await response.text().catch(()=>{})
   await new Promise(r=>setImmediate(r))
   assert.equal(records.length,mode==='timeout_retry'?2:1)
   assert.equal(logs.filter(l=>l.includes(' usage_attempt ')).length,records.length)
   assert.equal(logs.filter(l=>l.includes(' request_complete ')).length,0)
   assert.equal(new Set(records.map(r=>r.requestId+':'+r.attempt)).size,records.length)
   if(mode==='timeout_retry'){assert.deepEqual(records.map(r=>r.outcome),['transport_error','complete']);assert.equal(records[0].totalTokens,null);assert.equal(records[1].totalTokens,16);assert.ok(logs.some(l=>l.includes(' upstream_error ')))}
   else if(mode==='stream_error'){assert.equal(records[0].outcome,'interrupted');assert.equal(records[0].totalTokens,16)}
   else {assert.equal(records[0].outcome,mode==='http_error'?'http_error':'complete');assert.equal(records[0].inputTokens,0);assert.equal(records[0].totalTokens,null);assert.equal(records[0].modelStatus,'incomplete')}
  }finally{await close(router);await close(a);await close(b)}
 }
})

test('unobserved endpoint keeps request_complete; logger failure cannot prevent SQLite admission',async()=>{
 const records=[]
 const a=http.createServer(async(req,res)=>{for await(const c of req){};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({usage:u}))})
 const ua=await listen(a),events=[]
 const router=createRouterServer(loadConfig({UPSTREAMS:ua}),{usageStore:{write:r=>records.push(r)},logger:{info:(event,details)=>{events.push({event,...details});if(event==='usage_attempt')throw Error('synthetic logger failure')},warn(){},error(){}},quotaFetchImpl:async()=>Response.json({rateLimits:null})})
 const url=await listen(router)
 try {
  for(const [method,path] of [['GET','/v1/models'],['GET','/v1/responses'],['POST','/v1/responses']]){const r=await fetch(url+path,{method,...(method==='POST'?{body:'{}'}:{})});await r.text();await new Promise(r=>setImmediate(r))}
  assert.equal(events.filter(r=>r.event==='request_complete').length,2);assert.equal(events.filter(r=>r.event==='usage_attempt').length,1)
  assert.equal(records.length,1);assert.equal(records[0].totalTokens,16)
 }finally{await close(router);await close(a)}
})

test('pre-header client abort finalizes once with unknown usage and never retries',async()=>{
 const records=[],logs=[];let reached
 const entered=new Promise(r=>{reached=r});let secondCalls=0
 const a=http.createServer(async(req,res)=>{for await(const c of req){};reached()})
 const b=http.createServer((req,res)=>{secondCalls++;res.end()})
 const ua=await listen(a),ub=await listen(b)
 const router=createRouterServer(loadConfig({UPSTREAMS:`a=${ua}|b=${ub}`,RUNTIME_FAILOVER:'true'}),{usageStore:{write:r=>records.push(r)},logger:createLogger({output:l=>logs.push(l)}),quotaFetchImpl:async()=>Response.json({rateLimits:null})})
 const url=await listen(router),controller=new AbortController()
 try {
  const pending=fetch(url+'/v1/chat/completions',{method:'POST',body:'{}',signal:controller.signal}).catch(()=>{})
  await entered;controller.abort();await pending
  await new Promise((resolve,reject)=>{const end=Date.now()+1000;const check=()=>{if(records.length)resolve();else if(Date.now()>end)reject(Error('no terminal'));else setTimeout(check,10)};check()})
  assert.equal(secondCalls,0);assert.equal(records.length,1);assert.equal(records[0].outcome,'interrupted')
  assert.equal(records[0].status,null);assert.equal(records[0].totalTokens,null);assert.equal(records[0].usageStatus,'unknown');assert.equal(records[0].provenance,'none')
  assert.equal(logs.filter(l=>l.includes(' usage_attempt ')).length,1);assert.equal(logs.filter(l=>l.includes(' request_complete ')).length,0)
 }finally{await close(router);await close(a);await close(b)}
})
