import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {loadConfig} from '../src/config.mjs'
import {createCircuitBreaker,createRouterServer} from '../src/server.mjs'
import {createQuotaReader,quotaBlockedUntil} from '../src/observability.mjs'
const now=Date.parse('2026-10-25T00:30:00Z')
const account=(usedPercent=100,resetsAt=(now+3600000)/1000)=>({error:null,rateLimits:{rateLimits:{primary:{usedPercent,resetsAt},secondary:{usedPercent:0,resetsAt}}}})
const logger={info(){},warn(){},error(){}}
const setup=t=>{
 t.mock.timers.enable({apis:['Date'],now})
 let data={accounts:[account()]}
 const config=loadConfig({UPSTREAMS:'a=http://a',UPSTREAM_FAILURE_THRESHOLD:'1'})
 const cb=createCircuitBreaker(config,logger,()=>data)
 return {cb,set:v=>{data=v}}
}
test('quota zero valid Unix reset uses exact seconds across DST, strict unknown handling',()=>{
 assert.equal(quotaBlockedUntil(account(),now),now+3600000)
 for(const reset of [null,undefined,'1792888200',NaN,Infinity,1e20,now/1000,(now-1)/1000]){ const a=account();a.rateLimits.rateLimits.primary.resetsAt=reset;assert.equal(quotaBlockedUntil(a,now),0) }
 for(const used of [null,undefined,'100',101,-1,99,NaN]){ const a=account();a.rateLimits.rateLimits.primary.usedPercent=used;assert.equal(quotaBlockedUntil(a,now),0) }
 assert.equal(quotaBlockedUntil({...account(),error:'HTTP_500'},now),0)
 const a=account();a.rateLimits.rateLimits.secondary={usedPercent:100,resetsAt:(now+7200000)/1000}
 assert.equal(quotaBlockedUntil(a,now),now+7200000)
 assert.equal(quotaBlockedUntil({rateLimits:{rateLimitsByLimitId:{model:account().rateLimits.rateLimits}}},now),0)
})
test('quota expiry recovery single probe and stale-generation success cannot close',t=>{
 const {cb,set}=setup(t)
 set({accounts:[account(20)]});const old=cb.acquire(0,'old')
 set({accounts:[account()]});assert.equal(cb.acquire(0,'blocked').allowed,false)
 cb.succeeded(0,'old',old);assert.equal(cb.snapshot()[0].state,'open')
 t.mock.timers.setTime(now+3600001)
 assert.equal(cb.snapshot()[0].state,'half_open')
 const probe=cb.acquire(0,'probe');assert.equal(probe.recoveryProbe,true)
 assert.equal(cb.acquire(0,'parallel').allowed,false)
 cb.succeeded(0,'old',old);assert.equal(cb.snapshot()[0].state,'half_open')
 assert.equal(cb.failed(0,'old',old,'HTTP_500').ignored,true)
 assert.equal(cb.clientDisconnected(0,'old',old,'ECONNRESET').ignored,true)
 cb.succeeded(0,'probe',probe);assert.equal(cb.snapshot()[0].state,'closed')
 assert.equal(cb.acquire(0,'after').allowed,true) // expired snapshot cannot re-block
})
test('fresh positive quotas never close generic breaker; 500 invents no quota and retains fallback',t=>{
 const {cb,set}=setup(t);set({accounts:[account(10)]})
 const r=cb.acquire(0,'one');cb.failed(0,'one',r,'HTTP_500')
 assert.equal(cb.snapshot()[0].disabledUntil,new Date(now+600000).toISOString())
 set({accounts:[account(0)]});assert.equal(cb.acquire(0,'two').allowed,false)
 t.mock.timers.setTime(now+600001);assert.equal(cb.acquire(0,'probe').recoveryProbe,true)
})
test('missing malformed past and stale quotas preserve generic recovery fallback',t=>{
 const {cb,set}=setup(t)
 for(const a of [null,account(100,null),account(100,'later'),account(100,now/1000)]){
  set({accounts:[a]});assert.equal(cb.acquire(0,'available').allowed,true)
 }
 set(null);const r=cb.acquire(0,'failure');cb.failed(0,'failure',r,'ECONNREFUSED')
 assert.equal(cb.snapshot()[0].remainingMs,600000)
})
test('confirmed quota survives failed/stale reads but expired reset never extends block',t=>{
 const {cb,set}=setup(t);cb.acquire(0,'block')
 set(null);t.mock.timers.setTime(now+600000);assert.equal(cb.acquire(0,'skip').remainingMs,3000000)
 t.mock.timers.setTime(now+3600001);set({accounts:[account()]})
 const p=cb.acquire(0,'probe');cb.failed(0,'probe',p,'HTTP_500')
 assert.equal(cb.snapshot()[0].remainingMs,600000)
})
test('quota reader stale cache is not gating evidence, dedup and timeout remain bounded',async()=>{
 let clock=now,calls=0
 const read=createQuotaReader({upstreams:[{alias:'a',url:new URL('http://a')}],quotaCacheMs:100,quotaTimeoutMs:10},{now:()=>clock,fetchImpl:async()=>{calls++;return Response.json({rateLimits:account().rateLimits.rateLimits})}})
 await Promise.all([read(),read()]);assert.equal(calls,1);assert.ok(read.peek())
 clock+=100;assert.equal(read.peek(),null);await read();assert.equal(calls,2)
 const timeout=createQuotaReader({upstreams:[{alias:'a',url:new URL('http://a')}],quotaTimeoutMs:5},{fetchImpl:()=>new Promise(()=>{})})
 assert.equal((await timeout()).accounts[0].error,'TIMEOUT')
})
test('routing independent of UI, ordered next and all blocked Retry-After, shared observation read-only',async t=>{
 const mocks=[],counts=[0,0],quotaCounts=[0,0];let all=false
 for(let i=0;i<2;i++){
  const s=http.createServer((req,res)=>{
   res.setHeader('content-type','application/json')
   if(req.url==='/oauth/rate-limits'){
    quotaCounts[i]++;assert.equal(req.headers.authorization,undefined)
    res.end(JSON.stringify({rateLimits:{primary:{usedPercent:i===0||all?100:0,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:0}}}))
   }else{counts[i]++;res.end(JSON.stringify({ok:true}))}
  });s.listen(0,'127.0.0.1');await once(s,'listening');mocks.push(s)
 }
 const config=loadConfig({UPSTREAMS:mocks.map((s,i)=>`a${i}=http://127.0.0.1:${s.address().port}`).join('|'),ROUTER_API_KEY:'test'})
 const router=createRouterServer(config);router.listen(0,'127.0.0.1');await once(router,'listening')
 t.after(()=>{for(const s of [router,...mocks]){s.closeAllConnections();s.close()}})
 const base=`http://127.0.0.1:${router.address().port}`
 assert.equal((await fetch(base+'/router')).status,200)
 assert.deepEqual(quotaCounts,[0,0])
 assert.equal((await fetch(base+'/v1/models')).status,401)
 const opts={headers:{authorization:'Bearer test'}}
 const r=await fetch(base+'/v1/models',opts);assert.equal(r.headers.get('x-router-upstream-index'),'2')
 await r.arrayBuffer();assert.deepEqual(counts,[0,1]);assert.deepEqual(quotaCounts,[1,1])
 await fetch(base+'/v1/models',opts);assert.deepEqual(quotaCounts,[1,1])
 all=true
 const q=await(await fetch(base+'/router/accounts/rate-limits?refresh=1')).json()
 assert.equal(q.accounts[0].circuit.state,'open');assert.equal(q.accounts[1].circuit.state,'open')
 const denied=await fetch(base+'/v1/models',opts);assert.equal(denied.status,503)
 assert.ok(Number(denied.headers.get('retry-after'))>=3598)
 assert.deepEqual(counts,[0,2])
 const status=await(await fetch(base+'/router/status')).json()
 assert.ok(status.upstreams.every(c=>c.failures===0&&c.clientErrors===0&&!c.probeInFlight))
})

