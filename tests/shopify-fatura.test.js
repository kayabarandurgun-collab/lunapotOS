import test from 'node:test';
import assert from 'node:assert/strict';
import {shopifyFaturaApi,tcknOk,vknOk,faturaSatirlari,jetonDogrula} from '../src/shopify-fatura.js';

const SECRET='gizli-deneme',CID='istemci-1',SHOP='79n1pp-x5.myshopify.com',SIMDI=Date.parse('2026-10-23T12:00:00Z');
const b64u=s=>Buffer.from(s).toString('base64url');
async function jeton(y={}){
 const h=b64u(JSON.stringify({alg:'HS256',typ:'JWT'})),p=b64u(JSON.stringify({aud:CID,dest:'https://'+SHOP,exp:SIMDI/1000+300,nbf:SIMDI/1000-10,...y}));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(h+'.'+p))).toString('base64url');
 return h+'.'+p+'.'+sig;
}
const env={SHOPIFY_FATURA_SECRET:SECRET,SHOPIFY_FATURA_CLIENT_ID:CID};
function sahte(order){
 const yazilan=[];
 const fetcher=async(url,init)=>{
  if(url.endsWith('/access_token'))return Response.json({access_token:'t',expires_in:3600});
  const {query,variables}=JSON.parse(init.body);
  if(query.startsWith('query'))return Response.json({data:{order:order&&variables.id===order.id?order:null}});
  yazilan.push(variables.i);return Response.json({data:{orderUpdate:{userErrors:[]}}});
 };
 return {fetcher,yazilan};
}
const istek=async(body,j)=>new Request('https://muhasebe.lunapot.com/api/shopify/fatura',{method:'POST',headers:{Authorization:'Bearer '+(j??await jeton()),'Content-Type':'application/json'},body:JSON.stringify(body)});
const SIPARIS={id:'gid://shopify/Order/5',createdAt:'2026-10-23T11:00:00Z',confirmationNumber:'ABC123',customAttributes:[{key:'Not',value:'kapıya bırak'},{key:'VKN',value:'eski'}]};

test('TCKN ve VKN denetimi teması ile aynı', ()=>{
 assert.equal(tcknOk('10000000146'),true);assert.equal(tcknOk('10000000147'),false);assert.equal(tcknOk('01234567890'),false);
 assert.equal([...'0123456789'].filter(d=>vknOk('123456789'+d)).length,1);assert.equal(vknOk('123456789'),false);
});

test('kurumsal bilgi siparişin ek ayrıntılarına yazılır, diğer ayrıntılar korunur', async()=>{
 const {fetcher,yazilan}=sahte(SIPARIS);const vkn=[...'0123456789'].map(d=>'123456789'+d).find(vknOk);assert.ok(vkn);
 const r=await shopifyFaturaApi(await istek({orderId:SIPARIS.id,number:'ABC123',tip:'kurumsal',unvan:'Deneme Ltd',vkn,vergiDairesi:'Yalova'}),env,{fetcher,simdi:SIMDI});
 assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*');
 assert.deepEqual(yazilan[0].customAttributes,[{key:'Not',value:'kapıya bırak'},{key:'Fatura Tipi',value:'Kurumsal'},{key:'Firma Unvanı',value:'Deneme Ltd'},{key:'VKN',value:vkn},{key:'Vergi Dairesi',value:'Yalova'}]);
});

test('onay numarası tutmazsa, sipariş eskiyse veya jeton bozuksa yazılmaz', async()=>{
 const {fetcher,yazilan}=sahte(SIPARIS),g={orderId:SIPARIS.id,tip:'bireysel',ad:'Ali Veli'};
 assert.equal((await shopifyFaturaApi(await istek({...g,number:'YANLIS'}),env,{fetcher,simdi:SIMDI})).status,404);
 assert.equal((await shopifyFaturaApi(await istek({...g,number:'ABC123'}),env,{fetcher,simdi:SIMDI+73*3600e3})).status,401);
 assert.equal((await shopifyFaturaApi(await istek({...g,number:'ABC123'},(await jeton()).slice(0,-3)+'xyz'),env,{fetcher,simdi:SIMDI})).status,401);
 assert.equal((await shopifyFaturaApi(await istek({...g,number:'ABC123'},await jeton({aud:'baska'})),env,{fetcher,simdi:SIMDI})).status,401);
 assert.equal(yazilan.length,0);
});

test('bireyselde TCKN isteğe bağlı, yanlışsa reddedilir; ön istek CORS döner', async()=>{
 assert.deepEqual(faturaSatirlari({tip:'bireysel',ad:' Ali  Veli '}),[{key:'Fatura Tipi',value:'Bireysel'},{key:'Ad Soyad',value:'Ali Veli'}]);
 assert.throws(()=>faturaSatirlari({tip:'bireysel',ad:'Ali Veli',tckn:'12345678901'}),/kimlik/);
 assert.throws(()=>faturaSatirlari({tip:'kurumsal',unvan:'X Ltd',vkn:'123',vergiDairesi:'Yalova'}),/Vergi numarası/);
 const r=await shopifyFaturaApi(new Request('https://x/api/shopify/fatura',{method:'OPTIONS'}),env);
 assert.equal(r.status,204);assert.match(r.headers.get('Access-Control-Allow-Headers'),/Authorization/);
 await assert.rejects(jetonDogrula(await jeton({dest:'https://baska.myshopify.com'}),SECRET,CID,SHOP,SIMDI/1000),/Oturum/);
});
