import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {parseSummaryQuery} from '../src/usage-summary.mjs'
import {createUsageStore} from '../src/usage-store.mjs'
import {createRouterServer} from '../src/server.mjs'
import {loadConfig} from '../src/config.mjs'
const query=(from,to=from,account)=>parseSummaryQuery(new URLSearchParams({from,to,...(account?{account}:{})}))
const record=(n,timestamp,alias='old',fields={})=>({timestamp,requestId:'00000000-0000-0000-0000-000000000001',attempt:n,index:1,alias,endpoint:'/v1/responses',outcome:'complete',usageStatus:'upstream_reported',provenance:'responses_upstream_reported',modelStatus:'completed',inputTokens:0,outputTokens:null,totalTokens:null,cachedTokens:null,reasoningTokens:null,...fields})
test('Madrid DST bounds, inclusive days, defaults and strict parameters',()=>{
 for(const [day,hours,start,end] of [['2026-03-29',23,'2026-03-28T23:00:00.000Z','2026-03-29T22:00:00.000Z'],['2026-10-25',25,'2026-10-24T22:00:00.000Z','2026-10-25T23:00:00.000Z']]) {
  const d=query(day).days[0];assert.equal(d.from,start);assert.equal(d.to,end);assert.equal((Date.parse(d.to)-Date.parse(d.from))/3600000,hours)
 }
 const d=parseSummaryQuery(new URLSearchParams(),Date.parse('2026-10-07T22:30:00Z'));
 assert.equal(d.days.length,30);assert.equal(d.to,'2026-10-08');assert.equal(d.from,'2026-09-09')
 assert.equal(query('2026-10-01','2026-10-31').days.length,31)
 for(const suffix of ['from=2026-02-30','from=2026-10-01&to=2026-11-01','from=2026-10-07&to=2026-10-06','sql=x','path=/tmp','limit=500','account=../x','account=a&account=b','to=bad']) assert.throws(()=>parseSummaryQuery(new URLSearchParams(suffix)))
})
test('worker aggregates all attempts beyond 500 rows, null/zero per metric, historical accounts, DST boundaries and dedupe',async()=>{
 const root=await mkdtemp(join(tmpdir(),'summary-'));const store=createUsageStore(join(root,'usage.sqlite'));
 try {
  for(let n=1;n<=510;n++) {store.write(record(n,'2026-10-25T01:30:00.000Z','old',{outputTokens:2,totalTokens:2}));if(n%100===0) await store.summary(query('2026-10-25'))}
  store.write(record(1,'2026-10-25T01:30:00.000Z')); // duplicate identity
  store.write(record(511,'2026-10-24T22:00:00.000Z','current',{inputTokens:null,outcome:'interrupted',modelStatus:'incomplete'}));
  store.write(record(512,'2026-10-25T22:59:59.999Z','old',{inputTokens:null}));
  store.write(record(513,'2026-10-25T23:00:00.000Z','old',{inputTokens:9}));
  const result=await store.summary(query('2026-10-25','2026-10-27'));
  assert.deepEqual(result.accounts,['current','old']);assert.equal(result.days[0].attempts,512);assert.equal(result.days[0].incomplete,1)
  assert.deepEqual(result.days[0].metrics.inputTokens,{sum:0,known:510,unknown:2});assert.deepEqual(result.days[0].metrics.outputTokens,{sum:1020,known:510,unknown:2});assert.equal(result.days[0].metrics.cachedTokens.sum,null)
  assert.equal(result.days[1].metrics.inputTokens.sum,9);assert.equal(result.days[2].attempts,0);assert.deepEqual(result.days[2].metrics.totalTokens,{sum:null,known:0,unknown:0})
  assert.equal((await store.summary(query('2026-10-25','2026-10-25','old'))).days[0].attempts,511)
  assert.equal((await store.summary(query('2026-10-25','2026-10-25','absent'))).days[0].attempts,0)
  assert.doesNotMatch(JSON.stringify(result),/requestId|endpoint|provenance|sqlite|00000000/)
  store.write(record(514,'2026-03-28T23:00:00.000Z'));store.write(record(515,'2026-03-29T21:59:59.999Z'));store.write(record(516,'2026-03-29T22:00:00.000Z'));
  assert.equal((await store.summary(query('2026-03-29'))).days[0].attempts,2)
 }finally {await store.close();await rm(root,{recursive:true,force:true})}
})
test('HTTP summary is public Origin protected, capped, sanitized errors; no quota fetch',async()=>{
 let calls=0,fail=false;
 const server=createRouterServer(loadConfig({UPSTREAMS:'configured=http://127.0.0.1:1',ROUTER_API_KEY:'synthetic'}),{usageStore:{summary:async q=>{calls++;if(fail) throw Error('PRIVATE_PATH');return {days:q.days,accounts:['old']}},health:()=>({available:true})},quotaFetchImpl:()=>{throw Error('quota must not run')}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const r=await fetch(base+'/router/usage/summary');assert.equal(r.status,200);assert.equal((await r.json()).days.length,30);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/)
  assert.equal((await fetch(base+'/router/usage/summary',{headers:{Origin:'https://evil.example'}})).status,403)
  for(const qs of ['sql=x','account=../bad','limit=501','from=2026-01-01&to=2026-03-01','account=a&account=b']) assert.equal((await fetch(base+'/router/usage/summary?'+qs)).status,400)
  assert.equal(calls,1);assert.equal((await fetch(base+'/v1/models')).status,401)
  const asset=await fetch(base+'/router/usage-chart.js');assert.equal(asset.status,200);assert.match(await asset.text(),/createElementNS/)
  fail=true;const err=await fetch(base+'/router/usage/summary');assert.equal(err.status,503);assert.doesNotMatch(await err.text(),/PRIVATE_PATH/)
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
 const broken=createUsageStore('/dev/null/private.sqlite');try {await assert.rejects(broken.summary(query('2026-10-25')))}finally{await broken.close().catch(()=>{})}
})
