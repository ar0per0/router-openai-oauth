import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {createUsageObserver} from '../src/usage.mjs'
import {createUsageStore} from '../src/usage-store.mjs'
import {createRouterServer} from '../src/server.mjs'
import {loadConfig} from '../src/config.mjs'
import {FX_URL} from '../src/pricing-catalog.mjs'
const source=await readFile(new URL('../src/web/usage-chart.js',import.meta.url),'utf8');
const pricingSource=await readFile(new URL('../src/web/pricing.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/web/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../src/web/style.css',import.meta.url),'utf8');
class Element {
 constructor(tagName=''){this.tagName=tagName;this.children=[];this.listeners={};this.value='';this.text='';this.attrs={}}
 set textContent(v){this.text=String(v);this.children=[]} get textContent(){return this.text+this.children.map(n=>n.textContent).join(' ')}
 set innerHTML(v){throw Error('unsafe')} setAttribute(k,v){this.attrs[k]=v}
 appendChild(n){this.children.push(n);return n} replaceChildren(){this.children=[];this.text=''}
 removeAttribute(k){delete this.attrs[k]} contains(n){return this===n||this.children.some(c=>c.contains(n))}
 addEventListener(k,v){this.listeners[k]=v} fire(k='click',event={}){return this.listeners[k]?.({preventDefault(){},...event})}
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
const metrics=(sum,known,unknown)=>Object.fromEntries(['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens'].map(k=>[k,{sum,known,unknown}]));
const result=(sum=1234)=>({from:'2026-10-01',to:'2026-10-04',accounts:['old','<img>'],days:[{date:'2026-10-01',attempts:1,incomplete:0,metrics:metrics(sum,1,0)},{date:'2026-10-02',attempts:1,incomplete:1,metrics:metrics(null,0,1)},{date:'2026-10-03',attempts:2,incomplete:0,metrics:metrics(0,1,1)},{date:'2026-10-04',attempts:0,incomplete:0,metrics:metrics(null,0,0)}]});
const response=d=>({ok:true,json:async()=>d});
const harness=(fetcher,pricingEnabled=false,initialSelection=null)=>{
 const nodes=Object.fromEntries(['account','metric','from','to','status','total','chart','tooltip','fallback','refresh','total-breakdown','day-breakdown'].map(k=>['usage-'+k,new Element()]));nodes['usage-metric'].value='totalTokens';
 if(pricingEnabled)for(const k of ['model','model-options','pricing-status'])nodes['usage-'+k]=new Element();
 const stored=new Map(initialSelection?[['router.pricing.model',initialSelection]]:[]),localStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)};
 const calls=[],events={};const forbidden=()=>{throw Error('timer')};
 const context={localStorage,document:{addEventListener:(k,v)=>events['document-'+k]=v,getElementById:id=>nodes[id],createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)},window:{addEventListener:(k,v)=>events[k]=v},fetch:(url,options)=>{calls.push({url,options});return fetcher(url,options)},AbortController,URLSearchParams,Intl,Date,setTimeout:forbidden,setInterval:forbidden};
 if(pricingEnabled)vm.runInNewContext(pricingSource,context);
 vm.runInNewContext(source,context);
 return {nodes,calls,events,stored};
};
test('daily SVG focus hover touch, zero/null gaps, selectors locale and external CSP assets',async()=>{
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[{alias:'configured',url:'PRIVATE_URL'}]}:result())));await tick();const n=h.nodes;
 assert.equal(h.calls.length,2);assert.ok(h.calls.every(c=>c.options.credentials==='omit'&&c.options.redirect==='error'));
 assert.match(n['usage-account'].textContent,/configured/);assert.match(n['usage-account'].textContent,/old \(histórico\)/);assert.doesNotMatch(n['usage-account'].textContent,/PRIVATE_URL|<img>/)
 const root=n['usage-chart'].children[0];assert.equal(root.attrs.viewBox,'0 0 960 300');const groups=root.children.filter(n=>n.attrs.class==='usage-day');assert.equal(groups.length,4)
 const inspect=node=>{
  assert.notEqual(node.tagName,'title','no native SVG tooltip balloon');
  assert.equal(Object.hasOwn(node.attrs,'title'),false,'no native title attribute balloon');
  assert.notEqual(node.attrs.role,'tooltip','no floating tooltip overlay');
  for(const child of node.children) inspect(child);
 };
 inspect(n['usage-chart']);
 assert.equal(n['usage-tooltip'].textContent,'Selecciona un día con puntero, foco o toque.');
 const dates=new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Madrid'});
 const number=new Intl.NumberFormat('es-ES');
 for(const event of ['pointerenter','focus','click','touchstart']) {
  for(const [i,value] of [[0,`${number.format(1234)} tokens`],[1,'Consumo desconocido'],[2,'0 tokens'],[3,'Sin datos']]) {
   groups[i].fire(event);
   const expected=`${dates.format(new Date(result().days[i].date+'T12:00:00Z'))} · ${value}`;
   assert.equal(n['usage-tooltip'].textContent,expected);
   assert.equal(groups[i].attrs.role,'img');
   assert.equal(groups[i].attrs['aria-describedby'],'usage-tooltip usage-day-breakdown');
   assert.ok(groups[i].attrs['aria-label']);
   assert.doesNotMatch(n['usage-tooltip'].textContent,/reportad|cuentas|conocidos|incompletos|Parcial/i);
  }
 }
 assert.equal(root.children.filter(n=>n.attrs.class==='usage-line').length,0);assert.equal(n['usage-fallback'].children.length,4)
 n['usage-metric'].value='inputTokens';await n['usage-metric'].fire('change');assert.match(n['usage-total'].textContent,/inputTokens/);assert.equal(h.calls.length,2)
 n['usage-account'].value='old';await n['usage-account'].fire('change');assert.match(h.calls.at(-1).url,/account=old/);assert.equal(h.calls.length,3)
 assert.doesNotMatch(n['usage-status'].textContent,/intentos conocidos|incompletos\/no entregados/);
 assert.equal(n['usage-status'].textContent,'');
 assert.equal(n['usage-total'].textContent,`inputTokens · ${number.format(1234)}`);
 assert.match(n['usage-fallback'].children[0].textContent,/tokens reportados.*Reportado.*conocidos.*desconocidos.*incompletos/);
 assert.match(groups[1].attrs['aria-label'],/Desconocido.*0 conocidos \/ 1 desconocidos.*1 incompletos/);
 assert.equal(n['usage-from'].value,'01/10/2026');assert.equal(n['usage-to'].value,'04/10/2026');
 assert.doesNotMatch(html,/Europe\/Madrid ·|Datos diarios accesibles|type="date"/);
 assert.match(html,/<ul id="usage-fallback" class="sr-only" aria-label=/);
 for(const [id,label] of [['from','Desde'],['to','Hasta']]) assert.match(html,new RegExp(`<label>${label} <input id="usage-${id}" type="text" inputmode="numeric" placeholder="dd/mm/aaaa"`));
 assert.match(html,/<p class="usage-summary" role="status" aria-live="polite"><span id="usage-tooltip">/);
 assert.match(css,/#usage-tooltip\s*\{ font-variant-numeric: tabular-nums; \}/);
 assert.match(css,/\.sr-only\s*\{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
 assert.match(html,/src="\/router\/usage-chart.js" defer/);assert.ok(html.indexOf('id="usage-panel"')>html.indexOf('id="logs"'))
 assert.doesNotMatch(html,/<style\b|\sstyle=|\son\w+=|<script[^>]*>\s*[^<\s]/i);assert.doesNotMatch(source,/innerHTML|\.style\b|setTimeout|setInterval|\/router\/logs|rate-limits/);assert.match(css,/\.usage-day:focus/)
});
test('solid series markers preserve partial distinction and accessible selection without focus overrides',async()=>{
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:result())));await tick();
 const groups=h.nodes['usage-chart'].children[0].children.filter(n=>n.attrs.class==='usage-day');
 assert.deepEqual(groups.map(g=>g.children.filter(n=>n.tagName==='circle').length),[1,0,1,0]);
 assert.equal(groups[0].children.find(n=>n.tagName==='circle').attrs.class,'usage-point');
 assert.equal(groups[2].children.find(n=>n.tagName==='circle').attrs.class,'usage-partial');
 assert.ok(groups.every(g=>g.attrs['data-selected']==='false'&&g.attrs.tabindex==='0'));
 for(const event of ['pointerenter','focus','click','touchstart']) {
  groups[2].fire(event);
  assert.deepEqual(groups.map(g=>g.attrs['data-selected']),['false','false','true','false']);
  groups[0].fire(event);
  assert.deepEqual(groups.map(g=>g.attrs['data-selected']),['true','false','false','false']);
 }
 h.nodes['usage-metric'].value='inputTokens';await h.nodes['usage-metric'].fire('change');
 const refreshed=h.nodes['usage-chart'].children[0].children.filter(n=>n.attrs.class==='usage-day');
 assert.deepEqual(refreshed.map(g=>g.attrs['data-selected']),['true','false','false','false']);
 assert.match(css,/\.usage-point\s*\{ fill: #4285ee; \}/);
 assert.match(css,/\.usage-partial\s*\{ fill: #4285ee; stroke: CanvasText; stroke-width: 2; stroke-dasharray: 2 2; \}/);
 assert.match(css,/\.usage-day\[data-selected="true"\] \.usage-hit, \.usage-day:focus \.usage-hit, \.usage-day:hover \.usage-hit\s*\{[^}]*stroke: CanvasText;/);
 assert.match(css,/\.usage-day:focus \.usage-hit\s*\{ stroke-width: 2; \}/);
 assert.match(css,/\.usage-day\[data-selected="true"\] circle, \.usage-day:focus circle, \.usage-day:hover circle\s*\{ stroke: CanvasText; stroke-width: 2; \}/);
 assert.doesNotMatch(source,/\.focus\(|scrollIntoView/);
});
test('concise tooltip and total use existing locale formatters without reported suffix',async()=>{
 const d=result();d.from=d.to='2026-10-07';d.days=[{date:'2026-10-07',attempts:1,incomplete:0,metrics:metrics(6388,1,0)}];
 d.days[0].metrics.inputTokens.sum=4706;
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:d)));await tick();
 const n=h.nodes,group=n['usage-chart'].children[0].children.find(n=>n.attrs.class==='usage-day');
 const date=new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Madrid'}).format(new Date('2026-10-07T12:00:00Z'));
 const number=new Intl.NumberFormat('es-ES');
 for(const event of ['pointerenter','focus','click','touchstart']) {
  group.fire(event);assert.equal(n['usage-tooltip'].textContent,`${date} · ${number.format(6388)} tokens`);
 }
 n['usage-metric'].value='inputTokens';await n['usage-metric'].fire('change');
 assert.equal(n['usage-total'].textContent,`inputTokens · ${number.format(4706)}`);
 for(const [attempts,unknown,expected] of [[1,1,'Desconocido'],[0,0,'Sin datos']]) {
  d.days[0].attempts=attempts;d.days[0].metrics=metrics(null,0,unknown);
  await n['usage-refresh'].fire();assert.equal(n['usage-total'].textContent,expected==='Sin datos'?'Sin datos':`inputTokens · ${expected}`);
 }
});
test('dedupe and abort guard both fetch and delayed JSON; manual recovery and cleanup',async()=>{
 const first=deferred(),json=deferred();let counter=0;
 const h=harness(url=>url==='/router/status'?Promise.resolve(response({upstreams:[]})):++counter===1?first.promise:counter===2?Promise.resolve({ok:true,json:()=>json.promise}):Promise.resolve(response(result(99))));
 const n=h.nodes;n['usage-refresh'].fire();assert.equal(counter,1);
 n['usage-account'].value='old';n['usage-account'].fire('change');await tick();assert.equal(h.calls[1].options.signal.aborted,true);
 n['usage-account'].value='configured';await n['usage-account'].fire('change');assert.match(n['usage-total'].textContent,/99/);
 first.resolve(response(result(8888)));json.resolve(result(7777));await tick();assert.doesNotMatch(n['usage-total'].textContent,/8888|7777/);
 h.events.pagehide();assert.equal(n['usage-chart'].children.length,0);assert.ok(h.calls[0].options.signal.aborted)
 let fail=true;const recovery=harness(url=>url==='/router/status'?Promise.resolve(response({upstreams:[]})):fail?Promise.reject(Error('PRIVATE_ERROR')):Promise.resolve(response(result())));await tick();assert.match(recovery.nodes['usage-status'].textContent,/Uso no disponible/);assert.doesNotMatch(recovery.nodes['usage-status'].textContent,/PRIVATE_ERROR/);fail=false;await recovery.nodes['usage-refresh'].fire();assert.match(recovery.nodes['usage-total'].textContent,/1234/)
});
test('strict Spanish calendar input, leap years, bounds and inclusive range without overflow',async()=>{
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:result())));await tick();const n=h.nodes;
 for(const [from,to] of [['29/02/2024','29/02/2024'],['29/02/2000','29/02/2000'],['01/10/2026','31/10/2026'],['01/01/2000','01/01/2000'],['31/12/9998','31/12/9998'],['29/03/2026','29/03/2026'],['25/10/2026','25/10/2026']]) {
  n['usage-from'].value=from;n['usage-to'].value=to;await n['usage-refresh'].fire();
  const iso=v=>v.split('/').reverse().join('-');const params=new URL('http://local'+h.calls.at(-1).url).searchParams;
  assert.equal(params.get('from'),iso(from));assert.equal(params.get('to'),iso(to));
 }
 for(const [from,to] of [['29/02/2026','01/03/2026'],['29/02/2100','01/03/2100'],['31/04/2026','01/05/2026'],['00/10/2026','01/10/2026'],['01/00/2026','01/10/2026'],['01/13/2026','01/10/2026'],['1/10/2026','01/10/2026'],['2026-10-01','01/10/2026'],['01/10/2026 ','01/10/2026'],['01/01/1999','01/01/1999'],['01/01/9999','01/01/9999'],['02/10/2026','01/10/2026'],['01/10/2026','01/11/2026']]) {
  const count=h.calls.length;n['usage-from'].value=from;n['usage-to'].value=to;await n['usage-refresh'].fire();
  assert.equal(h.calls.length,count);assert.match(n['usage-status'].textContent,/Fechas no válidas.*dd\/mm\/aaaa/);
  assert.equal(n['usage-from'].attrs['aria-invalid'],'true');assert.equal(n['usage-chart'].children.length,0);assert.equal(n['usage-total'].textContent,'');
 }
 n['usage-from'].value='';n['usage-to'].value='';await n['usage-refresh'].fire();assert.equal(h.calls.at(-1).url,'/router/usage/summary');
 assert.equal(n['usage-from'].attrs['aria-invalid'],'false');assert.equal(n['usage-from'].value,'01/10/2026');
 n['usage-from'].value='';n['usage-to'].value='25/10/2026';await n['usage-refresh'].fire();assert.equal(h.calls.at(-1).url,'/router/usage/summary?to=2026-10-25');
 n['usage-from'].value='29/03/2026';n['usage-to'].value='';await n['usage-refresh'].fire();assert.equal(h.calls.at(-1).url,'/router/usage/summary?from=2026-03-29');
});
test('date editing and invalid changes abort fetch/JSON and never restore stale dates or data',async()=>{
 for(const editEvent of ['input','change']) {
  const pending=deferred(),json=deferred();let count=0;
  const h=harness(url=>url==='/router/status'?Promise.resolve(response({upstreams:[]})):++count===1?pending.promise:count===2?Promise.resolve({ok:true,json:()=>json.promise}):Promise.resolve(response(result(42))));
  const n=h.nodes;n['usage-from'].value='01/10/2026';n['usage-to'].value='04/10/2026';n['usage-refresh'].fire();await tick();
  n['usage-from'].value='31/02/2026';await n['usage-from'].fire(editEvent);
  assert.ok(h.calls[1].options.signal.aborted);assert.ok(h.calls[2].options.signal.aborted);
  pending.resolve(response(result(888)));json.resolve(result(999));await tick();
  assert.equal(n['usage-from'].value,'31/02/2026');assert.equal(n['usage-chart'].children.length,0);assert.equal(n['usage-total'].textContent,'');
  n['usage-from'].value='01/10/2026';await n['usage-refresh'].fire();assert.match(n['usage-total'].textContent,/42/);
  assert.equal(n['usage-from'].value,'01/10/2026');
 }
});
test('impossible backend dates reject without normalization and allow manual recovery',async()=>{
 for(const field of ['from','to','day']) {
  let bad=true;const h=harness(url=>{
   if(url==='/router/status')return Promise.resolve(response({upstreams:[]}));
   const d=result();if(bad){if(field==='day')d.days[0].date='2026-02-30';else d[field]='2026-02-30'}return Promise.resolve(response(d));
  });await tick();
  assert.match(h.nodes['usage-status'].textContent,/Uso no disponible/);assert.equal(h.nodes['usage-chart'].children.length,0);
  bad=false;await h.nodes['usage-refresh'].fire();assert.match(h.nodes['usage-total'].textContent,/1234/);
 }
});

