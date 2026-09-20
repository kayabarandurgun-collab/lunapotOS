import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {marketplaceReceivablesApi} from '../src/marketplace-receivables-api.js';
import {renderMarketplaceReceivables} from '../public/marketplace-receivables-ui.js';

const endpoint = '/ec/marketplace-receivables';
async function fixture() {
  const f = appFixture(); await f.setup();
  let sequence = 0;
  function store(id = 's1', provider = 'trendyol') {
    f.sqlite.prepare('INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)').run(id, provider, id, 'Örnek ' + id);
    return id;
  }
  function file(id = 'f1', storeId = 's1') {
    f.sqlite.prepare("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status) VALUES(?,?,'finance','private-source-name.xlsx',1,?,'2026-09-15T00:00','[]',100,1,'applied')")
      .run(id, storeId, String(++sequence).padStart(64, '0'));
    return id;
  }
  function record(data = {}, {storeId = 's1', fileId = 'f1', row = 1, kind = 'finance_event'} = {}) {
    const id = 'r' + ++sequence;
    f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,?,?,'provider',?,'2026-09-15T00:00',?,?)")
      .run(id, storeId, kind, id, JSON.stringify(data), fileId, row);
    return id;
  }
  store(); file();
  return {f, store, file, record};
}
const net = (extra = {}) => ({order_no:'ORDER-1', package_id:'PK-1', event_date:'2026-09-10', type:'sale', amount_cents:12000, net_payout:9000, ...extra});

// Exercise the real Worker dispatcher and response scrubbing, using only an in-memory fixture.
test('Hakediş: aynı kaynak satırındaki satış/iade/kesinti neti çoğaltmaz; bütün okuma yazmasızdır', async () => {
  const {f, record} = await fixture();
  try {
    for (const [type, amount_cents] of [['sale',12000],['refund',-2000],['cargo',-1000],['commission',0]]) record(net({type,amount_cents}));
    const changes = f.sqlite.prepare('SELECT total_changes() n').get().n;
    f.sqlite.exec('PRAGMA query_only=ON');
    const data = await f.ok(endpoint + '?store_id=s1');
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].reported_net_cents, 9000, 'iade netten ikinci kez düşülmez');
    assert.equal(data.rows[0].observations.length, 1);
    assert.equal(data.rows[0].observations[0].event_count, 4);
    assert.equal(data.rows[0].has_refund, true);
    assert.equal(data.bank_verified, false);
    assert.equal(data.posting, false);
    assert.equal(Object.keys(data.summary).some(k => /cents|balance/.test(k)), false, 'hakediş/banka genel toplamı yok');
    assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n, changes);
  } finally { f.close(); }
});

test('Hakediş: örtüşen GÜNCEL kayıtlar ve eski sürümler birikmez; çelişen netler tek tutar olmaz', async () => {
  const {f, file, record} = await fixture();
  try {
    const id = record(net());
    f.sqlite.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json) VALUES('v-old',?,1,'f1',1,'new',?)").run(id, JSON.stringify(net({net_payout:888888})));
    file('f2'); record(net(), {fileId:'f2'});
    let data = await f.ok(endpoint + '?store_id=s1');
    assert.equal(data.rows[0].reported_net_cents, 9000);
    assert.equal(data.rows[0].net_observation_count, 2);
    assert.doesNotMatch(JSON.stringify(data), /888888/);
    file('f3'); record(net({net_payout:8000}), {fileId:'f3'});
    data = await f.ok(endpoint + '?store_id=s1');
    assert.equal(data.rows[0].reported_net_cents, null);
    assert.equal(data.rows[0].evidence_status, 'conflicting_net');
    assert.deepEqual(data.rows[0].observations.map(x => x.reported_net_cents).sort(), [8000,9000,9000]);
  } finally { f.close(); }
});

test('Hakediş: aynı siparişin farklı paketleri ve aynı dosyadaki tekrarlı satırlar toplanmaz', async () => {
  const {f, record} = await fixture();
  try {
    record(net()); record(net({package_id:'PK-2'}), {row:2});
    record(net({order_no:'ORDER-2'}), {row:3}); record(net({order_no:'ORDER-2'}), {row:4});
    const data = await f.ok(endpoint + '?store_id=s1');
    assert.equal(data.rows.length, 2);
    assert.equal(data.rows[0].package_count, 2);
    for (const row of data.rows) {
      assert.equal(row.reported_net_cents, null);
      assert.equal(row.evidence_status, 'ambiguous_scope');
    }
  } finally { f.close(); }
});

