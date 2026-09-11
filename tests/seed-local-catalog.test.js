import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sampleProducts, catalogRows, seedSql} from '../scripts/seed-local-catalog.mjs';
import {DEFAULT_SOURCE} from '../scripts/sync-store-preview.mjs';

const hasSource = existsSync(DEFAULT_SOURCE);
const script = fileURLToPath(new URL('../scripts/seed-local-catalog.mjs', import.meta.url));

test('Test kataloğu önizlemenin örnek ürünlerinden, mağazanın ölçü kurallarıyla üretilir', {skip: !hasSource && 'tasarım kaynağı yok'}, () => {
  const products = sampleProducts();
  assert.ok(products.length >= 1);
  const rows = catalogRows(products);
  for (const p of products) {
    const own = rows.filter(r => r.product_id === p.id);
    // Mağaza sepet satırını product_id|size ile eşler: toprak 'Standart', saksı 'Küçük'/'Büyük'.
    assert.deepEqual(own.map(r => r.size), p.category === 'toprak' ? ['Standart'] : ['Küçük', 'Büyük']);
    assert.equal(own[0].price_cents, Math.round(p.price * 100));
  }
});

test('Büyük boy önizlemedeki kuralla ×1,5; SQL güvenli kaçışlıdır ve var olan satırı ezmez', () => {
  const rows = catalogRows([{id: 'nova-x', name: "Nova · O'Neil", category: 'saksı', image: 'x.webp', price: 1290}, {id: 't', name: 'Toprak', category: 'toprak', image: 't.webp', price: 190}]);
  assert.deepEqual(rows.map(r => [r.id, r.size, r.price_cents, r.stock]), [['nova-x-kucuk', 'Küçük', 129000, 5], ['nova-x-buyuk', 'Büyük', 193500, 5], ['t-standart', 'Standart', 19000, 5]]);
  const sql = seedSql(rows);
  assert.match(sql, /INSERT OR IGNORE INTO ws_catalog/);
  assert.match(sql, /O''Neil/);
  assert.ok(!/DELETE|UPDATE|DROP/i.test(sql));
});

test('Uzak veritabanına yazmayı ve dizinsiz çalıştırmayı reddeder', () => {
  const remote = spawnSync(process.execPath, [script, '--remote', '--persist-to', 'x'], {encoding: 'utf8'});
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /uzak veritabanına YAZMAZ/);
  const bare = spawnSync(process.execPath, [script], {encoding: 'utf8'});
  assert.equal(bare.status, 1);
});