test('total and daily breakdown use independent reported types, subsets and unknowns for all or one account',async()=>{
 const d=result();d.from=d.to='2026-10-08';d.days=[{date:'2026-10-08',attempts:2,incomplete:0,metrics:{
  totalTokens:{sum:4271418,known:2,unknown:0},inputTokens:{sum:4000000,known:2,unknown:0},
  outputTokens:{sum:271418,known:2,unknown:0},cachedTokens:{sum:0,known:1,unknown:1},reasoningTokens:{sum:null,known:0,unknown:2},
 }}];
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:d)));await tick();const n=h.nodes;
 const expected=[' · Entrada: 4.000.000',' · Salida: 271.418',' · Caché: 0',' · Razonamiento: Desconocido'];
 assert.equal(n['usage-total'].textContent,'totalTokens · 4.271.418');
 assert.deepEqual(n['usage-total-breakdown'].children.map(n=>n.textContent),expected);
 for(const selected of ['', 'old']) {
  n['usage-account'].value=selected;await n['usage-account'].fire('change');
  const group=n['usage-chart'].children[0].children.find(n=>n.attrs.class==='usage-day');
  for(const event of ['pointerenter','focus','click','touchstart']) {
   group.fire(event);assert.match(n['usage-tooltip'].textContent,/8 oct 2026 · 4\.271\.418 tokens/);
   assert.deepEqual(n['usage-day-breakdown'].children.map(n=>n.textContent),expected);
  }
 }
 const calls=h.calls.length;
 n['usage-metric'].value='cachedTokens';await n['usage-metric'].fire('change');
 assert.equal(h.calls.length,calls);assert.equal(n['usage-total-breakdown'].textContent,'');assert.equal(n['usage-day-breakdown'].textContent,'');
 n['usage-metric'].value='totalTokens';await n['usage-metric'].fire('change');
 assert.deepEqual(n['usage-day-breakdown'].children.map(n=>n.textContent),expected,'selected day persists without forcing focus');
 d.days[0].attempts=0;d.days[0].metrics=metrics(null,0,0);await n['usage-refresh'].fire();
 assert.equal(n['usage-total-breakdown'].children.length,0);assert.equal(n['usage-total'].textContent,'Sin datos');
});

