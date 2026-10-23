// lunapot.com teşekkür sayfasındaki "Fatura bilgisi" eklentisinin (Shopify "Lunapot Fatura" uygulaması) yazdığı uç.
// Plus'sız mağazada ödeme sayfasına TCKN/VKN alanı eklenemiyor; bilgi siparişten hemen sonra alınır ve
// siparişin "Ek ayrıntılar"ına (customAttributes) sepetteki formla AYNI anahtarlarla yazılır.
// Güven: eklentinin oturum jetonu (HS256, uygulama gizli anahtarı) + siparişin onay numarası eşleşmesi + 72 saat sınırı.
// Ortam (ikisi de wrangler secret): SHOPIFY_FATURA_CLIENT_ID, SHOPIFY_FATURA_SECRET. Mağaza sabit: SHOP.
const SHOP='79n1pp-x5.myshopify.com';
const ANAHTAR=['Fatura Tipi','Ad Soyad','TCKN','Firma Unvanı','VKN','Vergi Dairesi'];
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'86400'};
const yanit=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...CORS}});
class Hata extends Error{constructor(m,s=400){super(m);this.status=s;}}

export function tcknOk(v){
 if(!/^[1-9]\d{10}$/.test(v))return false;
 const d=[...v].map(Number),tek=d[0]+d[2]+d[4]+d[6]+d[8],cift=d[1]+d[3]+d[5]+d[7];
 return ((tek*7-cift)%10+10)%10===d[9]&&d.slice(0,10).reduce((a,b)=>a+b,0)%10===d[10];
}
export function vknOk(v){
 if(!/^\d{10}$/.test(v))return false;
 const d=[...v].map(Number);let t=0;
 for(let i=0;i<9;i++){const x=(d[i]+10-(i+1))%10;let y=x===0?0:(x*2**(9-i))%9;if(x!==0&&y===0)y=9;t+=y;}
 return (10-t%10)%10===d[9];
}
const b64u=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
export async function jetonDogrula(jeton,secret,clientId,shop,simdi=Math.floor(Date.now()/1000)){
 const p=String(jeton||'').split('.');if(p.length!==3)throw new Hata('Oturum doğrulanamadı.',401);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('HMAC',key,b64u(p[2]),new TextEncoder().encode(p[0]+'.'+p[1])))throw new Hata('Oturum doğrulanamadı.',401);
 const h=JSON.parse(new TextDecoder().decode(b64u(p[0]))),y=JSON.parse(new TextDecoder().decode(b64u(p[1])));
 if(h.alg!=='HS256'||y.aud!==clientId||!(y.exp>simdi-5)||(y.nbf&&y.nbf>simdi+5))throw new Hata('Oturum doğrulanamadı.',401);
 if(String(y.dest||'').replace(/^https?:\/\//,'').replace(/\/.*$/,'')!==shop)throw new Hata('Oturum doğrulanamadı.',401);
 return y;
}
// Girdi → [{key,value}]. Bireyselde TCKN isteğe bağlı (boşsa e-arşiv 11111111111 ile kesilir), kurumsalda unvan+VKN+vergi dairesi zorunlu.
export function faturaSatirlari(g){
 const s=(v,n=120)=>String(v??'').trim().replace(/\s+/g,' ').slice(0,n);
 const tip=g.tip==='kurumsal'?'Kurumsal':'Bireysel';
 if(tip==='Kurumsal'){
  const unvan=s(g.unvan,200),vkn=s(g.vkn,11).replace(/\D/g,''),vd=s(g.vergiDairesi,80);
  if(unvan.length<2)throw new Hata('Firma unvanını yazın.');
  if(!(vkn.length===10?vknOk(vkn):tcknOk(vkn)))throw new Hata('Vergi numarası geçersiz.');
  if(vd.length<2)throw new Hata('Vergi dairesini yazın.');
  return [{key:'Fatura Tipi',value:tip},{key:'Firma Unvanı',value:unvan},{key:'VKN',value:vkn},{key:'Vergi Dairesi',value:vd}];
 }
 const ad=s(g.ad),tckn=s(g.tckn,11).replace(/\D/g,'');
 if(ad.length<3)throw new Hata('Ad soyad yazın.');
 if(tckn&&!tcknOk(tckn))throw new Hata('T.C. kimlik numarası geçersiz.');
 return [{key:'Fatura Tipi',value:tip},{key:'Ad Soyad',value:ad},...(tckn?[{key:'TCKN',value:tckn}]:[])];
}
let jetonOnbellek=null;
async function adminJeton(env,fetcher){
 if(jetonOnbellek&&jetonOnbellek.son>Date.now())return jetonOnbellek.t;
 const r=await fetcher(`https://${SHOP}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:env.SHOPIFY_FATURA_CLIENT_ID,client_secret:env.SHOPIFY_FATURA_SECRET,grant_type:'client_credentials'})});
 const j=await r.json();if(!j.access_token)throw new Error('shopify jeton alınamadı');
 jetonOnbellek={t:j.access_token,son:Date.now()+((j.expires_in||3600)-120)*1000};return j.access_token;
}
async function gql(env,fetcher,query,variables){
 const r=await fetcher(`https://${SHOP}/admin/api/2026-10/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':await adminJeton(env,fetcher)},body:JSON.stringify({query,variables})});
 const j=await r.json();if(j.errors)throw new Error('shopify '+JSON.stringify(j.errors).slice(0,200));return j.data;
}
export async function shopifyFaturaApi(request,env,{fetcher=fetch,simdi=Date.now()}={}){
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(request.method!=='POST')return yanit({error:'Yöntem desteklenmiyor.'},405);
 try{
  if(!env.SHOPIFY_FATURA_SECRET||!env.SHOPIFY_FATURA_CLIENT_ID)throw new Hata('Fatura bağlantısı kurulmadı.',503);
  await jetonDogrula((request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,''),env.SHOPIFY_FATURA_SECRET,env.SHOPIFY_FATURA_CLIENT_ID,SHOP,Math.floor(simdi/1000));
  const raw=await request.text();if(raw.length>4000)throw new Hata('İstek çok büyük.',413);
  let g;try{g=JSON.parse(raw);}catch{throw new Hata('Geçersiz veri.');}
  if(!/^gid:\/\/shopify\/Order\/\d+$/.test(String(g.orderId)))throw new Hata('Sipariş bulunamadı.',404);
  const satir=faturaSatirlari(g);
  const o=(await gql(env,fetcher,'query($id:ID!){order(id:$id){id createdAt confirmationNumber customAttributes{key value}}}',{id:g.orderId})).order;
  if(!o||(o.confirmationNumber&&o.confirmationNumber!==String(g.number||''))||simdi-Date.parse(o.createdAt)>72*3600e3)throw new Hata('Sipariş bulunamadı.',404);
  const kalan=o.customAttributes.filter(a=>!ANAHTAR.includes(a.key));
  const u=(await gql(env,fetcher,'mutation($i:OrderInput!){orderUpdate(input:$i){userErrors{message}}}',{i:{id:o.id,customAttributes:[...kalan,...satir]}})).orderUpdate;
  if(u.userErrors.length)throw new Error('orderUpdate '+u.userErrors[0].message);
  return yanit({ok:true});
 }catch(e){
  if(e.status)return yanit({error:e.message},e.status);
  console.error('shopify-fatura',e.message);return yanit({error:'Kaydedilemedi. Biraz sonra tekrar deneyin.'},502);
 }
}
