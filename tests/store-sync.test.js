import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {planStoreSync, DEFAULT_SOURCE, ENTRY_PAGES} from '../scripts/sync-store-preview.mjs';

// Tasarım kaynağı bu makinede yoksa (ör. yalnızca panel deposu klonlandıysa) atlanır.
const hasSource = existsSync(DEFAULT_SOURCE);

test('Aktif sayfaların bütün yerel bağımlılıkları bulunur, eksik referans kalmaz', {skip: !hasSource && 'tasarım kaynağı yok'}, async () => {
  const plan = await planStoreSync();
  assert.deepEqual(plan.missing, [], 'her referans kaynakta bulunmalı: ' + plan.missing.join(', '));
  for (const page of ENTRY_PAGES) assert.ok(plan.files.includes(page), page + ' kopyalanmalı');
});

test('Elle listenin kaçırdığı yeni tasarım dosyaları kopyalanır', {skip: !hasSource && 'tasarım kaynağı yok'}, async () => {
  const {files} = await planStoreSync();
  for (const f of ['atelier.css', 'atelier.js', 'studio.css', 'studio.js', 'product-stories.css',
    'product-stories.js', 'luna-parts.js', 'nova.html', 'luna.html', 'saksilar.html', 'toprak-bakim.html'])
    assert.ok(files.includes(f), f + ' eksik');
});

test('Kodda birleştirilerek kurulan görsel adları da bulunur', {skip: !hasSource && 'tasarım kaynağı yok'}, async () => {
  const {files} = await planStoreSync();
  const assets = files.filter(f => f.startsWith('assets/')).map(f => f.slice(7));
  // luna-parts.js parça görselleri
  assert.ok(assets.includes('nova-white-part-plant.png'));
  assert.ok(assets.includes('luna-black-part-platform.png'));
  assert.ok(assets.includes('luna-part-roots.png'));
  // product-stories.js dikili son görseller ve kesit çizimleri
  for (const f of ['nova-white-planted.png', 'luna-black-planted.png', 'diagram-nova-layers.png', 'diagram-luna-white.png'])
    assert.ok(assets.includes(f), f + ' eksik');
  // shop.js ürün görselleri ve nesne görselleri
  for (const f of ['luna-silver.webp', 'nova-copper-object.webp', 'klasmann-potground-h.jpg'])
    assert.ok(assets.includes(f), f + ' eksik');
  // Yerleşim videosu ve fotoğrafı
  assert.ok(assets.includes('nova-yerlesim-video.mp4'));
  assert.ok(assets.includes('nova-placement-photo.png'));
  // Yazı tipiyle birlikte lisansı da dağıtılmalı
  assert.ok(assets.includes('inter.woff2') && assets.includes('INTER-LICENSE.txt'), 'yazı tipi lisansıyla gitmeli');
  assert.ok(assets.filter(f => f.endsWith('.png')).length >= 27, 'yeni PNG seti eksiksiz olmalı');
});

test('CSP\'nin uygulamayacağı satır içi stiller her senkronda raporlanır', {skip: !hasSource && 'tasarım kaynağı yok'}, async () => {
  const plan = await planStoreSync();
  assert.ok(Array.isArray(plan.inline_style_js));
  // Rapor yalnızca gerçekten kopyalanan betikleri kapsar ve sayı verir.
  for (const entry of plan.inline_style_js) {
    assert.ok(plan.files.includes(entry.file), entry.file + ' kopyalanan kümede olmalı');
    assert.ok(Number.isInteger(entry.count) && entry.count > 0);
  }
});

test('Çalışma dosyaları, konseptler, sunucu betiği ve kullanılmayan GIF\'ler alınmaz', {skip: !hasSource && 'tasarım kaynağı yok'}, async () => {
  const {files} = await planStoreSync();
  assert.ok(!files.some(f => f.startsWith('work/')), 'work/ asla kopyalanmaz');
  assert.ok(!files.some(f => /^concept/i.test(f)), 'eski konsept sayfaları alınmaz');
  assert.ok(!files.some(f => /^app(-[a-z0-9]+)?\.js$/.test(f)), 'eski konsept betikleri alınmaz');
  assert.ok(!files.includes('server.cjs'));
  assert.ok(!files.some(f => f.endsWith('.md')));
  assert.ok(!files.some(f => f.endsWith('.gif')), 'hiçbir aktif sayfa GIF kullanmıyor');
  assert.ok(files.every(f => /\.(html|css|js|webp|png|jpg|svg|woff2|txt|mp4)$/i.test(f)), 'yalnızca izinli türler');
});