test('loading removal cannot collapse reserved chart viewport; controls remain and no page scroll/focus override',async()=>{
 let pending=null,fail=false;
 const h=harness(url=>url==='/router/status'?Promise.resolve(response({upstreams:[]})):pending?pending.promise:fail?Promise.reject(Error()):Promise.resolve(response(result())));
 await tick();const n=h.nodes,controls=[n['usage-account'],n['usage-metric'],n['usage-from'],n['usage-to'],n['usage-refresh']];
 // DOM harness has no browser layout: check the CSS sizing contract and model
 // document-bottom clamping that occurred when an auto-height SVG was removed.
 assert.match(css,/#usage-chart\s*\{ aspect-ratio: 960 \/ 300; \}/);
 assert.match(css,/#usage-chart svg\s*\{[^}]*height: 100%;/);
 assert.match(css,/\.usage-summary\s*\{[^}]*min-height:/);
 assert.doesNotMatch(source,/scrollTo\(|scrollIntoView|\.focus\(|requestAnimationFrame|window\.onscroll/);
 assert.doesNotMatch(html,/<form\b|href="#/);
 const width=960,viewport=600,otherHeight=1000,originalMax=otherHeight+width*300/960-viewport;
 assert.ok(Math.min(originalMax,otherHeight-viewport)<originalMax,'old removal clamps scroll upwards');
 const reservedHeight=()=>width*300/960;
 let userScroll=originalMax;
 pending=deferred();const reading=n['usage-refresh'].fire();
 assert.equal(n['usage-chart'].children.length,0,'clear stale chart during request');
 assert.equal(Math.min(userScroll,otherHeight+reservedHeight()-viewport),userScroll,'reserved height prevents clamp');
 userScroll=123;pending.resolve(response(result(44)));await reading;pending=null;
 assert.equal(userScroll,123,'no scroll restoration fighting intentional scrolling');
 assert.deepEqual(controls,[n['usage-account'],n['usage-metric'],n['usage-from'],n['usage-to'],n['usage-refresh']]);
 const option=n['usage-account'].children[0];await n['usage-refresh'].fire();assert.equal(n['usage-account'].children[0],option,'unchanged options not replaced');
 fail=true;await n['usage-refresh'].fire();assert.equal(n['usage-chart'].children.length,0);
 assert.equal(reservedHeight(),300);
 n['usage-from'].value='31/02/2026';n['usage-from'].fire('input');await n['usage-from'].fire('change');
 assert.equal(n['usage-total-breakdown'].textContent,'');assert.equal(n['usage-day-breakdown'].textContent,'');
});

 test('compact inline summary and day preserve locale, accessible subsets and natural wrapping',async()=>{
 const d=result();d.from=d.to='2026-10-08';d.days=[{date:'2026-10-08',attempts:1,incomplete:0,metrics:{
  totalTokens:{sum:4651,known:1,unknown:0},inputTokens:{sum:3201,known:1,unknown:0},
  outputTokens:{sum:1450,known:1,unknown:0},cachedTokens:{sum:0,known:1,unknown:0},reasoningTokens:{sum:0,known:1,unknown:0},
 }}];
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:d)));await tick();const n=h.nodes;
 const number=new Intl.NumberFormat('es-ES');
 const breakdown=` · Entrada: ${number.format(3201)} · Salida: ${number.format(1450)} · Caché: 0 · Razonamiento: 0`;
 const inline=id=>n[id].children.map(child=>child.textContent).join('');
 assert.equal(n['usage-total'].textContent+inline('usage-total-breakdown'),`totalTokens · ${number.format(4651)}${breakdown}`);
 const group=n['usage-chart'].children[0].children.find(n=>n.attrs.class==='usage-day');
 for(const event of ['pointerenter','focus','click','touchstart']) {
  group.fire(event);
  assert.equal(n['usage-tooltip'].textContent+inline('usage-day-breakdown'),`8 oct 2026 · ${number.format(4651)} tokens${breakdown}`);
 }
 for(const id of ['usage-total-breakdown','usage-day-breakdown']) {
  assert.equal(n[id].children[2].attrs['aria-label'],'Caché (incluida en entrada): 0');
  assert.equal(n[id].children[3].attrs['aria-label'],'Razonamiento (incluido en salida): 0');
 }
 assert.match(html,/<p class="usage-summary"><span id="usage-total"><\/span><span id="usage-total-breakdown"/);
 assert.match(html,/<span id="usage-tooltip">[^<]*<\/span><span id="usage-day-breakdown"/);
 assert.doesNotMatch(html,/<p id="usage-(?:total-breakdown|day-breakdown)"/);
 assert.match(css,/#usage-total, #usage-tooltip\s*\{ font-size: 1\.1em; font-weight: 700; line-height: 1; \}/);
 assert.doesNotMatch(css,/\.usage-summary\s*\{[^}]*(?:font-size|font-weight):/);
 assert.match(css,/\.usage-breakdown\s*\{ display: inline; font-size: inherit; \}/);
 assert.match(css,/\.usage-breakdown span\s*\{ display: inline; \}/);
 assert.match(css,/\.usage-summary\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
 assert.match(css,/\.usage-summary\s*\{ min-height: 1\.8em; margin: \.75rem 0;/);
 assert.doesNotMatch(css,/@media[^}]*\{\s*\.usage-summary/);
 assert.doesNotMatch(css,/text-overflow|white-space:\s*nowrap(?![^}]*border: 0)/);
 });

test('searchable combobox price simulation preserves chart nodes/focus, inline range/day and no model filter',async()=>{
 const d=result();d.from=d.to='2026-10-08';d.days=[{date:'2026-10-08',attempts:1,incomplete:0,metrics:{inputTokens:{sum:3201,known:1,unknown:0},outputTokens:{sum:1450,known:1,unknown:0},totalTokens:{sum:4651,known:1,unknown:0},cachedTokens:{sum:100,known:1,unknown:0},reasoningTokens:{sum:200,known:1,unknown:0}}}];
 let fx={base:'USD',quote:'EUR',rate:.9,date:'2026-10-08'},fail=false;
 const models=[{id:'<b>small</b>',provider:'alpha',rates:{input:.000001,output:.000002,cache:.0000001,reasoning:null}},{id:'other',provider:'beta',rates:{input:0,output:0,cache:null,reasoning:null}}];
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:url==='/router/pricing'?fail?{catalog:null,fx:null}:{catalog:{currency:'USD',models,fetchedAt:'2026-10-08'},fx}:d)),true);await tick();const n=h.nodes;
 const group=n['usage-chart'].children[0].children.find(n=>n.attrs.class==='usage-day');group.fire('focus');
 const calls=h.calls.length;
 n['usage-model'].value='ALPHA';n['usage-model'].fire('input');assert.equal(n['usage-model-options'].children.length,2);assert.match(n['usage-model-options'].textContent,/<b>small<\/b>/);
 n['usage-model-options'].children[1].fire('click');
 assert.equal(h.calls.length,calls);assert.equal(n['usage-chart'].children[0].children.find(n=>n.attrs.class==='usage-day'),group,'pricing does not recreate focused SVG');
 assert.match(n['usage-total'].textContent,/totalTokens · 4651 \(≈ .* €\)/);
 assert.match(n['usage-tooltip'].textContent,/4651 tokens \(≈ .* €\)/);
 assert.ok(n['usage-total-breakdown'].children.every(n=>/\(≈ .* €\)/.test(n.textContent)));
 assert.equal(h.stored.get('router.pricing.model'),JSON.stringify(['alpha','<b>small</b>']));
 assert.equal(n['usage-pricing-status'].textContent,'');
 n['usage-model'].value='beta';n['usage-model'].fire('input');assert.equal(n['usage-model-options'].children.length,2,'filter excludes nonmatching selection without changing it');
 fx=null;await n['usage-refresh'].fire();assert.match(n['usage-total'].textContent,/USD/);assert.doesNotMatch(n['usage-total'].textContent,/€/);
 n['usage-account'].value='old';await n['usage-account'].fire('change');assert.match(h.calls.at(-1).url,/account=old/);assert.doesNotMatch(h.calls.at(-1).url,/model|alpha/);
 fail=true;await n['usage-refresh'].fire();assert.doesNotMatch(n['usage-total'].textContent,/≈|USD|€/);assert.match(n['usage-pricing-status'].textContent,/Catálogo no disponible/);
 assert.match(html,/id="usage-model" type="text" role="combobox"/);assert.doesNotMatch(html,/usage-model-search|<select id="usage-model"|Simulación de precio, no filtro/);
});

test('catalog late JSON uses latest selection/data, dedupes retry, pagehide ignores stale completion',async()=>{
 const pending=deferred();let priceCalls=0;
 const h=harness(url=>url==='/router/pricing'?(priceCalls++,Promise.resolve({ok:true,json:()=>pending.promise})):Promise.resolve(response(url==='/router/status'?{upstreams:[]}:result())),true);await tick();
 h.nodes['usage-refresh'].fire();assert.equal(priceCalls,1);
 h.nodes['usage-metric'].value='inputTokens';h.nodes['usage-metric'].fire('change');
 h.events.pagehide();assert.ok(h.calls.find(c=>c.url==='/router/pricing').options.signal.aborted);
 pending.resolve({catalog:{currency:'USD',models:[],fetchedAt:'now'},fx:null});await tick();
 assert.equal(h.nodes['usage-chart'].children.length,0);assert.equal(h.nodes['usage-total'].textContent,'');
});

test('single combobox keyboard/filter/clear, real ARIA selection, touch click, outside and persistence',async()=>{
 const models=[{provider:'alpha',id:'a',rates:{input:1,output:1}},{provider:'beta',id:'b',rates:{input:1,output:1}}];
 const chosen=JSON.stringify(['beta','b']);
 const fetcher=url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:url==='/router/pricing'?{catalog:{currency:'USD',models},fx:{base:'USD',quote:'EUR',rate:1}}:result()));
 const h=harness(fetcher,true,chosen);await tick();const n=h.nodes,input=n['usage-model'],list=n['usage-model-options'];
 assert.equal(input.value,'beta · b');assert.equal(input.attrs['aria-expanded'],'false');
 input.fire('focus');assert.equal(list.hidden,false);assert.equal(list.children.length,3);
 assert.deepEqual(list.children.map(o=>o.attrs['aria-selected']),['false','false','true']);
 assert.match(html,/aria-controls="usage-model-options"/);assert.match(html,/id="usage-model-options" role="listbox"/);
 list.clientHeight=50;list.children.forEach((o,i)=>{o.offsetTop=i*40;o.offsetHeight=40});
 let prevented=false;input.fire('keydown',{key:'ArrowUp',preventDefault(){prevented=true}});assert.ok(prevented);
 assert.equal(input.attrs['aria-activedescendant'],list.children[2].id);assert.equal(list.scrollTop,70,'keyboard active item stays in popup viewport');
 input.fire('keydown',{key:'ArrowDown'});assert.equal(input.attrs['aria-activedescendant'],list.children[0].id);
 input.value='ALPHA';input.fire('input');assert.equal(list.children.length,2);assert.equal(input.attrs['aria-activedescendant'],undefined);
 input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'Enter'});
 assert.equal(input.value,'alpha · a');assert.equal(h.stored.get('router.pricing.model'),JSON.stringify(['alpha','a']));assert.equal(list.hidden,true);
 input.value='';input.fire('input');assert.equal(list.children.length,3);
 input.fire('keydown',{key:'Enter'});assert.equal(h.stored.get('router.pricing.model'),JSON.stringify(['alpha','a']),'no automatic choice after clearing');
 input.fire('keydown',{key:'Escape'});assert.equal(input.value,'alpha · a');assert.equal(list.hidden,true);
 input.fire('click');input.value='missing';input.fire('input');assert.match(list.textContent,/Sin coincidencias/);assert.equal(list.children[1].attrs.role,undefined);
 input.fire('keydown',{key:'Tab'});assert.equal(input.value,'alpha · a');assert.equal(list.hidden,true);
 input.fire('click');h.events['document-pointerdown']({target:list.children[1]});assert.equal(list.hidden,false);
 list.children[2].fire('pointerdown',{pointerType:'touch'});list.children[2].fire('click');assert.equal(input.value,'beta · b');
 input.fire('click');h.events['document-pointerdown']({target:new Element()});assert.equal(list.hidden,true);assert.equal(input.value,'beta · b');
 input.fire('click');input.value='alpha';input.fire('input');input.fire('blur');assert.equal(input.value,'beta · b');
 input.fire('click');list.children[0].fire('click');assert.equal(input.value,'');assert.equal(h.stored.get('router.pricing.model'),'');
 assert.equal(h.calls.length,3,'all interactions are local');
 assert.match(css,/#usage-model-options\s*\{[^}]*max-height: 16rem;[^}]*overflow-y: auto;/);
});

