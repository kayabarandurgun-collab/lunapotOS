// 1597e37 src/ledger-api.js: yalnız faturasız giriş dalı ve doğrudan yardımcıları.
// Sabit eski sürüm örneği: migration sırasında geciken eski yazıcının atomikliğini sınar.
// Çalışan uygulama bunu kullanmaz; test sırasında git/network gerekmez.
import {cents} from '../../public/accounting-math.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const id=()=>crypto.randomUUID();
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const text=(x,label,max=500)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail(label+' alanını kontrol edin.');return x.trim();};
const optional=(x,max=500)=>x===undefined||x===null||x===''?'':text(x,'Bilgi',max);
const day=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x)fail('Geçerli tarih girin.');return x;};
const money=x=>{let n;try{n=cents(x);}catch{fail('Geçerli bir tutar girin.');}if(!Number.isSafeInteger(n)||!n||Math.abs(n)>100000000000)fail('Tutar sıfır olamaz ve sınırı aşamaz.');return n;};
const milliQty=x=>{const n=Math.round(sayi(x)*1000);if(!Number.isFinite(n)||!Number.isSafeInteger(n)||n<=0||n>1000000000)fail('Miktar geçersiz.');return n;};
const sayi=x=>{if(typeof x==='number')return x;if(typeof x!=='string'||!x.trim())return NaN;const n=Number(x.trim().replace(',','.'));return Number.isFinite(n)?n:NaN;};
const costCents=x=>{const v=sayi(x);if(!Number.isFinite(v))fail('Birim maliyeti kontrol edin.');let n;try{n=cents(v);}catch{fail('Birim maliyeti kontrol edin.');}if(!Number.isSafeInteger(n)||n<0||n>100000000000)fail('Birim maliyet geçersiz.');return n;};
const vatBps=x=>{const n=x===undefined||x===null||x===''?2000:Number(x);if(!Number.isSafeInteger(n)||n<0||n>10000)fail('KDV oranı geçersiz.');return n;};
const positive=x=>{const n=money(x);if(n<0)fail('Tutar pozitif olmalı.');return n;};
async function execute(db,items){try{return await db.batch(items);}catch(error){const m=String(error.message);if(/CHEQUE_DUE_REQUIRED/.test(m))fail('Çek için vade tarihi girin.');if(/INVALID_DUE_DATE|INVALID_PLAN_DATE/.test(m))fail('Geçerli tarih girin.');if(/PAYMENT_ENTRY_REQUIRED/.test(m))fail('Ödeme yöntemi yalnızca ödeme hareketine yazılabilir.',409);if(/DEBT_ENTRY_REQUIRED/.test(m))fail('Planlanan ödeme tarihi yalnızca açık borca eklenebilir.',409);if(/OVER_ALLOCATION/.test(m))fail('Kapama tutarı belgenin kalan tutarını aşıyor.',409);if(/ENTRY_ALLOCATED/.test(m))fail('Önce bu hareketin belge kapamalarını geri alın.',409);if(/INVALID_ALLOCATION/.test(m))fail('Aynı cariye ait bir alacak ve bir borç hareketini seçin.',409);if(/INVALID_CASH_ENTRY/.test(m))fail('Kasa/banka hareketi bağlandığı cari hareketiyle eşleşmiyor.',409);if(/REVERSAL|REVERSED_ENTRY/.test(m))fail('Bu hareket için ters kayıt oluşturulamaz.',409);if(/UNIQUE constraint/.test(m))fail('Bu referans veya kayıt daha önce işlendi.',409);if(/FOREIGN KEY/.test(m))fail('Seçilen kayıt bu çalışma alanında bulunamadı.',404);throw error;}}
async function livingParty(db,key){const row=await stmt(db,'SELECT id,name,archived_at FROM suppliers WHERE id=?',[key]).first();if(!row)fail('Cari bu çalışma alanında bulunamadı.',404);if(row.archived_at)fail(row.name+' arşivlenmiş bir caridir; yeni kayıt yazılamaz. Cari listesinden “Arşivden geri al” deyip yeniden deneyin.',409);return row;}
const entryInsert=(db,e)=>stmt(db,'INSERT INTO party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?)',[e.id,e.party_id,e.amount_cents,e.occurred_on,e.due_on||null,e.reference,e.description,e.source_key,e.source,e.reversal_of||null]);
export async function provisionalHandler0064(db,x){
 const key=id(),path='/api/ledger/provisional';
 if(path==='/api/ledger/provisional'){
  // Gövde ve key yukarıda bir kez okunur (satır 113); ikinci readBody isteği kilitler.
  const party=text(x.supplier_id,'Tedarikçi');
  await livingParty(db,party);
  const date=day(x.occurred_on),reference=text(x.reference,'İrsaliye referansı',200),notes=optional(x.notes,1000);
  // ÖDEME VADESİ isteğe bağlıdır: girilirse cari hareketine yazılır, ekranda "Vade" olarak görünür
  // ve vadesi geçenler işaretlenir. Malın geliş tarihinden önce olamaz.
  const vade=x.due_on===undefined||x.due_on===null||x.due_on===''?null:day(x.due_on);
  if(vade&&vade<date)fail('Ödeme vadesi malın geldiği tarihten önce olamaz.');
  if(!Array.isArray(x.lines)||!x.lines.length)fail('En az bir ürün satırı girin.');
  if(x.lines.length>200)fail('Tek girişte en fazla 200 satır olabilir.');
  const seen=new Set(),rows=[];
  for(const line of x.lines){
   const product=text(line.product_id,'Ürün');
   if(seen.has(product))fail('Aynı ürün iki satırda olamaz; miktarları birleştirin.');
   seen.add(product);
   const qty=milliQty(line.quantity),unit=costCents(line.unit_cost),vat=vatBps(line.vat_bps);
   if(!await stmt(db,'SELECT product_id FROM stock_balances WHERE product_id=?',[product]).first())fail('Ürün bu çalışma alanında bulunamadı.',404);
   rows.push({product,qty,unit,vat,value:Math.round(qty*unit/1000)});
  }
  const brut=rows.reduce((t,r)=>t+Math.round(r.value*(10000+r.vat)/10000),0);
  if(brut<=0)fail('Girişin KDV dahil tutarı sıfırdan büyük olmalı.');
  // Cari satırı ÖNCE yazılır: başlık entry_id ile ona bağlı, ters sırada yabancı anahtar kırılır.
  const entry=id(),statements=[
   entryInsert(db,{id:entry,party_id:party,amount_cents:-brut,occurred_on:date,due_on:vade,reference,
    description:'Faturasız mal girişi · '+reference,source_key:'gecici:'+key,source:'manual'}),
   stmt(db,'INSERT INTO provisional_receipts(id,supplier_id,occurred_on,reference,notes,entry_id) VALUES(?,?,?,?,?,?)',[key,party,date,reference,notes,entry])];
  for(const r of rows){
   statements.push(stmt(db,'INSERT INTO stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(?,?,?,?,?,?,?,?)',
    [id(),r.product,r.qty,r.value,'count','GECICI-SAYIM-'+reference,'Faturasız mal girişi · fatura gelince kapanır',date]));
   statements.push(stmt(db,'INSERT INTO provisional_receipt_lines(id,receipt_id,product_id,quantity_milli,unit_cost_cents,vat_bps) VALUES(?,?,?,?,?,?)',
    [id(),key,r.product,r.qty,r.unit,r.vat]));
  }
  await execute(db,statements);
  return {id:key,amount_cents:-brut};
 }
}
