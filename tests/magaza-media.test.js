import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Sahte statik dosya katmanı: yerel ve (belki) canlı katman aralık isteğine tam dosya dönüyor.
const video = new Uint8Array(1000).map((unused, i) => i % 256);
const assets = {fetch: async () => new Response(video, {status: 200, headers: {'Content-Type': 'video/mp4'}})};
const demo = {DB: {}, ASSETS: assets, WS_MODE: 'demo'};
const get = (range, host = 'http://localhost', env = demo) =>
  worker.fetch(new Request(host + '/magaza/assets/nova-yerlesim-video.mp4', range ? {headers: {Range: range}} : {}), env);

test('Video aralık isteğine 206 ve doğru bayt dilimiyle döner', async () => {
  const r = await get('bytes=0-99');
  assert.equal(r.status, 206, 'iPhone Safari kısmi yanıt ister');
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-99/1000');
  assert.equal(r.headers.get('Content-Length'), '100');
  assert.equal(r.headers.get('Accept-Ranges'), 'bytes');
  const body = new Uint8Array(await r.arrayBuffer());
  assert.equal(body.length, 100);
  assert.equal(body[0], 0);
  assert.equal(body[99], 99);
});

test('Açık uçlu ve sondan aralık da desteklenir', async () => {
  const open = await get('bytes=990-');
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('Content-Range'), 'bytes 990-999/1000');
  assert.equal((await open.arrayBuffer()).byteLength, 10);

  const suffix = await get('bytes=-10');
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 990-999/1000');

  const clipped = await get('bytes=500-5000');
  assert.equal(clipped.headers.get('Content-Range'), 'bytes 500-999/1000', 'dosya sonunu aşan uç kırpılır');
});

test('Geçersiz aralık 416 döner; aralıksız istek tam dosya ve Accept-Ranges ile döner', async () => {
  const bad = await get('bytes=2000-3000');
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('Content-Range'), 'bytes */1000');

  const whole = await get();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes', 'tarayıcı aralık desteğini buradan öğrenir');
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);

  const multi = await get('bytes=0-1,5-6');
  assert.equal(multi.status, 200, 'çoklu aralık desteklenmez; tam dosya döner');
});

test('Aralık desteği canlı hosttaki kapalı mağaza kapısını açmaz', async () => {
  const live = await get('bytes=0-99', 'https://muhasebe.lunapot.com', {DB: {}, ASSETS: assets});
  assert.equal(live.status, 404, 'müşteri mağazası canlıda kapalı kalır');
});