test('pricing selected: empty range/day concise, true zero and partial not suppressed, no long note',async()=>{
 let d=result();d.days=d.days.slice(-1);d.from=d.to=d.days[0].date;
 const model={provider:'p',id:'m',rates:{input:1,output:1,cache:1,reasoning:null}};
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:url==='/router/pricing'?{catalog:{currency:'USD',models:[model]},fx:null}:d)),true,JSON.stringify(['p','m']));await tick();const n=h.nodes;
 const point=()=>n['usage-chart'].children[0].children.find(o=>o.attrs.class==='usage-day');
 point().fire('click');assert.equal(n['usage-total'].textContent,'Sin datos');assert.equal(n['usage-tooltip'].textContent,'4 oct 2026 · Sin datos');
 for(const id of ['usage-total-breakdown','usage-day-breakdown'])assert.equal(n[id].textContent,'');
 assert.doesNotMatch(n['usage-pricing-status'].textContent,/Simulación|LiteLLM|Frankfurter|Entrada excluye|N\/D/);
 d.days[0].attempts=1;d.days[0].metrics=metrics(0,1,0);await n['usage-refresh'].fire();point().fire('focus');
 assert.match(n['usage-total'].textContent,/totalTokens · 0 \(≈ 0 USD\)/);assert.equal(n['usage-total-breakdown'].children.length,4);assert.match(n['usage-tooltip'].textContent,/0 tokens \(≈ 0 USD\)/);
 d.days[0].attempts=2;d.days[0].metrics=metrics(0,1,1);await n['usage-refresh'].fire();point().fire('touchstart');
 assert.match(n['usage-total'].textContent,/totalTokens · 0 \(≈ 0 USD\)/);assert.doesNotMatch(n['usage-day-breakdown'].textContent,/parcial|con desconocidos/i);
});

