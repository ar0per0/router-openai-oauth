"use strict";
// Cache/input and reasoning/output are subsets, not additional totals.
globalThis.RouterPricing = (() => {
 const rate=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
 const known=m=>m&&m.known>0&&Number.isSafeInteger(m.sum)&&m.sum>=0;
 const complete=m=>known(m)&&m.unknown===0;
 const cost=(tokens,price)=>tokens===0?0:price===null?null:rate(tokens*price);
 const estimate=(metrics,model)=>{
  const r=model.rates, parts={}, partial={};
  const pair=(parentKey,subsetKey,parentRate,subsetRate)=>{
   const p=metrics[parentKey],s=metrics[subsetKey],kp=known(p),ks=known(s);
   const valid=kp&&ks&&s.sum<=p.sum;
   // Unequal coverage cannot prove a row-wise split: use the reasonable known
   // subtraction only as an approximation. An impossible split is not added.
   const uncertain=!complete(p)||!complete(s)||!valid;
   parts[parentKey]=kp?cost(p.sum-(valid?s.sum:0),parentRate):null;
   parts[subsetKey]=ks&&(!kp||valid)?cost(s.sum,subsetRate):null;
   partial[parentKey]=partial[subsetKey]=uncertain;
   const values=[parts[parentKey],parts[subsetKey]].filter(v=>v!==null);
   return {value:values.length?rate(values.reduce((a,b)=>a+b,0)):null,
    partial:uncertain||parts[parentKey]===null||parts[subsetKey]===null};
  };
  const input=pair('inputTokens','cachedTokens',rate(r.input),rate(r.cache));
  const output=pair('outputTokens','reasoningTokens',rate(r.output),rate(r.reasoning)??rate(r.output));
  const values=[input.value,output.value].filter(v=>v!==null);
  parts.totalTokens=values.length?rate(values.reduce((a,b)=>a+b,0)):null;
  partial.totalTokens=input.partial||output.partial||!complete(metrics.totalTokens);
  // Missing tariffs affect the combined coverage, but do not erase other costs.
  return {...parts,partial};
 };
 const format=(value,fx)=>{
  if(value===null||!Number.isFinite(value))return ' (N/D)';
  const converted=fx?value*fx.rate:value;
  if(!Number.isFinite(converted))return ' (N/D)';
  const currency=fx?'€':'USD';
  const n=new Intl.NumberFormat('es-ES',{maximumSignificantDigits:6}).format(converted);
  return ` (≈ ${n} ${currency})`;
 };
 return {estimate,format};
})();