test('ECONNRESET without valid quota keeps distinct-request threshold and recovery cooldown',t=>{
 const {cb,set}=setup(t);set(null)
 for(let i=0;i<5;i++){
  const r=cb.acquire(0,`reset-${i}`);assert.equal(r.allowed,true)
  cb.clientDisconnected(0,`reset-${i}`,r,'ECONNRESET')
 }
 assert.equal(cb.snapshot()[0].remainingMs,600000)
 assert.equal(cb.snapshot()[0].clientErrors,5)
 t.mock.timers.setTime(now+600001)
 assert.equal(cb.acquire(0,'recovery').recoveryProbe,true)
})

const both = (primary, secondary, pReset = now + 7200000, sReset = now + 3600000) => {
 const a = account(primary, pReset / 1000)
 a.rateLimits.rateLimits.secondary = {usedPercent: secondary, resetsAt: sReset / 1000}
 return a
}
test('weekly precedence is explicit, not maximum timestamp; unknown weekly is not positive', () => {
 for (const [p,s,expected] of [[0,0,0],[100,0,now+7200000],[0,100,now+3600000],[100,100,now+3600000]]) {
  assert.equal(quotaBlockedUntil(both(p,s),now),expected)
 }
 for (const s of [null,undefined,'0',NaN,Infinity,-1,101]) assert.equal(quotaBlockedUntil(both(100,s),now),0)
 for (const reset of [null,undefined,'1792888200',NaN,Infinity,1e20,now/1000]) {
  const a=both(100,100);a.rateLimits.rateLimits.secondary.resetsAt=reset
  assert.equal(quotaBlockedUntil(a,now),0) // no primary fallback for exhausted weekly
 }
})
test('fresh both positive releases quota-only latch, readonly snapshot agrees and old success cannot close new block',t=>{
 const {cb,set}=setup(t)
 cb.acquire(0,'block');set({accounts:[both(0,0)]})
 const view=cb.snapshot()[0];assert.equal(view.state,'closed');assert.equal(view.recoveryOrigin,null)
 const r=cb.acquire(0,'available');assert.equal(r.recoveryProbe,false)
 t.mock.timers.setTime(now+3600001)
 set({accounts:[both(100,0,now+7200000)]});assert.equal(cb.acquire(0,'new-block').allowed,false)
 cb.succeeded(0,'available',r);assert.equal(cb.snapshot()[0].state,'open')
 set({accounts:[both(0,0)]});assert.equal(cb.snapshot()[0].state,'closed')
 assert.equal(cb.acquire(0,'released').recoveryProbe,false)
})
test('unknown partial invalid and stale evidence cannot release a quota latch; positive does not need future reset',t=>{
 const {cb,set}=setup(t);cb.acquire(0,'block')
 const partial=both(0,0);partial.rateLimits.rateLimits.secondary=null
 for(const a of [null,partial,both(null,0),both(-1,0),both(0,101),{...both(0,0),error:'TIMEOUT'}]) {
  set({accounts:[a]});assert.equal(cb.snapshot()[0].state,'open');assert.equal(cb.acquire(0,'skip').allowed,false)
 }
 set(null);assert.equal(cb.snapshot()[0].state,'open')
 set({accounts:[both(0,0,now-1000,now-1000)]});assert.equal(cb.acquire(0,'positive').recoveryProbe,false)
})
test('generic half-open stays real despite both positive and panel retains origin and single probe',t=>{
 const {cb,set}=setup(t);set({accounts:[both(0,0)]})
 const r=cb.acquire(0,'fail');cb.failed(0,'fail',r,'HTTP_500')
 assert.equal(cb.snapshot()[0].recoveryOrigin,'generic')
 t.mock.timers.setTime(now+600001)
 assert.equal(cb.snapshot()[0].state,'half_open')
 const p=cb.acquire(0,'probe');set({accounts:[both(0,0)]})
 assert.equal(cb.snapshot()[0].state,'half_open');assert.equal(cb.acquire(0,'parallel').allowed,false)
 cb.succeeded(0,'probe',p);assert.equal(cb.snapshot()[0].state,'closed')
})
test('quota refresh never detaches active probe, reblock invalidates it but waits for settlement',t=>{
 const {cb,set}=setup(t);cb.acquire(0,'block')
 t.mock.timers.setTime(now+3600001)
 const p=cb.acquire(0,'probe');set({accounts:[both(0,0)]})
 assert.equal(cb.snapshot()[0].state,'half_open');assert.equal(cb.snapshot()[0].probeInFlight,true)
 assert.equal(cb.acquire(0,'parallel').allowed,false)
 set({accounts:[both(100,0,now+7200000)]});assert.equal(cb.acquire(0,'reblock').allowed,false)
 set({accounts:[both(0,0)]});assert.equal(cb.acquire(0,'still-blocked').allowed,false)
 cb.succeeded(0,'obsolete-probe',p)
 assert.equal(cb.snapshot()[0].probeInFlight,false)
 assert.equal(cb.acquire(0,'released').recoveryProbe,false)
})
test('fresh deadline replaces latched primary with earlier weekly reset in snapshots and routing',t=>{
 const {cb,set}=setup(t);set({accounts:[both(100,0)]});cb.acquire(0,'primary')
 set({accounts:[both(100,100)]})
 assert.equal(cb.snapshot()[0].disabledUntil,new Date(now+3600000).toISOString())
 assert.equal(cb.acquire(0,'weekly').remainingMs,3600000)
})