test('Hakediş: mağazalar aynı sağlayıcı/sipariş numarasında ayrı kalır; satırlar arası genel toplam yok', async () => {
  const {f, store, file, record} = await fixture();
  try {
    store('s2'); file('f2','s2');
    record(net()); record(net({order_no:'ORDER-2'}), {row:2});
    record(net({net_payout:12345}), {storeId:'s2',fileId:'f2'});
    const a = await f.ok(endpoint + '?store_id=s1'), b = await f.ok(endpoint + '?store_id=s2');
    assert.equal(a.rows.length, 2); assert.equal(b.rows.length, 1);
    assert.equal(b.rows[0].reported_net_cents, 12345);
    assert.doesNotMatch(JSON.stringify(a), /12345/);
    assert.equal(Object.keys(a.summary).some(k => /cents|balance/.test(k)), false);
  } finally { f.close(); }
});

test('Hakediş: tarihsiz, karma tarihli ve referanssız kayıtlar varsayılanda görünür; ödeme/vade sipariş tarihi yerine konmaz', async () => {
  const {f, record} = await fixture();
  try {
    record(net({event_date:null, order_date:'2026-09-01', payout_date:'2026-09-12'}));
    record(net({order_no:'ORDER-2', event_date:'2026-08-10'}), {row:2});
    record(net({order_no:null, event_date:null}), {row:3});
    record(net({order_no:null, event_date:null,type:'cargo'}), {row:3});
    record(net({order_no:'ORDER-3', event_date:'2026-09-10'}), {row:4});
    record(net({order_no:'ORDER-3', event_date:'2026-09-11'}), {row:4});
    record(net({order_no:'ORDER-4', event_date:'2026-02-30'}), {row:5});
    const data = await f.ok(endpoint + '?store_id=s1&from=2026-09-01&to=2026-09-30');
    assert.equal(data.filters.section, 'all');
    assert.equal(data.rows.length, 4);
    assert.equal(data.summary.outside_period_count, 1);
    assert.equal(data.summary.undated_count, 3);
    assert.equal(data.summary.unreferenced_count, 1, 'aynı referanssız kaynak satırı tek kanıt');
    assert.ok(data.rows.every(row => row.event_date === null));
    assert.equal(data.rows.find(row => !row.order_no).observations[0].event_count, 2);
    assert.equal((await f.ok(endpoint + '?store_id=s1&section=dated&from=2026-09-01')).rows.length, 0);
    assert.equal((await f.ok(endpoint + '?store_id=s1&section=undated')).rows.length, 3);
  } finally { f.close(); }
});

test('Hakediş: ödeme olayı tek başına net/tahsilat değildir; eksik ve geçersiz tutar sıfır yapılmaz; PII dönmez', async () => {
  const {f, record} = await fixture();
  try {
    record(net({type:'payout',net_payout:undefined,amount_cents:7777,customer_name:'PRIVATE-NAME',email:'private@example.test',phone:'PRIVATE-PHONE'}));
    record(net({order_no:'ORDER-2',net_payout:'9000'}), {row:2});
    record(net({order_no:'ORDER-3',net_payout:0}), {row:3});
    record(net({order_no:'ORDER-4',net_payout:-2500}), {row:4});
    record(net({order_no:'ORDER-5'}), {row:5});
    record(net({order_no:'ORDER-5',net_payout:undefined,type:'refund'}), {row:6});
    const data = await f.ok(endpoint + '?store_id=s1');
    const get = no => data.rows.find(row => row.order_no === no);
    assert.equal(get('ORDER-1').reported_net_cents, null); assert.equal(get('ORDER-1').has_payout_event, true);
    assert.equal(get('ORDER-2').evidence_status, 'invalid_data');
    assert.equal(get('ORDER-3').reported_net_cents, 0);
    assert.equal(get('ORDER-4').reported_net_cents, -2500);
    assert.equal(get('ORDER-5').evidence_status, 'incomplete_net');
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE|private@example|private-source-name|data_json|customer_name/);
  } finally { f.close(); }
});

