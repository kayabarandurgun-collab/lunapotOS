import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// 500 kaydin otesine gecen cari gecmisi, arama, vade ve kararli siralama.
async function seeded(count){
 const f=appFixture();await f.setup();
 const party=await f.ok('/ec/ledger/parties',{name:'Uzun geçmişli cari',kind:'customer',tax_id:'',contact:''});
 const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES(?,?,?,?,?,?,?,'manual',?)");
 for(let i=0;i<count;i++){
  const day=String(1+(i%28)).padStart(2,'0');
  insert.run('e'+i,party.id,1000+i,'2026-03-'+day,'2026-04-'+day,'REF-'+i,'Sentetik hareket '+i,'k'+i);
 }
 return {f,party:party.id};
}

test('500 kaydı aşan cari geçmişi sayfalanır ve toplam sayı bildirilir',async()=>{
 const {f,party}=await seeded(640);try{
  const first=await f.ok('/ec/ledger?party_id='+party);
  assert.equal(first.entry_pagination.total,640,'toplam kayıt sayısı bildirilmeli');
  assert.equal(first.entries.length,200,'sayfa boyutu kadar kayıt gelmeli');
  assert.equal(first.entry_pagination.has_more,true);
  assert.equal(first.truncated.entries,false,'sayfalanan liste kırpılmış sayılmamalı');

  const last=await f.ok('/ec/ledger?party_id='+party+'&page=4');
  assert.equal(last.entries.length,40,'son sayfada kalan kayıtlar gelmeli');
  assert.equal(last.entry_pagination.has_more,false);

  const seen=new Set([...first.entries,...last.entries].map(e=>e.id));
  assert.equal(seen.size,240,'sayfalar arasında kayıt tekrarlanmamalı');
 }finally{f.close();}
});

test('Eski kayıt arama ile bulunur; bakiye filtreden etkilenmez',async()=>{
 const {f,party}=await seeded(640);try{
  const all=await f.ok('/ec/ledger?party_id='+party);
  const balance=all.parties.find(p=>p.id===party).balance_cents;

  const found=await f.ok('/ec/ledger?party_id='+party+'&q=REF-637');
  assert.equal(found.entry_pagination.total,1,'500. kaydın ötesindeki referans bulunmalı');
  assert.equal(found.entries[0].reference,'REF-637');
  assert.equal(found.parties.find(p=>p.id===party).balance_cents,balance,'bakiye arama ile değişmemeli');

  const byDate=await f.ok('/ec/ledger?party_id='+party+'&from=2026-03-05&to=2026-03-05');
  assert.ok(byDate.entry_pagination.total>0);
  assert.ok(byDate.entries.every(e=>e.occurred_on==='2026-03-05'),'tarih filtresi uygulanmalı');
 }finally{f.close();}
});

test('Vadesi geçen ve yaklaşan kayıtlar ayrı süzülür',async()=>{
 const f=appFixture();await f.setup();try{
  const party=await f.ok('/ec/ledger/parties',{name:'Vade cari',kind:'customer',tax_id:'',contact:''});
  const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES(?,?,?,?,?,?,?,'manual',?)");
  insert.run('gecmis',party.id,5000,'2020-01-01','2020-02-01','GEC-1','Vadesi geçmiş','k-gec');
  insert.run('gelecek',party.id,7000,'2020-01-01','2999-01-01','GEL-1','Vadesi gelmemiş','k-gel');
  insert.run('vadesiz',party.id,900,'2020-01-01',null,'YOK-1','Vadesiz','k-yok');

  const overdue=await f.ok('/ec/ledger?party_id='+party.id+'&due=overdue');
  assert.deepEqual(overdue.entries.map(e=>e.id),['gecmis']);
  const upcoming=await f.ok('/ec/ledger?party_id='+party.id+'&due=upcoming');
  assert.deepEqual(upcoming.entries.map(e=>e.id),['gelecek']);
  const everything=await f.ok('/ec/ledger?party_id='+party.id);
  assert.equal(everything.entry_pagination.total,3,'vadesiz kayıt da listede kalmalı');

  const bad=await f.req('/ec/ledger?party_id='+party.id+'&due=hepsi');
  assert.equal(bad.status,400,'geçersiz vade seçimi reddedilmeli');
 }finally{f.close();}
});

test('Aynı tarihli kayıtlar sayfalar arasında kararlı sıralanır',async()=>{
 const f=appFixture();await f.setup();try{
  const party=await f.ok('/ec/ledger/parties',{name:'Aynı gün',kind:'customer',tax_id:'',contact:''});
  const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source,source_key) VALUES(?,?,?,'2026-05-05',?,?,'manual',?)");
  for(let i=0;i<250;i++)insert.run('s'+String(i).padStart(3,'0'),party.id,100+i,'AYNI-'+i,'Aynı tarihli kayıt','ka'+i);

  const a1=await f.ok('/ec/ledger?party_id='+party.id);
  const a2=await f.ok('/ec/ledger?party_id='+party.id+'&page=2');
  const b1=await f.ok('/ec/ledger?party_id='+party.id);
  const b2=await f.ok('/ec/ledger?party_id='+party.id+'&page=2');
  assert.deepEqual(a1.entries.map(e=>e.id),b1.entries.map(e=>e.id),'aynı sorgu aynı sırayı vermeli');
  assert.deepEqual(a2.entries.map(e=>e.id),b2.entries.map(e=>e.id));
  const all=new Set([...a1.entries,...a2.entries].map(e=>e.id));
  assert.equal(all.size,250,'aynı tarihli kayıtlar sayfalarda tekrarlanmamalı veya kaybolmamalı');
 }finally{f.close();}
});