test('catalog fetch and HTTP failures are brief actionable, recoverable and stale fetch ignored',async()=>{
 for(const failure of ['fetch','http','invalid']){
  let fail=true;const h=harness(url=>url==='/router/pricing'&&fail?failure==='fetch'?Promise.reject(Error('PRIVATE')):Promise.resolve(failure==='http'?{ok:false}:response({catalog:{currency:'EUR',models:[]}})):Promise.resolve(response(url==='/router/status'?{upstreams:[]}:url==='/router/pricing'?{catalog:{currency:'USD',models:[]},fx:{base:'USD',quote:'EUR',rate:1}}:result())),true);await tick();
  assert.match(h.nodes['usage-pricing-status'].textContent,/Catálogo no disponible.*Refrescar/);assert.doesNotMatch(h.nodes['usage-pricing-status'].textContent,/PRIVATE/);
  fail=false;await h.nodes['usage-refresh'].fire();assert.equal(h.nodes['usage-pricing-status'].textContent,'');
 }
 const pending=deferred();let parsed=false;
 const h=harness(url=>url==='/router/pricing'?pending.promise:Promise.resolve(response(url==='/router/status'?{upstreams:[]}:result())),true);await tick();h.events.pagehide();
 pending.resolve({ok:true,json(){parsed=true;return Promise.resolve({})}});await tick();assert.equal(parsed,false);
});