async function staffCookie(f, username, permissions) {
  const user = await f.ok('/admin/users', {name:'Örnek Personel',username,permissions:{ec:permissions,lp:{},delete_records:false}});
  await f.req('/auth/accept-invite', {token:user.invite_path.split('invite=')[1],password:'synthetic-ledger-password'});
  return (await f.req('/auth/login', {username,password:'synthetic-ledger-password'})).cookie;
}
test('Hakediş: gerçek Worker iki okuma yetkisini birlikte ister; iç içe tutarlar gizlenir', async () => {
  const {f, record} = await fixture();
  try {
    record(net({net_payout:9876543}));
    for (const [username,permissions] of [['ledger-only',{ledger:'read',amounts:'read'}],['orders-only',{orders:'read',amounts:'read'}]]) {
      const cookie = await staffCookie(f, username, permissions);
      assert.equal((await f.req(endpoint + '?store_id=s1', undefined, cookie)).status, 403);
    }
    const hidden = await staffCookie(f,'both-hidden',{ledger:'read',orders:'read',amounts:'none'});
    const response = await f.req(endpoint + '?store_id=s1',undefined,hidden);
    assert.equal(response.status, 200);
    assert.equal(response.data.rows[0].reported_net_cents, null);
    assert.equal(response.data.rows[0].observations[0].reported_net_cents, null);
    assert.doesNotMatch(JSON.stringify(response.data), /9876543/);
    const visible = await staffCookie(f,'both-visible',{ledger:'read',orders:'read',amounts:'read'});
    assert.equal((await f.req(endpoint + '?store_id=s1',undefined,visible)).data.rows[0].reported_net_cents,9876543);
    assert.equal((await f.req(endpoint,{},visible)).status,403);
    assert.equal((await f.req('/lp/marketplace-receivables',undefined,visible)).status,403);
  } finally { f.close(); }
});

test('Hakediş: GET dışında yönetici de yazamaz; hatalı sorgu, bilinmeyen mağaza ve fazla kayıt kapalıdır', async () => {
  const {f} = await fixture();
  try {
    assert.equal((await f.req(endpoint,{})).status,403);
    assert.equal((await f.req('/lp/marketplace-receivables')).status,403);
    for (const query of ['from=2026-02-30','from=2026-09-20&to=2026-09-01','page=1.5','section=unknown'])
      assert.equal((await f.req(endpoint + '?' + query)).status,400);
    assert.equal((await f.req(endpoint + '?store_id=missing')).status,404);
    assert.equal((await f.ok(endpoint)).summary,null);
    const apiEnv = {...f.env,WORKSPACE:'ec',USER:{owner:true},DB:{prepare(sql){return {bind(){return this;},all(){return {results:sql.includes('COUNT(')?[{id:'s1'}]:Array(20001).fill({})};}};}}};
    await assert.rejects(marketplaceReceivablesApi(new Request('https://local.test/api/ec/marketplace-receivables?store_id=s1'),apiEnv,'/api/marketplace-receivables'), error=>error.status===409);
  } finally { f.close(); }
});

test('Hakediş arayüzü: rapor kanıtı, tarihsiz kapsam ve banka bağlantısı; tutar toplamı/kişi verisi yok', async () => {
  const {f, record} = await fixture();
  try {
    record(net({order_no:'<img src=x onerror=alert(1)>',event_date:null}));
    const html = renderMarketplaceReceivables(await f.ok(endpoint + '?store_id=s1'));
    assert.match(html,/Banka doğrulaması yapılmadı/);
    assert.match(html,/href="\/eticaret\/#bank"/);
    assert.match(html,/value="all" selected/);
    assert.match(html,/Tarihi belirsiz/);
    assert.match(html,/genel tutar toplamı hesaplanmaz/);
    assert.doesNotMatch(html,/<img|Tahsil edildi|Açık alacak|Cari ekle|Kaydet/);
    assert.match(html,/&lt;img/);
  } finally { f.close(); }
});

test('Hakediş: sayfalama tam mağaza kapsamını korur; filtreleme önceki çelişkiyi saklamaz', async () => {
  const {f, record} = await fixture();
  try {
    for (let i=1;i<=53;i++) record(net({order_no:'ORDER-' + String(i).padStart(3,'0'),event_date:null}),{row:i});
    const first = await f.ok(endpoint + '?store_id=s1'), last = await f.ok(endpoint + '?store_id=s1&page=99');
    assert.equal(first.rows.length,50); assert.equal(first.pagination.total,53);
    assert.equal(last.rows.length,3); assert.equal(last.pagination.page,2);
    assert.equal(last.summary.undated_count,53);
    assert.deepEqual(first.summary,last.summary);
    const secondIds = new Set(last.rows.map(row=>row.order_no));
    assert.ok(first.rows.every(row=>!secondIds.has(row.order_no)));
    record(net({order_no:'CROSS-PERIOD',event_date:'2026-08-10',net_payout:9000}),{row:54});
    record(net({order_no:'CROSS-PERIOD',event_date:'2026-09-10',net_payout:8000}),{row:55});
    const filtered = await f.ok(endpoint + '?store_id=s1&from=2026-09-01&section=undated');
    const conflict = filtered.rows.find(row=>row.order_no==='CROSS-PERIOD');
    assert.equal(conflict.evidence_status,'conflicting_net');
    assert.equal(conflict.reported_net_cents,null);
  } finally { f.close(); }
});
