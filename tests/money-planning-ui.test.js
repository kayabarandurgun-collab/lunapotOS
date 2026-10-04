import test from 'node:test';
import assert from 'node:assert/strict';
import {planningMoney,moneyCalendarMarkup,businessResultMarkup,mountMoneyPlanning} from '../public/money-planning-ui.js';

const total={amount_cents:0,count:0,unknown:0,known_cents:0,net_only_cents:0};
const calendar={workspace:'ec',mode:'calendar',from:'2026-09-01',to:'2026-09-30',today:'2026-09-10',rows:[],access:{expenses:true},summary:{expected:{incoming:total,outgoing:total},recorded:{incoming:total,outgoing:total},bank_confirmed_incoming_cents:0,recorded_net_cents:0},notice:'Kapsam',cash_notice:'Nakit notu'};
const result={summary:{operating_result_cents:null,calculated_result_cents:null,contribution_cents:null,overhead_cents:0,packages:1,overhead_records:0,missing_packages:1,estimated_packages:0,unallocated_fee_cents:0},status:'incomplete',expense_categories:[],packages:[],overhead:[],completeness_notice:'Bilgi eksik',notice:'Kapsam',cost_notice:'Maliyet notu'};

test('unknown values render as missing; XSS content and non-source URLs never become markup',()=>{
  assert.equal(planningMoney(null),'Bilgi eksik');assert.equal(planningMoney(undefined),'Bilgi eksik');assert.equal(planningMoney(NaN),'Bilgi eksik');assert.equal(planningMoney('100'),'Bilgi eksik');assert.match(planningMoney(0),/0,00/);
  const malicious='<img src=x onerror=alert(1)>',row={id:'a',label:malicious,reference:'" onfocus="alert(1)',party_name:malicious,note:malicious,kind:'ledger',state:'expected',group:'expected',direction:'incoming',date:'2026-09-10',in_range:true,amount_cents:null,net_cents:500,basis:'net',source_link:'javascript:alert(1)'};
  const html=moneyCalendarMarkup({...calendar,rows:[row]});assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('href="javascript:'));assert.match(html,/KDV hariç/);assert.match(html,/Nakit tutarı bilinmiyor/);
  const net=businessResultMarkup({...result,packages:[{id:'a',reference:malicious,label:malicious,missing:[malicious],date:'2026-09-10',profit_cents:null,source_link:'https://outside.invalid/'}]});assert.ok(!net.includes('<img'));assert.ok(!net.includes('href="https:'));assert.match(net,/Bilgi eksik/);assert.match(net,/tam işletme sonucu/i);
});

function fakeRoot() {
  const handlers=new Map(),attrs=new Map(),classes=new Set();
  return {innerHTML:'',handlers,attrs,classes,classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)},setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),
    querySelector:()=>null,contains:()=>true,addEventListener(type,fn,{signal}){handlers.set(type,fn);signal.addEventListener('abort',()=>handlers.delete(type),{once:true});}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('missing permissions cause no requests; disposal aborts reads, detaches handlers and rejects late results',async()=>{
  const originalFetch=globalThis.fetch,originalLocation=globalThis.location,originalHistory=globalThis.history;
  let requests=0,resolveFetch,signal;
  globalThis.location={hash:'#money?from=2026-09-01&to=2026-09-30'};globalThis.history={replaceState(){}};
  globalThis.fetch=(_url,options)=>{requests++;signal=options.signal;return new Promise(resolve=>{resolveFetch=resolve;});};
  try {
    const denied=fakeRoot(),disposeDenied=mountMoneyPlanning(denied,'ec',{ec_access:'none'});assert.equal(requests,0);assert.match(denied.innerHTML,/yetki gerekiyor/);disposeDenied();
    const root=fakeRoot(),dispose=mountMoneyPlanning(root,'ec',{owner:true});assert.equal(requests,1);assert.equal(root.attrs.get('aria-busy'),'true');assert.equal(root.handlers.size,2);
    dispose();assert.equal(signal.aborted,true);assert.equal(root.handlers.size,0);assert.equal(root.classes.has('money-planning'),false);
    root.innerHTML='Next route';resolveFetch({ok:true,json:async()=>calendar});await tick();assert.equal(root.innerHTML,'Next route');
  }finally {globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;if(originalHistory===undefined)delete globalThis.history;else globalThis.history=originalHistory;}
});

test('wrong workspace/date response is rejected; network failure recovers through retry',async()=>{
  const originalFetch=globalThis.fetch,originalLocation=globalThis.location,originalHistory=globalThis.history;
  globalThis.location={hash:'#money?from=2026-09-01&to=2026-09-30'};globalThis.history={replaceState(){}};
  let count=0;globalThis.fetch=async()=>({ok:true,json:async()=>++count===1?{...calendar,workspace:'lp'}:calendar});
  const root=fakeRoot(),dispose=mountMoneyPlanning(root,'ec',{owner:true});
  try {
    await tick();assert.match(root.innerHTML,/doğrulanamadı/);assert.ok(!root.innerHTML.includes('Beklenen giriş'));
    const button={disabled:false,hasAttribute:key=>key==='data-money-retry'};root.handlers.get('click')({target:{closest:()=>button}});await tick();assert.match(root.innerHTML,/Beklenen giriş/);assert.equal(root.attrs.get('aria-busy'),'false');
  }finally{dispose();globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;if(originalHistory===undefined)delete globalThis.history;else globalThis.history=originalHistory;}
});

