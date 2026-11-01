import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import http from 'node:http'
import {readFile} from 'node:fs/promises'
import {once} from 'node:events'
import {createPricingReader,normalizeModel,CATALOG_URL,FX_URL} from '../src/pricing-catalog.mjs'
import {createRouterServer} from '../src/server.mjs'
import {loadConfig} from '../src/config.mjs'
const epoch=Date.parse('2026-10-08T17:00:00Z')
const raw=(id='model',extra={})=>({id,provider:'openai',mode:'chat',input_cost_per_token:0.001,output_cost_per_token:0.002,cache_read_input_token_cost:0.0001,...extra})
const catalog=(data=[raw()])=>Object.fromEntries(data.map(({id,provider,...m})=>[id,{...m,litellm_provider:provider}]))
const fx={base:'USD',quote:'EUR',date:'2026-10-08',rate:0.89397}
test('numeric rates preserve null and zero; allow only token-priced LLMs',()=>{
 for(const v of [null,undefined,'0',-1,Infinity,NaN])assert.equal(normalizeModel(raw('m',{input_cost_per_token:v})).rates.input,null)
 assert.equal(normalizeModel(raw('m',{input_cost_per_token:0})).rates.input,0)
 for(const mode of ['embedding','image_generation','audio_transcription',null])assert.equal(normalizeModel(raw('m',{mode})),null)
 assert.ok(normalizeModel(raw('m',{mode:'completion'})))
 assert.equal(normalizeModel(raw('m',{input_cost_per_token:null,output_cost_per_token:null})),null)
})
test('official LiteLLM dictionary loads text/plain over HTTP above the former page size limit',async t=>{
 const data={sample_spec:{litellm_provider:'example',mode:'chat',input_cost_per_token:0},...catalog([raw('a'),raw('image',{mode:'image_generation'}),raw('other/b',{provider:'other',mode:'completion'})])};
 data.a.id='FORGED_ID';data.a.provider='FORGED_PROVIDER';
 const body=JSON.stringify(data)+' '.repeat(2*1024*1024);
 const requests=[];
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,undefined);
  res.setHeader('content-type',req.url==='/fx'?'application/json':'text/plain; charset=utf-8');
  res.end(req.url==='/fx'?JSON.stringify(fx):body);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const read=createPricingReader({now:()=>epoch,fetchImpl:(url,opts)=>{requests.push(url);return fetch(base+(url===FX_URL?'/fx':'/catalog'),opts)}});
 const d=await read();assert.ok(d.catalog,'the official JSON catalog must populate the model selector');
 assert.equal(CATALOG_URL,'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json');
 assert.deepEqual(requests.sort(),[CATALOG_URL,FX_URL].sort());
 assert.deepEqual(d.catalog.models,[normalizeModel(raw('a')),normalizeModel(raw('other/b',{provider:'other',mode:'completion'}))]);
 assert.equal(d.catalog.source,CATALOG_URL);assert.equal(d.catalog.currency,'USD');assert.equal(d.fx.rate,fx.rate);
});
test('HTTP MIME allowance is catalog-only; declared and streamed byte limits remain enforced',async t=>{
 let current;
 const server=http.createServer((req,res)=>{
  const isFX=req.url==='/fx',body=JSON.stringify(isFX?fx:catalog());
  res.setHeader('content-type',isFX?(current.fxType??'application/json'):current.catalogType);
  if(!current.chunked)res.setHeader('content-length',Buffer.byteLength(body));
  else res.write(body.slice(0,1));
  res.end(current.chunked?body.slice(1):body);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const scenario of [
  {catalogType:'text/plain',fxType:'text/plain',catalogOK:true,fxOK:false},
  {catalogType:'application/json',catalogOK:true,fxOK:true},
  {catalogType:'text/html',catalogOK:false,fxOK:true},
  {catalogType:'text/plain',limit:16,catalogOK:false,fxOK:true},
  {catalogType:'text/plain',limit:16,chunked:true,catalogOK:false,fxOK:true},
 ]) {
  current=scenario;
  const read=createPricingReader({now:()=>epoch,maxCatalogBytes:scenario.limit,fetchImpl:(url,opts)=>fetch(base+(url===FX_URL?'/fx':'/catalog'),opts)});
  const d=await read();
  assert.equal(Boolean(d.catalog),scenario.catalogOK,JSON.stringify(scenario));
  assert.equal(Boolean(d.fx),scenario.fxOK,JSON.stringify(scenario));
 }
});
test('rejected catalog and FX headers cancel unfinished HTTP bodies',async t=>{
 for(const rejectedPath of ['/catalog','/fx']) for(const reason of ['http','type','size']) await t.test(`${rejectedPath} ${reason}`,async t=>{
  let closed=false,notifyClose;
  const closedResponse=new Promise(resolve=>notifyClose=resolve);
  const server=http.createServer((req,res)=>{
   if(req.url!==rejectedPath) {res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/fx'?fx:catalog()));return;}
   res.writeHead(reason==='http'?429:200,{'content-type':reason==='type'?'text/html':'application/json',...(reason==='size'?{'content-length':'8388609'}:{})});
   res.once('close',()=>{closed=true;notifyClose();});res.flushHeaders();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
  const base=`http://127.0.0.1:${server.address().port}`;
  const read=createPricingReader({now:()=>epoch,timeoutMs:1000,fetchImpl:(url,opts)=>fetch(base+(url===FX_URL?'/fx':'/catalog'),opts)});
  const d=await read();assert.equal(d[rejectedPath==='/fx'?'fx':'catalog'],null);
  assert.ok(d[rejectedPath==='/fx'?'catalog':'fx']);
  let timer;try {await Promise.race([closedResponse,new Promise(resolve=>timer=setTimeout(resolve,250))]);}
  finally {clearTimeout(timer);}
  assert.equal(closed,true,'invalid metadata must release its connection before the supplier finishes its body');
 });
});
test('dictionary normalization, sanitized allowlist, success TTL and single flight',async()=>{
 let now=epoch,calls=[]
 const read=createPricingReader({now:()=>now,catalogTTL:100,fxTTL:50,fetchImpl:async(url,opts)=>{
  calls.push(url);assert.deepEqual(opts.headers,{accept:'application/json'});assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit')
  if(url===FX_URL)return Response.json(fx)
  return Response.json(catalog([raw('b',{secret:'PRIVATE'}),raw('image',{mode:'image_generation'}),raw('a')]))
 }})
 const [a,b]=await Promise.all([read(),read()]);assert.deepEqual(a,b);assert.equal(calls.length,2);assert.equal(a.catalog.models.length,2);assert.doesNotMatch(JSON.stringify(a),/PRIVATE|secret/)
 assert.deepEqual(a.catalog.models.map(m=>m.id),['a','b']);
 await read();assert.equal(calls.length,2);now+=51;await read();assert.equal(calls.length,3);now+=50;await read();assert.equal(calls.length,5)
})
test('fail closed malformed, empty, non-LLM or oversized catalog and cooldown',async()=>{
 for(const bad of [null,[],{},{data:[raw()]},{a:null},catalog([raw('image',{mode:'image_generation'})]),'INVALID']) {
  let calls=0,now=epoch
  const read=createPricingReader({now:()=>now,failureTTL:10,fetchImpl:async url=>{calls++;return url===FX_URL?Response.json(fx):bad==='INVALID'?new Response('{bad',{headers:{'content-type':'text/plain'}}):Response.json(bad)}})
  assert.equal((await read()).catalog,null);await read();assert.equal(calls,2);now+=11;await read();assert.equal(calls,3)
 }
 const read=createPricingReader({now:()=>epoch,maxCatalogBytes:10,fetchImpl:async url=>Response.json(url===FX_URL?fx:catalog())});assert.equal((await read()).catalog,null)
 const excessive=createPricingReader({now:()=>epoch,fetchImpl:async url=>Response.json(url===FX_URL?fx:catalog(Array.from({length:15001},(_,i)=>raw(String(i)))))})
 assert.equal((await excessive()).catalog,null)
})
test('FX rejection/expiry falls back to USD, no expired rate; HTTP and timeout failure sanitized',async()=>{
 for(const invalid of [{...fx,rate:0},{...fx,rate:-1},{...fx,rate:'1'},{...fx,base:'EUR'},{...fx,date:'2026-02-30'},{...fx,date:'2026-10-09'},{...fx,date:'2026-09-01'}]) {
  const read=createPricingReader({now:()=>epoch,fetchImpl:async url=>Response.json(url===FX_URL?invalid:catalog())});const d=await read();assert.equal(d.fx,null);assert.ok(d.catalog)
 }
 let now=epoch,fail=false
 const read=createPricingReader({now:()=>now,fxTTL:1,fetchImpl:async url=>url===FX_URL&&fail?new Response('PRIVATE',{status:429}):Response.json(url===FX_URL?fx:catalog())})
 assert.ok((await read()).fx);now+=2;fail=true;assert.equal((await read()).fx,null)
 const timed=createPricingReader({timeoutMs:5,fetchImpl:(_,opts)=>new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('PRIVATE'))))});assert.deepEqual([...(Object.values(await timed()).slice(0,2))],[null,null])
})
const context={Intl};vm.runInNewContext(await readFile(new URL('../src/web/pricing.js',import.meta.url),'utf8'),context)
const {estimate,format}=context.RouterPricing
const m=v=>({sum:v,known:v===null?0:1,unknown:v===null?1:0})
const metrics=(i=100,o=40,c=20,q=10)=>({inputTokens:m(i),outputTokens:m(o),cachedTokens:m(c),reasoningTokens:m(q),totalTokens:m(9999)})
const model={rates:{input:0.01,output:0.02,cache:0.001,reasoning:0.03}}
test('exclusive components, no totalTokens flat rate, reasoning output fallback and zero without prices',()=>{
 const d=estimate(metrics(),model);assert.equal(d.inputTokens,.8);assert.equal(d.cachedTokens,.02);assert.equal(d.outputTokens,.6);assert.equal(d.reasoningTokens,.3);assert.ok(Math.abs(d.totalTokens-1.72)<1e-12)
 const fallback={rates:{...model.rates,reasoning:null}};assert.ok(Math.abs(estimate(metrics(),fallback).totalTokens-1.62)<1e-12)
 assert.ok(Math.abs(estimate(metrics(100,40,20,null),fallback).totalTokens-1.62)<1e-12)
 assert.equal(estimate(metrics(0,0,0,0),{rates:{}}).totalTokens,0)
 assert.equal(estimate(metrics(0,0,null,null),{rates:{}}).totalTokens,0)
 for(const values of [[100,40,null,10],[100,40,101,10],[100,40,20,41],[0,0,1,0],[0,0,0,1]]){const d=estimate(metrics(...values),model);assert.ok(Number.isFinite(d.totalTokens));assert.equal(d.partial.totalTokens,true)}
 assert.ok(Math.abs(estimate(metrics(),{rates:{...model.rates,cache:null}}).totalTokens-1.7)<1e-12);assert.equal(estimate(metrics(),{rates:{...model.rates,cache:null}}).partial.totalTokens,true)
 const partial=metrics();partial.inputTokens.unknown=1;assert.ok(Number.isFinite(estimate(partial,model).totalTokens));assert.equal(estimate(partial,model).partial.totalTokens,true)
 assert.match(format(null,fx),/^ \(N\/D\)$/);assert.match(format(0,null),/0 USD/);assert.match(format(1,fx),/0,89397 €/);assert.match(format(1e-12,null),/0,000000000001 USD/)
})
test('read-only endpoint guarded, cached, no quota/inference or query/header leakage',async t=>{
 let calls=0
 const server=createRouterServer(loadConfig({UPSTREAMS:'a=http://127.0.0.1:1',ROUTER_API_KEY:'synthetic'}),{quotaFetchImpl:()=>{throw Error('NO_QUOTA')},pricingFetchImpl:async(url,opts)=>{calls++;assert.equal(opts.headers.authorization,undefined);return Response.json(url===FX_URL?{...fx,date:new Date().toISOString().slice(0,10)}:catalog())}})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});const base=`http://127.0.0.1:${server.address().port}`
 assert.equal(calls,0)
 for(const headers of [{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])assert.equal((await fetch(base+'/router/pricing',{headers})).status,403)
 assert.equal((await fetch(base+'/router/pricing?account=private')).status,400);assert.equal(calls,0)
 const r=await fetch(base+'/router/pricing');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);assert.equal((await r.json()).catalog.currency,'USD');assert.equal(calls,2)
 await fetch(base+'/router/pricing');assert.equal(calls,2)
 assert.equal((await fetch(base+'/v1/models')).status,401)
 assert.equal((await fetch(base+'/router/pricing.js')).status,200)
})
test('known input/output retain own tariff with absent or partial subset details',()=>{
 const d=estimate(metrics(100,40,null,null),model);
 assert.equal(d.inputTokens,1);assert.equal(d.outputTokens,.8);
 assert.equal(d.totalTokens,1.8);assert.equal(d.partial.totalTokens,true);assert.equal(d.cachedTokens,null);assert.equal(d.reasoningTokens,null);
 const partial=metrics();partial.cachedTokens.unknown=1;partial.reasoningTokens.unknown=1;
 assert.equal(estimate(partial,model).inputTokens,.8);assert.equal(estimate(partial,model).outputTokens,.6);
 assert.ok(Number.isFinite(estimate(partial,model).totalTokens));assert.equal(estimate(partial,model).partial.totalTokens,true);
 assert.equal(estimate(metrics(0,0,null,null),model).inputTokens,0);
 assert.equal(estimate(metrics(0,0,null,null),model).outputTokens,0);
});

