import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once, EventEmitter } from 'node:events'
import { createQuotaReader, createLogHub, sanitizeLog, sanitizeRateLimits } from '../src/observability.mjs'
import { createRouterServer } from '../src/server.mjs'
import { loadConfig } from '../src/config.mjs'
const payload = { rateLimits: { primary: { usedPercent: 45, windowDurationMins: 90, resetsAt: 1234 }, secondary: null, credits: { balance: '1.25', unlimited: false, hasCredits: true } }, rateLimitsByLimitId: { codex: { primary: null }, other: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } } } }
const cfg = { upstreams: [{alias:'a',url:new URL('http://a')},{alias:'b',url:new URL('http://b')}],quotaTimeoutMs:20,quotaCacheMs:100 }
test('nullable schema, multiple limits, consumed percentage, seconds and redaction',()=>{
 const result = sanitizeRateLimits({...payload, accountId:'secret',email:'private@example.com'})
 assert.equal(result.rateLimits.primary.windowDurationMins,90)
 assert.equal(result.rateLimits.primary.resetsAt,1234)
 assert.equal(result.rateLimits.primary.usedPercent,45)
 assert.equal(result.rateLimits.credits.balance,'1.25')
 assert.equal(result.rateLimitsByLimitId.other.secondary.resetsAt,null)
 assert.equal(result.rateLimitsByLimitId.codex.primary,null)
 assert.equal(sanitizeRateLimits({rateLimits:null,rateLimitsByLimitId:null}).rateLimits,null)
 assert.throws(()=>sanitizeRateLimits({accountId:'secret'}))
 assert.ok(!JSON.stringify(result).includes('secret'))
})
test('all upstreams, partial timeout, cache, forced revalidation and inflight deduplication',async()=>{
 let calls=0,now=0
 const read=createQuotaReader(cfg,{now:()=>now,fetchImpl:async(url)=>{calls++; if(url.hostname==='b') return new Promise(()=>{}); await new Promise(r=>setTimeout(r,5)); return new Response(JSON.stringify(payload))}})
 const [a,b]=await Promise.all([read(),read({refresh:true})]); assert.deepEqual(a,b); assert.equal(calls,2)
 assert.equal(a.accounts[1].error,'TIMEOUT'); assert.equal(a.accounts[0].error,null)
 await read();assert.equal(calls,2)
 await read({refresh:true});assert.equal(calls,4)
 now=101;await read();assert.equal(calls,6)
})
test('HTTP failure and malformed data are partial safe errors',async()=>{
 const read=createQuotaReader(cfg,{fetchImpl:async(url)=>url.hostname==='a'?new Response('sensitive',{status:401}):new Response('{bad secret')})
 const result=await read();assert.equal(result.accounts[0].error,'HTTP_401');assert.equal(result.accounts[1].error,'INVALID_OR_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes('secret'))
})
class Sink extends EventEmitter { frames=[]; blocked=false; destroyed=false; writeHead(status){this.status=status} end(){this.emit('close')} write(frame){this.frames.push(frame);return !this.blocked} destroy(){this.destroyed=true;this.emit('close')} }
test('logs allowlist removes URL/query/body/token/email and bounds buffer/subscribers/backpressure',()=>{
 const hub=createLogHub({maxEntries:3,maxSubscribers:1})
 for(let i=0;i<8;i++)hub.publish('info','request_complete',{alias:'a',status:200,target:'/x?token=secret',upstream:'https://secret',body:'sensitive',authorization:'Bearer token',email:'x@y'})
 assert.equal(hub.size,3)
 const a=new Sink();hub.connect(a);assert.equal(a.frames.length,3);assert.equal(hub.subscriberCount,1)
 assert.ok(!a.frames.join('').includes('secret'));assert.ok(!a.frames.join('').includes('sensitive'))
 const b=new Sink();hub.connect(b);assert.equal(b.status,503)
 a.blocked=true;hub.publish('warn','upstream_error',{});assert.equal(hub.subscriberCount,0);assert.equal(a.destroyed,true)
 const c=new Sink();hub.connect(c);c.emit('close');assert.equal(hub.subscriberCount,0)
 assert.equal(sanitizeLog('info','<script>',{alias:'Bearer-secret'}).event,'redacted_event')
})
test('router APIs public, proxy protected, Origin checked, open circuits included without changing status; streaming abort cleans subscriber',async(t)=>{
 const hub=createLogHub();let calls=0
 const upstream=http.createServer((_req,res)=>{res.writeHead(500);res.end('runtime failure')})
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening')
 t.after(()=>{upstream.closeAllConnections();upstream.close()})
 const config=loadConfig({UPSTREAMS:`a=http://127.0.0.1:${upstream.address().port}|b=http://b`,ROUTER_API_KEY:'test-key'})
 const server=createRouterServer(config,{logHub:hub,quotaFetchImpl:async()=>{calls++;return new Response(JSON.stringify(payload))}})
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`
 t.after(()=>{server.closeAllConnections();server.close()})
 // Open through real runtime failures, not a removed startup-state injection.
 for(let i=0;i<3;i++) { const r=await fetch(base+'/v1/models',{headers:{authorization:'Bearer test-key'}});assert.equal(r.status,500);await r.arrayBuffer() }
 assert.equal((await fetch(base+'/router/accounts/rate-limits')).status,200)
 assert.equal((await fetch(base+'/v1/models')).status,401)
 const headers={}
 assert.equal((await fetch(base+'/router/logs',{headers:{...headers,origin:'https://evil.example'}})).status,403)
 assert.equal((await fetch(base+'/router/logs?token=test-key',{headers})).status,404)
 const before=await(await fetch(base+'/router/status',{headers})).json()
 const result=await(await fetch(base+'/router/accounts/rate-limits',{headers})).json()
 assert.equal(result.accounts[0].circuit.state,'open');assert.equal(result.accounts.length,2);assert.equal(calls,2)
 for(const c of result.accounts.map(a=>a.circuit)) {
  assert.equal(typeof c.failures,'number');assert.equal(typeof c.clientErrors,'number')
  assert.equal(typeof c.remainingMs,'number');assert.equal(typeof c.probeInFlight,'boolean')
 }
 assert.equal(result.accounts[0].circuit.failures,3)
 assert.equal(result.accounts[0].circuit.clientErrors,0)
 assert.ok(result.accounts[0].circuit.remainingMs>0)
 assert.equal(result.accounts[0].circuit.disabledUntil,before.upstreams[0].disabledUntil)
 assert.equal(result.accounts[1].circuit.state,'closed')
 assert.equal(result.accounts[1].circuit.disabledUntil,null)
 assert.equal(result.accounts[1].circuit.remainingMs,0)
 const after=await(await fetch(base+'/router/status',{headers})).json();assert.equal(before.upstreams[0].failures,after.upstreams[0].failures)
 assert.equal(before.upstreams[0].disabledUntil,after.upstreams[0].disabledUntil)
 hub.publish('info','test',{});const controller=new AbortController()
 const stream=await fetch(base+'/router/logs',{headers,signal:controller.signal});const reader=stream.body.getReader();await reader.read();assert.equal(hub.subscriberCount,1);controller.abort()
 for(let i=0;i<20&&hub.subscriberCount;i++)await new Promise(r=>setTimeout(r,10))
 assert.equal(hub.subscriberCount,0)
 const health=await(await fetch(base+'/health')).json();assert.deepEqual(health,{status:'ok',upstreams:2})
})
test('observation is public when legacy proxy lacks key',async(t)=>{
 const server=createRouterServer(loadConfig({}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/router/accounts/rate-limits`)).status,200)
})
test('quota without internal key calls every upstream without Authorization',async()=>{
 let calls=0
 const read=createQuotaReader(cfg,{fetchImpl:async(url,options)=>{
  calls++;assert.equal(new Headers(options.headers).has('authorization'),false)
  assert.equal(url.pathname,'/oauth/rate-limits')
  return Response.json(payload)
 }})
 const result=await read();assert.equal(calls,2)
 for(const account of result.accounts){assert.equal(account.error,null);assert.equal(account.rateLimits.rateLimits.primary.usedPercent,45)}
})
test('log hub shutdown destroys every viewer',()=>{
 const hub=createLogHub();const a=new Sink(),b=new Sink();hub.connect(a);hub.connect(b);hub.close()
 assert.equal(hub.subscriberCount,0);assert.ok(a.destroyed&&b.destroyed)
})
test('stdout redacts hostile event progress and all sensitive details',async()=>{
 const {createLogger}=await import('../src/logger.mjs');const lines=[],records=[]
 const logger=createLogger({output:line=>lines.push(line),onRecord:(...args)=>records.push(args)})
 logger.info('request_complete',{requestId:'1234-abcd',method:'GET',target:'/v1?token=private',body:'private',response:'private',model:'private',authorization:'Bearer private',upstream:'http://private',alias:'a',status:200})
 logger.warn('bad\nevent',{alias:'sk-private',logProgress:'\nprivate',error:'Bearer-private'})
 assert.ok(!lines.join('').includes('private'));assert.ok(!JSON.stringify(records).includes('private'));assert.match(lines[0],/1234-abcd/);assert.match(lines[1],/redacted_event/)
})
test('real local quota HTTP mocks partial failures and web CSP',async(t)=>{
 const mocks=[];let calls=0
 for(const status of [200,503]){
  const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/oauth/rate-limits');assert.equal(req.headers.authorization,undefined);res.writeHead(status,{'content-type':'application/json'});res.end(status===200?JSON.stringify(payload):'private-body')})
  server.listen(0,'127.0.0.1');await once(server,'listening');mocks.push(server)
 }
 t.after(()=>mocks.forEach(s=>{s.closeAllConnections();s.close()}))
 const config=loadConfig({UPSTREAMS:mocks.map((s,i)=>`account-${i}=http://127.0.0.1:${s.address().port}`).join('|'),ROUTER_API_KEY:'mock-router'})
 const hub=createLogHub();const server=createRouterServer(config,{logHub:hub});server.listen(0,'127.0.0.1');await once(server,'listening')
 t.after(()=>{hub.close();server.closeAllConnections();server.close()})
 const base=`http://127.0.0.1:${server.address().port}`
 for(const path of ['/router/','/router/app.js','/router/style.css']){const r=await fetch(base+path);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('cache-control'),'no-store')}
 const r=await fetch(base+'/router/accounts/rate-limits?refresh=1',{headers:{authorization:'Bearer mock-router'}})
 const result=await r.json();assert.equal(result.accounts[0].error,null);assert.equal(result.accounts[1].error,'HTTP_503');assert.equal(calls,2);assert.ok(!JSON.stringify(result).includes('private'))
 const big=createQuotaReader({...cfg,upstreams:[cfg.upstreams[0]]},{fetchImpl:async()=>new Response('x'.repeat(262145))});assert.equal((await big()).accounts[0].error,'INVALID_OR_UNAVAILABLE')
})
test('empty log viewer immediately receives SSE headers before any event',async(t)=>{
 const hub=createLogHub();const server=createRouterServer(loadConfig({ROUTER_API_KEY:'test-key'}),{logHub:hub})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{hub.close();server.closeAllConnections();server.close()})
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),500)
 try {const r=await fetch(`http://127.0.0.1:${server.address().port}/router/logs`,{headers:{authorization:'Bearer test-key'},signal:controller.signal});assert.equal(r.status,200);assert.equal(hub.subscriberCount,1)}finally{clearTimeout(timer);controller.abort()}
})
test('malformed nested quota schema fails rather than implying successful zero quota',()=>{
 for(const value of [{rateLimits:[]},{rateLimits:{primary:[]}},{rateLimitsByLimitId:[]},{rateLimitsByLimitId:{a:false}}])assert.throws(()=>sanitizeRateLimits(value))
})

