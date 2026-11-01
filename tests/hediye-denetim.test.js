import test from 'node:test';
import assert from 'node:assert/strict';
import {hediyeKurallari, siparisDenetle, hediyeDenetim} from '../src/hediye-denetim.js';

const AYAR = JSON.stringify({current: {gift_active: true, gift_threshold: 1500, gift_list: 'h-set, h-kaktus', gift2_threshold: 2500, gift2_list: 'h-bitki', gift3_threshold: 10000, gift3_list: 'h-pina:111, h-pina:222'}});
const K = hediyeKurallari('/* otomatik */' + AYAR);
const para = v => ({shopMoney: {amount: String(v)}});
const satir = (handle, tags, adet, liste, net = liste) => ({quantity: adet, originalTotalSet: para(liste), discountedTotalSet: para(net), product: {handle, tags}});
const S = (...l) => ({lineItems: {nodes: l}});
const saksi = (liste, net) => satir('pina', ['saksi'], 1, liste, net), hediye = (h, adet = 1) => satir(h, ['hediye-urun'], adet, 125 * adet, 0);

test('tema ayarı okunur: eşik, tutamaç, varyant eki ve yorum temizlenir', () => {
  assert.equal(K.acik, true);
  assert.deepEqual(K.kademeler.map(k => k.min), [150000, 250000, 1000000]);
  assert.deepEqual(K.kademeler[2].handles, ['h-pina', 'h-pina']);
  assert.throws(() => hediyeKurallari('{"current":{"gift_threshold":"x"}}'), /eşiği/);
});

test('hak edilmiş hediyeye ve hediyesiz siparişe dokunulmaz', () => {
  assert.equal(siparisDenetle(S(saksi(2000, 1600), hediye('h-set')), K), null);
  assert.equal(siparisDenetle(S(saksi(100)), K), null);
  assert.equal(siparisDenetle(S(saksi(12000, 10500), hediye('h-set'), hediye('h-bitki'), hediye('h-pina')), K), null);
});

test('saldırı: hediye tek başına, eşiğin altında, ya da kademede çok adet iptal', () => {
  assert.equal(siparisDenetle(S(hediye('h-pina')), K).tur, 'iptal');
  assert.equal(siparisDenetle(S(saksi(100), hediye('h-set')), K).tur, 'iptal');
  assert.equal(siparisDenetle(S(saksi(2000), hediye('h-set', 3)), K).tur, 'iptal');
  assert.equal(siparisDenetle(S(saksi(2000), hediye('h-set'), hediye('h-kaktus')), K).tur, 'iptal');
  assert.equal(siparisDenetle(S(saksi(3000), hediye('h-pina')), K).tur, 'iptal');
});

test('hediye-haric ürün eşiğe sayılmaz', () => {
  assert.equal(siparisDenetle(S(satir('klasmann', ['hediye-haric'], 1, 5000), hediye('h-set')), K).tur, 'iptal');
});

test('iyi niyet: kupon eşiğin altına düşürdüyse yalnız uyarı; bilinmeyen hediye ve kapalı kampanya uyarı', () => {
  assert.equal(siparisDenetle(S(saksi(1800, 1314), hediye('h-set')), K).tur, 'uyari');
  assert.equal(siparisDenetle(S(saksi(2000), hediye('h-eski')), K).tur, 'uyari');
  assert.equal(siparisDenetle(S(saksi(2000), hediye('h-set')), {...K, acik: false}).tur, 'uyari');
});

function ortam(siparisler, {ayar = AYAR, iptalHata = []} = {}) {
  const cagri = [];
  const fetcher = async (url, o) => {
    if (url.includes('access_token')) return {json: async () => ({access_token: 'j', expires_in: 3600})};
    const g = JSON.parse(o.body); cagri.push(g);
    let data;
    if (g.query.includes('orderCancel')) data = {orderCancel: {orderCancelUserErrors: iptalHata}};
    else if (g.query.includes('tagsAdd')) data = {tagsAdd: {userErrors: []}};
    else if (g.query.includes('themes')) data = {themes: {nodes: [{files: {nodes: [{body: {content: ayar}}]}}]}};
    else data = {orders: {nodes: siparisler}};
    return {json: async () => ({data})};
  };
  return {cagri, fetcher, env: {SHOPIFY_FATURA_CLIENT_ID: 'i', SHOPIFY_FATURA_SECRET: 's'}};
}
const siparis = (name, durum, ...l) => ({id: 'gid://o/' + name, name, cancelledAt: null, displayFulfillmentStatus: durum, lineItems: {nodes: l}});
const var_ = (o, m) => o.cagri.filter(c => c.query.includes(m));

test('ihlalli sipariş iptal edilip etiketlenir, para iade istenir; temiz siparişe dokunulmaz', async () => {
  const o = ortam([siparis('#1', 'UNFULFILLED', hediye('h-pina')), siparis('#2', 'UNFULFILLED', saksi(2000), hediye('h-set'))]);
  const r = await hediyeDenetim(o.env, {fetcher: o.fetcher});
  assert.deepEqual([r.iptal, r.uyari, r.hediyeli], [1, 0, 2]);
  assert.equal(var_(o, 'orderCancel').length, 1);
  assert.equal(var_(o, 'orderCancel')[0].variables.id, 'gid://o/#1');
  assert.match(var_(o, 'orderCancel')[0].query, /originalPaymentMethodsRefund:true/);
  assert.deepEqual(var_(o, 'tagsAdd')[0].variables.t, ['hediye-ihlal']);
  assert.match(o.cagri[0].variables.q, /-tag:hediye-ihlal/);
});

test('kargolanmış sipariş ve kupon uyarısı iptal edilmez, yalnız etiketlenir', async () => {
  const o = ortam([siparis('#3', 'FULFILLED', hediye('h-pina')), siparis('#4', 'UNFULFILLED', saksi(1800, 1314), hediye('h-set'))]);
  const r = await hediyeDenetim(o.env, {fetcher: o.fetcher});
  assert.deepEqual([r.iptal, r.uyari], [0, 2]);
  assert.equal(var_(o, 'orderCancel').length, 0);
  assert.equal(var_(o, 'tagsAdd').length, 2);
});

test('tema ayarı okunamazsa hiçbir siparişe dokunulmaz; bağlantı yoksa atlanır; hediyesizde ayar okunmaz', async () => {
  const o = ortam([siparis('#5', 'UNFULFILLED', hediye('h-pina'))], {ayar: '{bozuk'});
  const r = await hediyeDenetim(o.env, {fetcher: o.fetcher});
  assert.ok(r.hata);
  assert.equal(var_(o, 'orderCancel').length + var_(o, 'tagsAdd').length, 0);
  assert.equal((await hediyeDenetim({}, {fetcher: o.fetcher})).atlandi, 'baglanti_yok');
  const t = ortam([siparis('#6', 'UNFULFILLED', saksi(100))]);
  assert.equal((await hediyeDenetim(t.env, {fetcher: t.fetcher})).hediyeli, 0);
  assert.equal(var_(t, 'themes').length, 0);
});

test('iptal reddedilirse sayaç uyarıya düşer, sipariş yine işaretlenir', async () => {
  const o = ortam([siparis('#7', 'UNFULFILLED', hediye('h-pina'))], {iptalHata: [{message: 'olmadı'}]});
  const r = await hediyeDenetim(o.env, {fetcher: o.fetcher});
  assert.deepEqual([r.iptal, r.uyari], [0, 1]);
  assert.equal(var_(o, 'tagsAdd').length, 1);
});
