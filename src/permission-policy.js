import {can,any} from '../public/permissions.js';
const deny=()=>{throw Object.assign(Error('Bu ekran veya işlem için yetkiniz yok. Yöneticiniz Ekip ve yetkiler ekranından izin verebilir.'),{status:403});};
export function permit(user,path,method){
 if(user.owner||path==='/api/auth/logout')return;
 if(path.startsWith('/api/admin'))deny();
 if(path.startsWith('/api/webshop/')){if(!can(user,'ec','webshop',!['GET','HEAD'].includes(method)))deny();return;}
 const match=path.match(/^\/api\/(ec|lp)(\/.*)?$/),ns=match?.[1]||'lp',sub=match?(match[2]||''):path.slice(4);
 if(user[ns+'_access']==='none')deny();
 const write=!['GET','HEAD'].includes(method),parts=sub.split('/').filter(Boolean),head=parts[0];
 if(!head||!match&&head==='data'){if(write)deny();return;}
 if(['settings','connections','integrations','recovery','attention'].includes(head)){if(head==='settings'&&!write&&sub==='/settings'&&can(user,ns,ns==='ec'?'invoices':'accounts'))return;deny();}
 let feature;
 if(!match){if(!['products','materials','recipes'].includes(head))deny();feature=head;}
 else if(head==='production'){feature=parts[1]==='material-stock'?'materialstock':parts.length===1&&!write?'production-read':'production';}
 else feature=({products:ns==='ec'?'stock':'products',stock:ns==='ec'?'stock':'accounts',sales:ns==='ec'?'sales':'accounts',returns:ns==='ec'?'sales':'accounts',fees:ns==='ec'?'sales':'accounts',expenses:ns==='ec'?'expenses':'accounts',invoices:ns==='ec'?'invoices':'accounts',purchases:ns==='ec'?'invoices':'accounts',suppliers:ns==='ec'?'ledger':'accounts',payments:'ledger',catalog:'catalog',ledger:'ledger',statement:'ledger',offers:'offers',pricing:'pricing',reconciliation:'reconciliation',orders:'orders',performance:'performance'})[head];
 // Barkod yalnizca uretim alanindadir. Okumak icin kart gorme yetkisi yeter;
 // bagla/degistir icin depo ya da uretim yetkisi gerekir.
 // Parti ve koli etiketi uretim kayitlarina aittir; okumak icin urun gormek yeter.
 if(head==='lots'){if(ns!=='lp'||!match)deny();if(!any(user,'lp',write?['production','materialstock']:['products','production','materialstock','recipes']))deny();return;}
 if(head==='barcodes'){if(ns!=='lp'||!match)deny();if(!any(user,'lp',write?['materialstock','production']:['materials','products','materialstock','production','recipes']))deny();if(method==='DELETE'&&!user.permissions?.delete_records)deny();return;}
 if(feature==='production-read'){if(!any(user,'lp',['production','materialstock']))deny();return;}
 if(!feature||!can(user,ns,feature,write&&sub!=='/pricing/quote'))deny();
 if(method==='DELETE'&&(!user.permissions?.delete_records||ns==='lp'&&head==='products'&&!can(user,'lp','recipes',true)))deny();
 if(head==='orders'&&parts.at(-1)==='estimate'&&!can(user,ns,'pricing'))deny();
}
export function filterAccounting(x,user,ns){if(!user||user.owner)return x;if(ns==='lp')return can(user,ns,'accounts')?x:{...x,stock:[],sales:[],expenses:[],suppliers:[],invoices:[],movements:[],pending_fee_cents:null};return {...x,stock:any(user,ns,['stock','sales','invoices'])?x.stock:[],sales:can(user,ns,'sales')?x.sales:[],expenses:can(user,ns,'expenses')?x.expenses:[],suppliers:can(user,ns,'invoices')?x.suppliers.map(({balance_cents,purchase_cents,paid_cents,...s})=>s):[],invoices:can(user,ns,'invoices')?x.invoices:[],movements:can(user,ns,'stock')?x.movements:[],pending_fee_cents:any(user,ns,['reconciliation','performance'])?x.pending_fee_cents:null};}
export function filterProductionData(x,user){if(!user||user.owner)return x;return {...x,products:any(user,'lp',['products','recipes','costs'])?x.products:[],materials:any(user,'lp',['materials','recipes','costs'])?x.materials:[],recipes:any(user,'lp',['recipes','costs'])?x.recipes:[],activity:[]};}
export function filterProductionStock(x,user){if(!user||user.owner||can(user,'lp','production'))return x;return {...x,recipes:[],jobs:[]};}
export function filterInsights(x,user,ns){if(!user||user.owner||can(user,ns,'invoices'))return x;return {...x,purchase_invoices:[],purchase_invoices_truncated:false,fee_evidence:x.fee_evidence.map(({invoice_id,invoice_no,invoice_date,description,...e})=>e)};}

// Tutar yetkisi kapali kullanici icin para bilgisi yanittan cikarilir.
// Tek noktada uygulanir: yeni bir uc eklendiginde gizlemeyi ayrica hatirlamak gerekmez.
// Miktar, sevk ve durum bilgisi aynen kalir; yalnizca parasal alanlar null olur.
const MONEY_KEY=/(^|_)(cents|price|sale_price|unit_cost)$|_cents$/;
const MONEY_NAMES=new Set(['price','sale_price','unit_cost','amount','total_cost','rate_bps','revenue_share_bps']);
export function scrubAmounts(payload,user,ns){
 if(user?.owner||can(user,ns,'amounts'))return payload;
 const seen=new WeakSet();
 const walk=value=>{
  if(Array.isArray(value))return value.map(walk);
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return value;
  seen.add(value);
  const out={};
  for(const [key,item] of Object.entries(value))out[key]=MONEY_KEY.test(key)||MONEY_NAMES.has(key)?null:walk(item);
  return out;
 };
 return walk(payload);
}