test('SSE stable unique IDs, exact cursor replay and unknown/evicted epoch fallback',()=>{
 const hub=createLogHub({maxEntries:3});
 for(let i=0;i<3;i++)hub.publish('info','same',{});
 const first=new Sink();hub.connect(first);
 const ids=first.frames.map(frame=>/^id: (.+)\n/.exec(frame)[1]);
 assert.equal(new Set(ids).size,3);
 const replay=new Sink();hub.connect(replay);assert.deepEqual(replay.frames,first.frames);
 const cursor=new Sink();hub.connect(cursor,ids[1]);assert.deepEqual(cursor.frames,[first.frames[2]]);
 hub.publish('info','same',{});
 const evicted=new Sink();hub.connect(evicted,ids[0]);assert.equal(evicted.frames.length,3);
 const unknown=new Sink();hub.connect(unknown,'other-epoch:1');assert.deepEqual(unknown.frames,evicted.frames);
 const other=createLogHub();other.publish('info','same',{});const restarted=new Sink();other.connect(restarted);
 assert.notEqual(/^id: (.+)\n/.exec(restarted.frames[0])[1],ids[0]);
 hub.close();other.close();assert.equal(hub.subscriberCount,0);
});

test('SSE ID metadata does not reduce existing accepted data frame byte budget',()=>{
 const bytes=Buffer.byteLength(`data: ${JSON.stringify(sanitizeLog('info','same',{}))}\n\n`);
 const hub=createLogHub({maxFrameBytes:bytes});hub.publish('info','same',{});
 assert.equal(hub.size,1);const sink=new Sink();hub.connect(sink);
 assert.ok(Buffer.byteLength(sink.frames[0])>bytes);hub.close();
});