test('known partial sums, unequal coverage, missing tariffs and uncomputable unknowns',()=>{
 const sums={inputTokens:2880607,outputTokens:17767,totalTokens:2898374,cachedTokens:575232,reasoningTokens:1397};
 const ms=Object.fromEntries(Object.entries(sums).map(([k,sum])=>[k,{sum,known:1,unknown:1}]));
 const d=estimate(ms,model);
 for(const k of Object.keys(sums)){assert.ok(Number.isFinite(d[k]));assert.equal(d.partial[k],true);assert.match(format(d[k],fx,d.partial[k]),/≈ [0-9].* €/)}
 assert.equal(d.inputTokens,(2880607-575232)*model.rates.input);
 assert.equal(d.outputTokens,(17767-1397)*model.rates.output);
 ms.cachedTokens.known=2;ms.cachedTokens.unknown=0;
 assert.equal(estimate(ms,model).partial.totalTokens,true);
 const missing=estimate(ms,{rates:{input:null,output:.02,cache:null,reasoning:null}});
 assert.equal(missing.inputTokens,null);assert.equal(missing.cachedTokens,null);assert.equal(missing.totalTokens,17767*.02);assert.equal(missing.partial.totalTokens,true);
 const unknown=Object.fromEntries(Object.keys(sums).map(k=>[k,{sum:null,known:0,unknown:2}]));
 assert.equal(estimate(unknown,model).totalTokens,null);
 assert.equal(estimate(ms,{rates:{}}).totalTokens,null);
 const subsetOnly=metrics(null,null,20,10);assert.equal(estimate(subsetOnly,model).totalTokens,.32);assert.equal(estimate(subsetOnly,model).partial.totalTokens,true);
 const invalid=estimate(metrics(100,40,101,41),model);assert.equal(invalid.cachedTokens,null);assert.equal(invalid.reasoningTokens,null);assert.equal(invalid.totalTokens,1.8);
});
