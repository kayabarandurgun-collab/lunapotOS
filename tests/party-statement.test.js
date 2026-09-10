import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStatement, balanceWording, counterpartyDifference, statementFingerprint} from '../public/party-statement.js';

const entry = (id, occurred_on, amount_cents, extra = {}) =>
  ({id, occurred_on, amount_cents, reference: 'REF-' + id, description: 'Hareket ' + id,
    source: 'manual', created_at: occurred_on + 'T09:00:00Z', ...extra});

test('Devir dönem başından önceki bütün hareketlerden gelir, kapanış devir artı dönem',()=>{
 const entries=[
  entry('a','2025-11-10',50000),
  entry('b','2025-12-01',-20000),
  entry('c','2026-01-05',30000),
  entry('d','2026-01-20',-12500),
  entry('e','2026-02-11',9000)
 ];
 const statement=buildStatement({entries,from:'2026-01-01',to:'2026-01-31'});
 assert.equal(statement.opening_cents,30000,'devir: 50000 - 20000');
 assert.equal(statement.debit_cents,30000,'dönem içi alacak');
 assert.equal(statement.credit_cents,12500,'dönem içi borç');
 assert.equal(statement.closing_cents,47500,'kapanış: 30000 + 30000 - 12500');
 assert.equal(statement.row_count,2,'dönem dışı hareketler listeye girmez');
 assert.deepEqual(statement.rows.map(r=>r.running_cents),[60000,47500],'yürüyen bakiye devirden başlar');
 assert.equal(statement.currency,'TRY');
});

test('Borç ve alacak ayrı sütunlarda; tutarlar kuruş tam sayısı kalır',()=>{
 const statement=buildStatement({entries:[entry('a','2026-03-02',123456),entry('b','2026-03-03',-45678)],from:'2026-03-01',to:'2026-03-31'});
 assert.equal(statement.rows[0].receivable_cents,123456);
 assert.equal(statement.rows[0].payable_cents,0);
 assert.equal(statement.rows[1].payable_cents,45678);
 assert.equal(statement.rows[1].receivable_cents,0);
 assert.equal(statement.closing_cents,77778);
 assert.ok(Number.isSafeInteger(statement.closing_cents));
});

test('Kapama ikinci para hareketi sayılmaz; yalnızca kalan tutarı gösterir',()=>{
 const entries=[entry('fatura','2026-03-01',100000),entry('tahsilat','2026-03-10',-40000)];
 const allocations=[{id:'k1',positive_entry_id:'fatura',negative_entry_id:'tahsilat',amount_cents:40000}];
 const statement=buildStatement({entries,allocations,from:'2026-03-01',to:'2026-03-31'});
 assert.equal(statement.closing_cents,60000,'kapama bakiyeyi ayrıca değiştirmemeli');
 assert.equal(statement.debit_cents,100000);
 assert.equal(statement.credit_cents,40000);
 const invoice=statement.rows.find(r=>r.id==='fatura');
 assert.equal(invoice.allocated_cents,40000);
 assert.equal(invoice.remaining_cents,60000,'faturanın kapanmayan kısmı');

 const reversed=buildStatement({entries,allocations:[{...allocations[0],reversed_by:'x'}],from:'2026-03-01',to:'2026-03-31'});
 assert.equal(reversed.rows.find(r=>r.id==='fatura').allocated_cents,0,'iptal edilen kapama sayılmaz');
 assert.equal(reversed.closing_cents,60000,'kapama iptali bakiyeyi de değiştirmez');
});

test('Ters kayıt normal hareket gibi toplanır ve kaynağı görünür',()=>{
 const entries=[entry('asil','2026-03-04',80000),entry('ters','2026-03-06',-80000,{source:'reversal',reversal_of:'asil'})];
 const statement=buildStatement({entries,from:'2026-03-01',to:'2026-03-31'});
 assert.equal(statement.closing_cents,0,'ters kayıt bakiyeyi kapatır');
 assert.equal(statement.rows[1].reversal_of,'asil');
 assert.equal(statement.rows[1].source,'reversal');
});