test('wire usage → observer → SQLite worker → HTTP summary/catalog → pointer/keyboard prices on mounted range/day',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pricing-ui-')),store=createUsageStore(join(dir,'usage.sqlite'));
 const now=new Date().toISOString().slice(0,10);
 const wire={input_tokens:3201,output_tokens:1450,total_tokens:4651,input_tokens_details:{cached_tokens:100},output_tokens_details:{reasoning_tokens:200}};
 const chat={prompt_tokens:3201,completion_tokens:1450,total_tokens:4651,prompt_tokens_details:{cached_tokens:100},completion_tokens_details:{reasoning_tokens:200}};
 const observe=async(endpoint,usage)=>{
  const observer=createUsageObserver(endpoint,{'content-type':'application/json'});
  observer.stream.resume();observer.stream.end(JSON.stringify({status:'completed',usage}));await once(observer.stream,'end');return observer.snapshot();
 };
 // Public tariff fixture uses the exact verified catalog field names/units.
 const raw={id:'chat-latest',provider:'openai',mode:'chat',input_cost_per_token:.000005,output_cost_per_token:.00003,cache_read_input_token_cost:5e-7};
 let publicCalls=0;
 const server=createRouterServer(loadConfig({UPSTREAMS:'fixture=http://127.0.0.1:1',ROUTER_API_KEY:'synthetic'}),{
  usageStore:store,quotaFetchImpl:()=>{throw Error('NO_QUOTA_OR_INFERENCE')},
  pricingFetchImpl:async url=>{publicCalls++;return url===FX_URL?Response.json({base:'USD',quote:'EUR',date:now,rate:.89397}):Response.json({data:[raw,{...raw,provider:'other',input_cost_per_token:0,output_cost_per_token:0,cache_read_input_token_cost:0}],page:1,page_size:500,has_more:false,total_count:2});},
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const push=async(attempt,endpoint,usage)=>assert.equal(store.write({timestamp:'2026-10-08T12:00:00.000Z',requestId:'00000000-0000-0000-0000-000000000001',attempt,index:1,alias:'fixture',endpoint,outcome:'complete',...await observe(endpoint,usage)}),true);
 try {
  await push(1,'/v1/responses',wire);await push(2,'/v1/chat/completions',chat);
  const path='/router/usage/summary?from=2026-10-08&to=2026-10-08';
  const summary=await (await fetch(base+path)).json();
  assert.deepEqual(summary.days[0].metrics.inputTokens,{sum:6402,known:2,unknown:0});
  assert.deepEqual(summary.days[0].metrics.reasoningTokens,{sum:400,known:2,unknown:0});
  let fxFallback=false;
  const requests=new Map();
  const fetcher=async(url,opts)=>{
   requests.set(url,(requests.get(url)??0)+1);
   const r=await fetch(base+(url.startsWith('/router/usage/summary')?path:url),opts);
   if(url==='/router/pricing'&&fxFallback){const d=await r.json();return response({...d,fx:null});}
   return r;
  };
  const h=harness(fetcher,true);
  // Await network through the mounted Refrescar handler, which dedupes initial reads.
  await h.nodes['usage-refresh'].fire();await tick();
  const n=h.nodes,input=n['usage-model'],list=n['usage-model-options'];
  const root=n['usage-chart'].children[0],day=root.children.find(n=>n.attrs.class==='usage-day');day.fire('focus');
  const usageReads=()=>[...requests].filter(([url])=>url.startsWith('/router/usage/summary')).reduce((s,[,count])=>s+count,0);
  const reads=usageReads(),metadata=requests.get('/router/pricing');
  const assertPrices=currency=>{
   // Exclusive input 6202*5e-6; cache 200*5e-7; output 2500*3e-5;
   // reasoning 400*3e-5; inclusive total = .11811 USD (not reported total*rate).
   const fmt=v=>new Intl.NumberFormat('es-ES',{maximumSignificantDigits:6}).format(v*(currency==='€'?.89397:1));
   assert.equal(n['usage-total'].textContent,`totalTokens · 9302 (≈ ${fmt(.11811)} ${currency})`);
   assert.equal(n['usage-tooltip'].textContent,`8 oct 2026 · 9302 tokens (≈ ${fmt(.11811)} ${currency})`);
   for(const id of ['usage-total-breakdown','usage-day-breakdown'])assert.deepEqual(n[id].children.map(c=>c.textContent),[
    ` · Entrada: 6402 (≈ ${fmt(.03101)} ${currency})`,` · Salida: 2900 (≈ ${fmt(.075)} ${currency})`,
    ` · Caché: 200 (≈ ${fmt(.0001)} ${currency})`,` · Razonamiento: 400 (≈ ${fmt(.012)} ${currency})`,
   ]);
   assert.equal(n['usage-chart'].children[0],root);assert.equal(root.children.find(n=>n.attrs.class==='usage-day'),day);
   assert.equal(n['usage-model'],input);assert.equal(usageReads(),reads);assert.equal(requests.get('/router/pricing'),metadata);
  };
  input.value='openai';input.fire('input');
  const option=list.children[1];let prevented=false;
  option.fire('pointerdown',{preventDefault(){prevented=true}});assert.ok(prevented);option.fire('click');assertPrices('€');
  input.fire('click');list.children[0].fire('click');assert.doesNotMatch(n['usage-total'].textContent,/≈/);
  input.value='openai';input.fire('input');input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'Enter'});assertPrices('€');
  input.value='other';input.fire('input');list.children[1].fire('click');
  assert.equal(h.stored.get('router.pricing.model'),JSON.stringify(['other','chat-latest']),'same model ID belongs to a different provider');
  assert.match(n['usage-total'].textContent,/≈ 0 €/);
  input.value='openai';input.fire('input');input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'Enter'});assertPrices('€');
  for(const key of ['inputTokens','outputTokens','cachedTokens','reasoningTokens','totalTokens']){
   n['usage-metric'].value=key;n['usage-metric'].fire('change');assert.match(n['usage-total'].textContent,/\(≈ .* €\)/);assert.match(n['usage-tooltip'].textContent,/\(≈ .* €\)/);
  }
  assert.equal(usageReads(),reads);assert.equal(requests.get('/router/pricing'),metadata);
  // Refresh all metadata through the one allowed button; no false EUR on FX failure.
  fxFallback=true;await n['usage-refresh'].fire();assert.match(n['usage-total'].textContent,/USD/);assert.doesNotMatch(n['usage-total'].textContent,/€/);
  assert.match(n['usage-pricing-status'].textContent,/USD.*Refrescar/);assert.equal(publicCalls,2,'backend TTL prevents public fetch bursts');
  await push(3,'/v1/responses',{...wire,input_tokens_details:undefined,output_tokens_details:undefined});
  await n['usage-refresh'].fire();
  assert.match(n['usage-total'].textContent,/≈ 0,177615 USD/,'known exclusive costs survive partial subset coverage');
  assert.match(n['usage-total-breakdown'].children[0].textContent,/Entrada: 9603 \(≈ 0,047015 USD\)/);
  assert.match(n['usage-total-breakdown'].children[1].textContent,/Salida: 4350 \(≈ 0,1185 USD\)/);
  assert.match(n['usage-day-breakdown'].children[0].textContent,/≈ 0,047015 USD/);
  for(const key of ['inputTokens','outputTokens']){n['usage-metric'].value=key;n['usage-metric'].fire('change');assert.match(n['usage-total'].textContent,/≈ .* USD/);assert.match(n['usage-tooltip'].textContent,/≈ .* USD/);}
  for(const asset of ['/router/','/router/pricing.js','/router/usage-chart.js']){
   const r=await fetch(base+asset);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
   if(asset==='/router/'){const body=await r.text();assert.ok(body.indexOf('src="/router/pricing.js"')<body.indexOf('src="/router/usage-chart.js"'));assert.doesNotMatch(body,/usage-pricing-refresh|Reintentar catálogo|Refrescar uso/);assert.match(body,/>Refrescar<\/button>/);}
  }
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await store.close();await rm(dir,{recursive:true,force:true});}
});