test('clientAddress validates socket IP/port and JSON -> SSE retains only real IP values',async()=>{
 const {formatClientAddress,sanitizeClientAddress}=await import('../src/client-address.mjs')
 const {createLogger}=await import('../src/logger.mjs')
 const cases=[['192.0.2.1',12345,'192.0.2.1:12345'],['::ffff:192.0.2.1',5000,'192.0.2.1:5000'],['2001:db8::1',5000,'[2001:db8::1]:5000'],['::1',80,'::1'],['::1',443,'::1'],['192.0.2.1',80,'192.0.2.1'],['192.0.2.1',443,'192.0.2.1'],['192.0.2.1',undefined,'192.0.2.1'],['2001:db8::1',undefined,'2001:db8::1'],['192.0.2.1',0,'192.0.2.1'],['192.0.2.1','5000','192.0.2.1'],['unknown',1234,undefined],[undefined,1234,undefined]]
 const hub=createLogHub(),lines=[],logger=createLogger({output:line=>lines.push(line),onRecord:hub.publish})
 for(const [ip,port,expected] of cases){
  const address=formatClientAddress(ip,port);assert.equal(address,expected)
  if(expected)assert.equal(sanitizeClientAddress(address),expected)
  logger.info('request_complete',{requestId:'abc',clientAddress:address,body:'PRIVATE'})
 }
 for(const bad of ['evil.example:123','unknown','<script>1</script>','127.0.0.1:123\ndata: secret','999.1.1.1:1','[1:2:3]:5','[::1]:65536','[::1]:0','[::1]','fe80::1%eth0','http://127.0.0.1','127.0.0.1:123?secret',{},'x'.repeat(100)]){
  assert.equal(sanitizeClientAddress(bad),undefined)
  assert.equal(sanitizeLog('info','request_complete',{clientAddress:bad}).clientAddress,undefined)
 }
 const sink=new Sink();hub.connect(sink)
 const records=sink.frames.map(frame=>JSON.parse(frame.split('data: ')[1]))
 for(let i=0;i<cases.length;i++){
  assert.equal(records[i].clientAddress,cases[i][2])
  assert.equal(JSON.parse(lines[i].slice(lines[i].indexOf('{'))).clientAddress,cases[i][2])
 }
 assert.ok(!sink.frames.join('').includes('PRIVATE'));hub.close()
})