test('Aynı tarihli kayıtlar kararlı sıralanır ve ekstre kimliği tekrarlanabilir',()=>{
 const same=['c','a','b'].map(id=>entry(id,'2026-04-05',1000,{created_at:'2026-04-05T10:00:00Z'}));
 const first=buildStatement({entries:same,from:'2026-04-01',to:'2026-04-30'});
 const second=buildStatement({entries:[...same].reverse(),from:'2026-04-01',to:'2026-04-30'});
 assert.deepEqual(first.rows.map(r=>r.id),['a','b','c'],'girdi sırasından bağımsız kararlı sıralama');
 assert.deepEqual(first.rows.map(r=>r.id),second.rows.map(r=>r.id));
 assert.equal(statementFingerprint(first),statementFingerprint(second),'aynı ekstre aynı kimliği verir');
});

test('Sonradan geçmiş tarihli kayıt gelirse ekstre kimliği değişir',()=>{
 const before=buildStatement({entries:[entry('a','2026-05-02',1000)],from:'2026-05-01',to:'2026-05-31'});
 const after=buildStatement({entries:[entry('a','2026-05-02',1000),entry('gec','2026-05-03',500)],from:'2026-05-01',to:'2026-05-31'});
 assert.notEqual(statementFingerprint(before),statementFingerprint(after),'yeni kayıt kimliği değiştirmeli ki eski belge korunsun');
});

test('Binden fazla hareket tam hesaplanır, sayfalama sanılmaz',()=>{
 const entries=[];
 for(let i=0;i<1500;i++)entries.push(entry('e'+String(i).padStart(4,'0'),'2026-06-'+String((i%30)+1).padStart(2,'0'),100));
 entries.push(entry('devir','2026-01-01',777));
 const statement=buildStatement({entries,from:'2026-06-01',to:'2026-06-30'});
 assert.equal(statement.row_count,1500,'tüm dönem satırları gelmeli');
 assert.equal(statement.opening_cents,777);
 assert.equal(statement.closing_cents,777+150000);
 assert.equal(statement.rows.at(-1).running_cents,statement.closing_cents,'son satırın yürüyen bakiyesi kapanışa eşit');
});

test('Bakiye yönü kelimeyle anlatılır',()=>{
 assert.equal(balanceWording(500),'bizim alacağımız');
 assert.equal(balanceWording(-500),'bizim borcumuz');
 assert.equal(balanceWording(0),'bakiye yok');
});

test('Karşı taraf bildirimi kendi bakış açısından geldiğinde ortak işarete çevrilir',()=>{
 // Bizde 12.000 alacak varsa karşı tarafın defterinde 12.000 borç görünür.
 const agreed=counterpartyDifference({closing_cents:1200000,reported_cents:1200000,perspective:'theirs'});
 assert.equal(agreed.reported_common_cents,-1200000);
 assert.equal(agreed.difference_cents,2400000,'ters işaretli bildirim aynalı sanılıp sahte mutabakat üretmemeli');

 const mirrored=counterpartyDifference({closing_cents:1200000,reported_cents:-1200000,perspective:'theirs'});
 assert.equal(mirrored.status,'agreed');
 assert.equal(mirrored.difference_cents,0);

 const ours=counterpartyDifference({closing_cents:1200000,reported_cents:1200000,perspective:'ours'});
 assert.equal(ours.status,'agreed');
 assert.equal(ours.difference_cents,0);
});

test('Bildirim gelmediyse fark sıfır değil bilinmiyordur',()=>{
 const none=counterpartyDifference({closing_cents:5000,reported_cents:null});
 assert.equal(none.status,'unknown');
 assert.equal(none.difference_cents,null);
 assert.equal(none.reported_common_cents,null);
 assert.match(none.wording,/sıfır değil/);
});

test('Geçersiz dönem ve geçersiz bildirim reddedilir',()=>{
 assert.throws(()=>buildStatement({entries:[],from:'2026-05-10',to:'2026-05-01'}),/sonra olamaz/);
 assert.throws(()=>buildStatement({entries:[],from:'',to:'2026-05-01'}),/gerekli/);
 assert.throws(()=>counterpartyDifference({closing_cents:0,reported_cents:1.5}),/geçersiz/);
 assert.throws(()=>counterpartyDifference({closing_cents:0,reported_cents:100,perspective:'x'}),/seçilmeli/);
});

import {appFixture} from './helpers/app-fixture.js';