test('REAL partial aggregate → SQLite worker → HTTP → mouse/keyboard UI with numeric component prices',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'real-partial-ui-')),store=createUsageStore(join(dir,'usage.sqlite'));
 // Tariffs observed by public GET on catalog page 3; fixture only, never runtime defaults.
 const raw={id:'ft:gpt-4o-2024-08-06',provider:'openai',mode:'chat',input_cost_per_token:.00000375,output_cost_per_token:.000015,cache_read_input_token_cost:.000001875};
 const sums={inputTokens:2880607,outputTokens:17767,totalTokens:2898374,cachedTokens:575232,reasoningTokens:1397};
 const record=(attempt,fields)=>({timestamp:'2026-10-08T12:00:00.000Z',requestId:'00000000-0000-0000-0000-000000000002',attempt,index:1,alias:'fixture',endpoint:'/v1/responses',outcome:'complete',usageStatus:attempt===1?'upstream_reported':'unknown',provenance:attempt===1?'responses_upstream_reported':'none',modelStatus:'completed',...fields});
 const server=createRouterServer(loadConfig({UPSTREAMS:'fixture=http://127.0.0.1:1',ROUTER_API_KEY:'synthetic'}),{
  usageStore:store,quotaFetchImpl:()=>{throw Error('NO_INFERENCE_OR_QUOTA')},
  pricingFetchImpl:async url=>Response.json(url===FX_URL?{base:'USD',quote:'EUR',date:new Date().toISOString().slice(0,10),rate:.89397}:{data:[raw],page:1,page_size:500,has_more:false,total_count:1}),
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`,path='/router/usage/summary?from=2026-10-08&to=2026-10-08';
 try {
  assert.equal(store.write(record(1,sums)),true);assert.equal(store.write(record(2,{})),true);
  const d=await(await fetch(base+path)).json();
  for(const [k,sum] of Object.entries(sums))assert.deepEqual(d.days[0].metrics[k],{sum,known:1,unknown:1});
  let usd=false;const h=harness(async(url,opts)=>{
   const r=await fetch(base+(url.startsWith('/router/usage/summary')?path:url),opts);
   if(url==='/router/pricing'&&usd){const d=await r.json();return response({...d,fx:null})}return r;
  },true);
  await h.nodes['usage-refresh'].fire();await tick();
  const n=h.nodes,input=n['usage-model'],list=n['usage-model-options'],root=n['usage-chart'].children[0];
  const day=root.children.find(e=>e.attrs.class==='usage-day');day.fire('focus');
  const costs={inputTokens:(2880607-575232)*raw.input_cost_per_token,outputTokens:(17767-1397)*raw.output_cost_per_token,cachedTokens:575232*raw.cache_read_input_token_cost,reasoningTokens:1397*raw.output_cost_per_token};
  costs.totalTokens=Object.values(costs).reduce((a,b)=>a+b,0);
  const assertPrices=(currency,preserve=true)=>{
   const fmt=v=>new Intl.NumberFormat('es-ES',{maximumSignificantDigits:6}).format(v*(currency==='€'?.89397:1));
   assert.equal(n['usage-total'].textContent,`totalTokens · 2.898.374 (≈ ${fmt(costs.totalTokens)} ${currency})`);
   for(const id of ['usage-total-breakdown','usage-day-breakdown']) {
    assert.equal(n[id].children.length,4);
    for(const [i,k] of ['inputTokens','outputTokens','cachedTokens','reasoningTokens'].entries()){
     assert.ok(n[id].children[i].textContent.endsWith(`(≈ ${fmt(costs[k])} ${currency})`));
     assert.doesNotMatch(n[id].children[i].textContent,/N\/D/);
    }
   }
   if(preserve)assert.equal(n['usage-chart'].children[0],root);assert.equal(n['usage-model'],input);
  };
  const reads=h.calls.length;
  input.value='openai';input.fire('input');list.children[1].fire('pointerdown');list.children[1].fire('click');assertPrices('€');
  input.fire('click');list.children[0].fire('click');input.value='openai';input.fire('input');
  input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'ArrowDown'});input.fire('keydown',{key:'Enter'});assertPrices('€');
  assert.equal(h.calls.length,reads,'model selection only repaints mounted prices');
  for(const event of ['pointerenter','focus','click','touchstart']){day.fire(event);assertPrices('€')}
  for(const k of Object.keys(sums)){n['usage-metric'].value=k;n['usage-metric'].fire('change');assert.match(n['usage-total'].textContent,/\(≈ [0-9].* €\)/);assert.doesNotMatch(n['usage-total'].textContent,/N\/D/)}
  n['usage-metric'].value='totalTokens';n['usage-metric'].fire('change');
  usd=true;await n['usage-refresh'].fire();assertPrices('USD',false);assert.doesNotMatch(n['usage-total'].textContent,/€/);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));await store.close();await rm(dir,{recursive:true,force:true})}
});

test('requested compact example keeps approximate numeric prices without visible partial notices',async()=>{
 const sums={totalTokens:4830534,inputTokens:4803576,outputTokens:26958,cachedTokens:982656,reasoningTokens:1701};
 const d={from:'2026-10-08',to:'2026-10-08',accounts:[],days:[{date:'2026-10-08',attempts:2,incomplete:1,metrics:Object.fromEntries(Object.entries(sums).map(([k,sum])=>[k,{sum,known:1,unknown:1}]))}]};
 const model={provider:'fixture',id:'compact',rates:{input:.000002,output:.00001,cache:.0000001,reasoning:.00001}};
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:url==='/router/pricing'?{catalog:{currency:'USD',models:[model]},fx:{base:'USD',quote:'EUR',rate:.89397}}:d)),true,JSON.stringify(['fixture','compact']));await tick();const n=h.nodes;
 const inline=id=>n[id].children.map(c=>c.textContent).join('');
 const breakdown=' · Entrada: 4.803.576 (≈ 6,83158 €) · Salida: 26.958 (≈ 0,22579 €) · Caché: 982.656 (≈ 0,0878465 €) · Razonamiento: 1701 (≈ 0,0152064 €)';
 assert.equal(n['usage-total'].textContent+inline('usage-total-breakdown'),'totalTokens · 4.830.534 (≈ 7,16042 €)'+breakdown);
 const day=n['usage-chart'].children[0].children.find(c=>c.attrs.class==='usage-day');day.fire('focus');
 assert.equal(n['usage-tooltip'].textContent+inline('usage-day-breakdown'),'8 oct 2026 · 4.830.534 tokens (≈ 7,16042 €)'+breakdown);
 for(const id of ['total','total-breakdown','tooltip','day-breakdown','status','pricing-status'])assert.doesNotMatch(n['usage-'+id].textContent,/parcial|con desconocidos|desconocido no equivale a cero|N\/D/i);
 assert.match(day.attrs['aria-label'],/1 conocidos \/ 1 desconocidos/,'unknown coverage stays accessible');
 d.days[0].metrics=metrics(null,0,2);await n['usage-refresh'].fire();
 assert.equal(n['usage-total'].textContent,'totalTokens · Desconocido (N/D)');
 assert.ok(n['usage-total-breakdown'].children.every(c=>/Desconocido \(N\/D\)/.test(c.textContent)));
 d.accountsTruncated=true;await n['usage-refresh'].fire();assert.equal(n['usage-status'].textContent,'Lista histórica limitada a 500 cuentas.');
});

test('compact filter-to-total and day-to-card spacing removes obsolete reserves only',()=>{
 // CSS/markup contract, not a browser measurement: empty live regions stay in
 // the DOM; populated notices can wrap without a fixed height or clipping.
 assert.match(html,/<p id="usage-pricing-status" role="status" aria-live="polite"><\/p>\s*<p id="usage-status" role="status" aria-live="polite"><\/p>\s*<p class="usage-summary">/);
 assert.match(css,/#usage-status, #usage-pricing-status \{ margin: \.75rem 0; \}/);
 assert.match(css,/#usage-status:empty, #usage-pricing-status:empty \{ display: none; \}/);
 for(const selector of ['#usage-status','#usage-pricing-status']) {
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].trim().split(/,\s*/).includes(selector));
  assert.ok(rules.length);
  for(const rule of rules) assert.doesNotMatch(rule[2],/min-height:|(?:^|;)\s*height:|overflow:\s*(?:hidden|clip)/);
 }
 assert.match(css,/\.usage-summary \{ min-height: 1\.8em; margin: \.75rem 0;[^}]*line-height: 1\.8;/);
 assert.match(css,/#usage-chart \+ \.usage-summary \{ margin-bottom: 0; \}/);
 assert.doesNotMatch(css,/min-height: (?:4\.5|9)rem/);
 assert.match(css,/#usage-panel \{[^}]*padding: 1\.25rem;/);
 assert.match(css,/#usage-chart \{ aspect-ratio: 960 \/ 300; \}/);
 assert.match(css,/#usage-chart svg \{[^}]*height: 100%; overflow: visible;/);
 assert.match(css,/\.usage-day:focus \.usage-hit, \.usage-day:hover \.usage-hit \{[^}]*stroke: CanvasText;/);
 assert.match(html,/<div id="usage-chart"><\/div>\s*<p class="usage-summary" role="status" aria-live="polite">[\s\S]*?<\/p>\s*<ul id="usage-fallback" class="sr-only"[^>]*><\/ul>\s*<\/section>/);
});

test('all six filters share desktop grid row with shrinkable controls and responsive non-clipping popup',()=>{
 const controls=html.match(/<div class="usage-controls">([\s\S]*?)<p id="usage-pricing-status"/)[1];
 assert.deepEqual([...controls.matchAll(/id="(usage-(?:account|metric|model|from|to|refresh))"/g)].map(m=>m[1]),['usage-account','usage-metric','usage-model','usage-from','usage-to','usage-refresh']);
 assert.equal((controls.match(/<label\b/g)??[]).length,5);
 assert.match(css,/\.usage-controls\s*\{ display: grid; grid-template-columns: (?:minmax\(0, [\d.]+fr\) ){5}auto;[^}]*align-items: end;[^}]*min-width: 0;/);
 assert.match(css,/\.usage-controls > \* \{ min-width: 0; \}/);
 assert.match(css,/\.usage-controls input, \.usage-controls select \{[^}]*box-sizing: border-box; width: 100%; min-width: 0; margin: 0;/);
 assert.match(css,/\.usage-controls label \{ display: grid; gap: \.3rem; \}/);
 assert.match(css,/@media \(max-width: 60rem\)\s*\{\s*\.usage-controls \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
 assert.match(css,/@media \(max-width: 30rem\)\s*\{\s*\.usage-controls \{ grid-template-columns: minmax\(0, 1fr\);/);
 assert.match(css,/#usage-model \{ width: 100%; min-width: 0;/);
 assert.match(css,/\.usage-model-control \{ position: relative;/);
 assert.match(css,/#usage-model-options \{ position: absolute; z-index: 2; top: 100%; left: 0; right: 0;/);
 for(const selector of ['#usage-panel','.usage-controls','.usage-model-control']){
  const rule=css.match(new RegExp(selector.replaceAll('.', '\\.')+' \\{([^}]+)\\}'))[1];
  assert.doesNotMatch(rule,/overflow:\s*(hidden|clip)|height:/);
 }
 assert.match(css,/#usage-total, #usage-tooltip \{ font-size: 1\.1em; font-weight: 700; line-height: 1; \}/);
});

test('range overflow rejects rounded totals and recovers without making unknown zero',async()=>{
 let d={from:'2026-10-01',to:'2026-10-03',accounts:[],days:[Number.MAX_SAFE_INTEGER,1,1].map((sum,i)=>({date:`2026-10-0${i+1}`,attempts:1,incomplete:0,metrics:metrics(sum,1,0)}))};
 const h=harness(url=>Promise.resolve(response(url==='/router/status'?{upstreams:[]}:d)));await tick();
 assert.equal(h.nodes['usage-total'].textContent,'');assert.equal(h.nodes['usage-chart'].children.length,0);assert.match(h.nodes['usage-status'].textContent,/Uso no disponible/);
 d={...d,days:[{date:'2026-10-01',attempts:1,incomplete:0,metrics:metrics(null,0,1)}]};
 await h.nodes['usage-refresh'].fire();await tick();assert.match(h.nodes['usage-total'].textContent,/Desconocido/);
});
