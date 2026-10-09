"use strict";
(() => {
 const el = id => document.getElementById(id);
 const account=el('usage-account'), metric=el('usage-metric'), from=el('usage-from'), to=el('usage-to');
 const status=el('usage-status'), total=el('usage-total'), chart=el('usage-chart'), tooltip=el('usage-tooltip'), fallback=el('usage-fallback');
 const number=new Intl.NumberFormat('es-ES'), compact=new Intl.NumberFormat('es-ES',{notation:'compact'});
 const dates=new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Madrid'});
 const shortDate=new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',timeZone:'Europe/Madrid'});
 let task=null, data=null, configured=[], selectedDay=null, accountOptions=null;
 let pricing=null, selectedModel=null, pricingTask=null, refreshPricing=null, repaint=null, closePricing=null;
 const modelSelect=el('usage-model'), modelOptions=el('usage-model-options'), pricingStatus=el('usage-pricing-status');
 const price=(metrics,key)=>{
  if(!selectedModel||!globalThis.RouterPricing)return '';
  const estimate=RouterPricing.estimate(metrics,selectedModel);
  return RouterPricing.format(estimate[key],pricing?.fx);
 };
 const totalBreakdown=el('usage-total-breakdown'), dayBreakdown=el('usage-day-breakdown');
 const keys=['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens'];
 const labels={inputTokens:'Entrada',outputTokens:'Salida',cachedTokens:'Caché',reasoningTokens:'Razonamiento'};
 const subsetLabels={cachedTokens:'Caché (incluida en entrada)',reasoningTokens:'Razonamiento (incluido en salida)'};
 const metricText=m=>m.known?number.format(m.sum):m.unknown?'Desconocido':'Sin datos';
 const emptyMetrics=metrics=>keys.every(k=>metrics[k].known===0&&metrics[k].unknown===0);
 const showBreakdown=(node,metrics)=>{
  node.replaceChildren();
  if(emptyMetrics(metrics))return;
  for(const [key,label] of Object.entries(labels)) {
   const text=metricText(metrics[key])+price(metrics,key);
   const item=add(node,'span',` · ${label}: ${text}`);
   if(subsetLabels[key]) item.setAttribute('aria-label',`${subsetLabels[key]}: ${text}`);
  }
 };
 const clearData=()=>{data=null;repaint=null;chart.replaceChildren();fallback.replaceChildren();total.textContent='';tooltip.textContent='';totalBreakdown.textContent='';dayBreakdown.textContent='';};
 const options=controller=>({signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
 const alias=v=>typeof v==='string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
 const add=(parent,tag,text)=>{const n=document.createElement(tag); n.textContent=text; parent.appendChild(n);return n;};
 const svg=(parent,tag,attrs,text='')=>{
  const n=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [k,v] of Object.entries(attrs)) n.setAttribute(k,String(v));
  n.textContent=text;parent.appendChild(n);return n;
 };
 const validNumber=v=>Number.isSafeInteger(v)&&v>=0;
 // Calendar validation uses integers, never Date's normalization of impossible days.
 const calendar=(year,month,day)=>{
  const leap=year%4===0&&(year%100!==0||year%400===0);
  return year>=2000&&year<=9998&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
 };
 const toISO=value=>{
  const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if(!match||!calendar(+match[3],+match[2],+match[1])) throw Error();
  return `${match[3]}-${match[2]}-${match[1]}`;
 };
 const toSpanish=value=>{
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match||!calendar(+match[1],+match[2],+match[3])) throw Error();
  return `${match[3]}/${match[2]}/${match[1]}`;
 };
 const validate=d=>{
  if(!d || !Array.isArray(d.days)||d.days.length<1||d.days.length>31||!Array.isArray(d.accounts)) throw Error();
  for(const day of d.days) {
   toSpanish(day.date);
   if(!validNumber(day.attempts)||!validNumber(day.incomplete)) throw Error();
   for(const key of keys) {
    const m=day.metrics?.[key];
    if(!m||!validNumber(m.known)||!validNumber(m.unknown)||m.known+m.unknown!==day.attempts || (m.sum!==null&&!validNumber(m.sum)) || (m.known===0)!==(m.sum===null)) throw Error();
   }
  }
  // Per-day safe integers do not guarantee a safe period aggregate.
  for(const key of keys) for(const field of ['sum','known','unknown']) {
   let sum=0;
   for(const day of d.days) {const value=day.metrics[key][field];if(value===null)continue;sum+=value;if(!Number.isSafeInteger(sum))throw Error();}
  }
  return d;
 };
 const accounts=()=>{
  const selected=account.value;
  const aliases=[...new Set([...configured,...(data?.accounts??[]),selected].filter(alias))].sort();
  const signature=JSON.stringify([aliases,configured]);
  if(accountOptions===signature) return;
  accountOptions=signature;
  account.replaceChildren();const all=add(account,'option','Todas las cuentas');all.value='';
  for(const a of aliases) {const n=add(account,'option',a+(configured.includes(a)?'':' (histórico)')); n.value=a;}
  account.value=selected;
 };
 const render=()=>{
  if(!data) return;
  chart.replaceChildren(); fallback.replaceChildren(); dayBreakdown.textContent=''; tooltip.textContent='Selecciona un día con puntero, foco o toque.';
  const key=metric.value, days=data.days;
  const values=days.map(d=>d.metrics[key]);
  const known=values.reduce((s,m)=>s+m.known,0), unknown=values.reduce((s,m)=>s+m.unknown,0);
  const sum=values.reduce((s,m)=>s+(m.sum??0),0);
  total.textContent=`${key} · ${known?number.format(sum):unknown?'Desconocido':'Sin datos'}`;
  const aggregates=Object.fromEntries(keys.map(k=>[k,{
   sum:days.some(d=>d.metrics[k].known>0)?days.reduce((s,d)=>s+(d.metrics[k].sum??0),0):null,
   known:days.reduce((s,d)=>s+d.metrics[k].known,0),
   unknown:days.reduce((s,d)=>s+d.metrics[k].unknown,0),
  }]));
  const paintTotal=()=>{total.textContent=emptyMetrics(aggregates)?'Sin datos':`${key} · ${known?number.format(sum):unknown?'Desconocido':'Sin datos'}${price(aggregates,key)}`;totalBreakdown.textContent='';if(key==='totalTokens') showBreakdown(totalBreakdown,aggregates);};
  repaint=()=>{paintTotal();const d=days.find(d=>d.date===selectedDay);if(d){tooltip.textContent=`${dates.format(new Date(d.date+'T12:00:00Z'))} · ${d.metrics[key].sum===null?(d.attempts?'Consumo desconocido':'Sin datos'):number.format(d.metrics[key].sum)+' tokens'}${emptyMetrics(d.metrics)?'':price(d.metrics,key)}`;if(key==='totalTokens') showBreakdown(dayBreakdown,d.metrics);}};
  paintTotal();
  status.textContent=data.accountsTruncated?'Lista histórica limitada a 500 cuentas.':'';
  const root=svg(chart,'svg',{viewBox:'0 0 960 300',role:'group','aria-label':`Uso diario ${key}; foco en cada día para detalles`});
  const max=Math.max(1,...values.map(m=>m.sum??0));
  for(let i=0;i<=3;i++) {
   const y=240-i*65;
   svg(root,'line',{x1:80,x2:940,y1:y,y2:y,class:'usage-grid'});
   svg(root,'text',{x:68,y:y+5,'text-anchor':'end',class:'usage-axis'},compact.format(max*i/3));
  }
  const step=850/days.length;
  const points=days.map((d,i)=>({x:80+step*(i+.5),y:240-(d.metrics[key].sum??0)/max*195}));
  // Only connect adjacent fully-known days. Missing/partial days never invent a zero line.
  for(let i=1;i<days.length;i++) if(values[i-1].known && !values[i-1].unknown && values[i].known && !values[i].unknown)
   svg(root,'line',{x1:points[i-1].x,y1:points[i-1].y,x2:points[i].x,y2:points[i].y,class:'usage-line'});
  const dayGroups=[];
  days.forEach((d,i)=>{
   const m=values[i],p=points[i],date=new Date(d.date+'T12:00:00Z');
   const state=d.attempts===0?'Sin datos':m.known===0?'Desconocido':m.unknown?'Parcial':'Reportado';
   const description=`${dates.format(date)} · ${m.sum===null?'Sin consumo conocido':number.format(m.sum)+' tokens reportados'} · ${state} · ${number.format(m.known)} conocidos / ${number.format(m.unknown)} desconocidos · ${number.format(d.incomplete)} incompletos/no entregados`;
   const tooltipText=`${dates.format(date)} · ${m.sum===null?(d.attempts?'Consumo desconocido':'Sin datos'):number.format(m.sum)+' tokens'}`;
   add(fallback,'li',description);
   const group=svg(root,'g',{tabindex:0,role:'img','aria-label':description,'aria-describedby':'usage-tooltip usage-day-breakdown',class:'usage-day'});
   dayGroups.push(group);
   group.setAttribute('data-selected',String(selectedDay===d.date));
   svg(group,'rect',{x:80+step*i,y:30,width:step,height:216,class:'usage-hit'});
   if(m.sum!==null) svg(group,'circle',{cx:p.x,cy:p.y,r:m.unknown?5:4,class:m.unknown?'usage-partial':'usage-point'});
   else svg(group,'text',{x:p.x,y:232,'text-anchor':'middle',class:'usage-axis'},d.attempts?'?':'–');
   const show=()=>{selectedDay=d.date;for(const dayGroup of dayGroups) dayGroup.setAttribute('data-selected',String(dayGroup===group));tooltip.textContent=tooltipText+(emptyMetrics(d.metrics)?'':price(d.metrics,key));dayBreakdown.textContent='';if(key==='totalTokens') showBreakdown(dayBreakdown,d.metrics);};
   if(selectedDay===d.date) show();
   for(const event of ['pointerenter','focus','click','touchstart']) group.addEventListener(event,show);
   if(i===0||i===Math.floor(days.length/2)||i===days.length-1) svg(root,'text',{x:p.x,y:275,'text-anchor':'middle',class:'usage-axis'},shortDate.format(date));
  });
 };
 const read=async()=>{
  const params=new URLSearchParams();
  for(const n of [from,to]) n.setAttribute('aria-invalid','false');
  try {
   if(from.value) params.set('from',toISO(from.value));if(to.value) params.set('to',toISO(to.value));
   if(from.value&&to.value) {
    const start=Date.parse(params.get('from')+'T00:00:00Z'),end=Date.parse(params.get('to')+'T00:00:00Z');
    if(end<start||end-start>30*86400000) throw Error();
   }
  } catch {
   task?.controller.abort();task=null;clearData();
   for(const n of [from,to]) n.setAttribute('aria-invalid','true');
   status.textContent='Fechas no válidas. Usa dd/mm/aaaa (años 2000–9998), Desde no posterior a Hasta y máximo 31 días incluidos.';
   return;
  }
  if(account.value) params.set('account',account.value);
  const key=params.toString();
  if(task?.key===key) return task.promise;
  task?.controller.abort();
  const current={key,controller:new AbortController()};task=current;
  status.textContent='Consultando uso…';clearData();
  current.promise=(async()=>{
   try {
    const response=await fetch('/router/usage/summary'+(key?'?'+key:''),options(current.controller));
    if(task!==current) return;
    if(!response.ok) throw Error();
    const result=validate(await response.json());
    if(task!==current) return;
    const start=toSpanish(result.from),end=toSpanish(result.to);
    data=result;from.value=start;to.value=end;accounts();render();
   } catch {if(task===current) status.textContent='Uso no disponible. Revisa fechas (máximo 31 días) o almacenamiento y pulsa Refrescar.';}
   finally {if(task===current) task=null;}
  })();
  return current.promise;
 };
 let statusTask=new AbortController();
 const readStatus=async()=>{
  try {
   const response=await fetch('/router/status',options(statusTask));if(!response.ok) return;
   const result=await response.json();if(statusTask.signal.aborted) return;
   configured=(result.upstreams??[]).map(a=>a.alias).filter(alias);accounts();
  } catch { /* Usage remains independent of circuit status availability. */ }
 };
 // One editable combobox; pricing changes only repaint mounted summaries.
 if(modelSelect&&modelOptions&&pricingStatus) {
  const identity=m=>JSON.stringify([m.provider,m.id]);
  const label=m=>m?`${m.provider} · ${m.id}`:'Sin simulación';
  let saved='', visible=[], active=-1, opened=false;
  try {saved=localStorage.getItem('router.pricing.model')??'';} catch {}
  const notice=()=>{
   pricingStatus.textContent=!pricing?.catalog?'Catálogo no disponible. Pulsa Refrescar.':
    !pricing.fx?'Cambio no disponible: importes en USD. Pulsa Refrescar.':'';
  };
  const markActive=()=>{
   modelSelect.removeAttribute('aria-activedescendant');
   Array.from(modelOptions.children).forEach((option,i)=>{
    option.setAttribute('class',i===active?'usage-model-active':'');
    if(i===active){
     modelSelect.setAttribute('aria-activedescendant',option.id);
     const top=option.offsetTop,bottom=top+option.offsetHeight;
     if(top<modelOptions.scrollTop)modelOptions.scrollTop=top;
     else if(bottom>modelOptions.scrollTop+modelOptions.clientHeight)modelOptions.scrollTop=bottom-modelOptions.clientHeight;
    }
   });
  };
  const close=()=>{
   opened=false;active=-1;modelOptions.hidden=true;
   modelSelect.setAttribute('aria-expanded','false');
   modelSelect.removeAttribute('aria-activedescendant');
   modelSelect.value=selectedModel?label(selectedModel):'';
  };
  const choose=m=>{
   selectedModel=m;saved=m?identity(m):'';
   try {localStorage.setItem('router.pricing.model',saved);} catch {}
   close();if(data)repaint?.();
  };
  const populate=(query='')=>{
   const normalized=query.trim().toLocaleLowerCase('es');
   visible=[null,...(pricing?.catalog?.models??[])].filter(m=>!m||label(m).toLocaleLowerCase('es').includes(normalized));
   modelOptions.replaceChildren();modelOptions.scrollTop=0;active=-1;
   visible.forEach((m,i)=>{
    const option=add(modelOptions,'li',label(m));option.id=`usage-model-option-${i}`;
    option.setAttribute('role','option');
    option.setAttribute('aria-selected',String(m?identity(m)===saved:!selectedModel));
    option.addEventListener('pointerdown',event=>event.preventDefault());
    option.addEventListener('click',()=>choose(m));
   });
   if(visible.length===1&&normalized)add(modelOptions,'li','Sin coincidencias');
   markActive();
  };
  const open=()=>{
   if(opened)return;
   opened=true;modelOptions.hidden=false;modelSelect.setAttribute('aria-expanded','true');populate();
  };
  modelSelect.addEventListener('focus',open);
  modelSelect.addEventListener('click',open);
  modelSelect.addEventListener('input',()=>{open();populate(modelSelect.value);});
  modelSelect.addEventListener('blur',close);
  document.addEventListener('pointerdown',event=>{
   if(event.target!==modelSelect&&!modelOptions.contains(event.target))close();
  });
  modelSelect.addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();close();return;}
   if(event.key==='Tab'){close();return;}
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();open();
    active=active<0?(event.key==='ArrowDown'?0:visible.length-1):
     (active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length;
    markActive();
   } else if(event.key==='Enter'&&opened){
    event.preventDefault();if(active>=0)choose(visible[active]);
   }
  });
  const loadPricing=async()=>{
   if(pricingTask)return pricingTask.promise;
   const current={controller:new AbortController()};pricingTask=current;
   pricingStatus.textContent='Consultando catálogo y cambio públicos…';
   current.promise=(async()=>{
    try {
     const r=await fetch('/router/pricing',options(current.controller));if(pricingTask!==current)return;if(!r.ok)throw Error();
     const d=await r.json();if(pricingTask!==current)return;
     if(!d||typeof d!=='object')throw Error();
     if(d.catalog&&(!Array.isArray(d.catalog.models)||d.catalog.models.length>15000||d.catalog.currency!=='USD'))throw Error();
     if(d.catalog)for(const m of d.catalog.models){
      if(!m||typeof m.id!=='string'||!m.id||m.id.length>256||typeof m.provider!=='string'||!m.provider||m.provider.length>80||!m.rates||Object.values(m.rates).some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0)))throw Error();
     }
     if(d.fx&&(!(typeof d.fx.rate==='number'&&Number.isFinite(d.fx.rate)&&d.fx.rate>0)||d.fx.base!=='USD'||d.fx.quote!=='EUR'))throw Error();
     pricing=d;selectedModel=(d.catalog?.models??[]).find(m=>identity(m)===saved)??null;
    } catch {if(pricingTask!==current)return;pricing=null;selectedModel=null;}
    finally {if(pricingTask===current){pricingTask=null;if(opened)populate(modelSelect.value);else close();notice();if(data)repaint?.();}}
   })();return current.promise;
  };
  closePricing=close;
  refreshPricing=loadPricing;
  void loadPricing();
 }
 el('usage-refresh').addEventListener('click',()=>Promise.all([read(),refreshPricing?.()]));
 for(const n of [account,from,to]) n.addEventListener('change',read);
 // Invalidate pending results as soon as a date is edited, before change/blur.
 for(const n of [from,to]) n.addEventListener('input',()=>{
  task?.controller.abort();task=null;clearData();status.textContent='Pulsa Refrescar.';
  n.setAttribute('aria-invalid','false');
 });
 // All metrics are already in the response: no network, loading collapse or selector replacement.
 metric.addEventListener('change',()=>{if(data) render();});
 window.addEventListener('pagehide',()=>{
  closePricing?.();
  task?.controller.abort();task=null;statusTask.abort();pricingTask?.controller.abort();pricingTask=null;data=null;
  clearData();status.textContent='Pulsa Refrescar.';
 });
 void readStatus();void read();
})();