async function ledgerFixture(){
 const f=appFixture();await f.setup();
 const party=await f.ok('/ec/ledger/parties',{name:'Şişli Çiçekçilik Ltd. Şti.',kind:'customer',tax_id:'1234567890',contact:'muhasebe@ornek.test'});
 const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES(?,?,?,?,?,?,?,'manual',?)");
 insert.run('devir1',party.id,50000,'2025-11-10',null,'DEV-1','Önceki dönem satışı','k1');
 insert.run('devir2',party.id,-20000,'2025-12-01',null,'DEV-2','Önceki dönem tahsilatı','k2');
 insert.run('d1',party.id,30000,'2026-01-05','2026-02-05','F-1','Ocak satışı','k3');
 insert.run('d2',party.id,-12500,'2026-01-20',null,'T-1','Ocak tahsilatı','k4');
 insert.run('sonra',party.id,9000,'2026-02-11',null,'F-2','Şubat satışı','k5');
 return {f,party:party.id};
}

test('Ekstre ucu devir, dönem ve kapanışı gerçek defterden tam hesaplar',async()=>{
 const {f,party}=await ledgerFixture();try{
  const data=await f.ok('/ec/statement?party_id='+party+'&from=2026-01-01&to=2026-01-31');
  assert.equal(data.party.name,'Şişli Çiçekçilik Ltd. Şti.');
  assert.equal(data.statement.opening_cents,30000,'devir dönem öncesinden gelmeli');
  assert.equal(data.statement.closing_cents,47500);
  assert.equal(data.statement.row_count,2,'dönem dışı hareket girmemeli');
  assert.equal(data.difference.status,'unknown','bildirim yokken fark bilinmiyor olmalı');
  assert.ok(data.fingerprint,'ekstre sürüm kimliği olmalı');
  assert.match(data.notice,/resmî fatura değildir/);
 }finally{f.close();}
});

test('Ekstre geçersiz cari, tarih ve dönem sırasını reddeder',async()=>{
 const {f,party}=await ledgerFixture();try{
  assert.equal((await f.req('/ec/statement?party_id=yok&from=2026-01-01&to=2026-01-31')).status,404);
  assert.equal((await f.req('/ec/statement?party_id='+party+'&from=2026-13-01&to=2026-01-31')).status,400);
  assert.equal((await f.req('/ec/statement?party_id='+party+'&from=2026-02-01&to=2026-01-31')).status,400);
  assert.equal((await f.req('/ec/statement?from=2026-01-01&to=2026-01-31')).status,400);
 }finally{f.close();}
});

test('Ekstre çalışma alanı, modül ve tutar yetkisine uyar',async()=>{
 const {f,party}=await ledgerFixture();try{
  // Üretim alanında aynı cari yok: alanlar ayrı defter tutar.
  assert.equal((await f.req('/lp/statement?party_id='+party+'&from=2026-01-01&to=2026-01-31')).status,404,'ec carisi lp alanında bulunmamalı');

  const staff=await f.ok('/admin/users',{name:'Depo',username:'depo',permissions:{ec:{stock:'read'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'depo-personel-sifresi'});
  const depo=await f.req('/auth/login',{username:'depo',password:'depo-personel-sifresi'});
  assert.equal((await f.req('/ec/statement?party_id='+party+'&from=2026-01-01&to=2026-01-31',undefined,depo.cookie)).status,403,'cari yetkisi olmayan ekstre açamamalı');

  const clerk=await f.ok('/admin/users',{name:'Cari',username:'cari',permissions:{ec:{ledger:'read',amounts:'none'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:clerk.invite_path.split('invite=')[1],password:'cari-personel-sifresi'});
  const login=await f.req('/auth/login',{username:'cari',password:'cari-personel-sifresi'});
  const limited=await f.req('/ec/statement?party_id='+party+'&from=2026-01-01&to=2026-01-31',undefined,login.cookie);
  assert.equal(limited.status,200,'cari yetkisi olan ekstreyi açabilmeli');
  assert.equal(limited.data.statement.closing_cents,null,'tutar yetkisi kapalıysa bakiye gizlenmeli');
  assert.equal(limited.data.statement.rows[0].occurred_on,'2026-01-05','tarih ve açıklama görünmeye devam etmeli');
 }finally{f.close();}
});