test('manual fresh positive snapshot releases effective quota without reserving, then routing selects same upstream',async t=>{
 let exhausted=true,quotaCalls=0,traffic=0
 const upstream=http.createServer((req,res)=>{traffic++;res.end('ok')})
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening')
 const config=loadConfig({UPSTREAMS:`a=http://127.0.0.1:${upstream.address().port}`})
 const router=createRouterServer(config,{quotaFetchImpl:async()=>{
  quotaCalls++;return Response.json({rateLimits:{primary:{usedPercent:exhausted?100:0,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:0,resetsAt:Math.floor(Date.now()/1000)+604800}}})
 }})
 router.listen(0,'127.0.0.1');await once(router,'listening')
 t.after(()=>{for(const s of [router,upstream]){s.closeAllConnections();s.close()}})
 const base=`http://127.0.0.1:${router.address().port}`
 assert.equal((await fetch(base+'/v1/models')).status,503)
 exhausted=false
 const refreshed=await(await fetch(base+'/router/accounts/rate-limits?refresh=1')).json()
 assert.equal(refreshed.accounts[0].circuit.state,'closed')
 assert.equal(refreshed.accounts[0].circuit.probeInFlight,false)
 const status=await(await fetch(base+'/router/status')).json()
 assert.equal(status.upstreams[0].state,'closed');assert.equal(traffic,0)
 assert.equal((await fetch(base+'/v1/models')).status,200)
 assert.equal(traffic,1);assert.equal(quotaCalls,2)
})
