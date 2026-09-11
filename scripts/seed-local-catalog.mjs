// YEREL test kataloğu: ws_catalog'u önizlemenin kendi örnek ürünleriyle doldurur.
//
//   node scripts/seed-local-catalog.mjs --persist-to .wrangler/magaza-demo [--dry-run]
//
// · Kaynak tek yerdir: lunapot-store-preview/shop.js içindeki örnek ürünler. Ürün, ölçü ve fiyat
//   uydurulmaz; önizlemenin gösterdiği örnek fiyat aynen kullanılır (Büyük = örnek × 1,5, önizlemedeki
//   productPrice kuralı). Bunlar GERÇEK fiyat/stok DEĞİLDİR; test stoğu 5'tir.
// · YALNIZCA yerel veritabanına yazar. --remote verilirse ya da --persist-to yoksa durur.
// · Var olan satırlara dokunmaz (INSERT OR IGNORE); eşlemeleri ve siparişleri silmez.
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SOURCE} from './sync-store-preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

export function sampleProducts(source = DEFAULT_SOURCE) {
  const text = readFileSync(join(source, 'shop.js'), 'utf8');
  const field = (object, key) => object.match(new RegExp(key + ":'([^']*)'"))?.[1];
  return [...text.matchAll(/\{id:'[^']+'[^{}]*\}/g)].map(([object]) => ({
    id: field(object, 'id'), name: field(object, 'name'), category: field(object, 'category'),
    image: field(object, 'image'), price: Number(object.match(/price:(\d+(?:\.\d+)?)/)?.[1])
  })).filter(p => p.id && p.name && p.category && p.image && Number.isFinite(p.price) && p.price > 0);
}

const slug = size => ({'Küçük': 'kucuk', 'Büyük': 'buyuk', 'Standart': 'standart'}[size]);
export function catalogRows(products) {
  return products.flatMap(p => (p.category === 'toprak' ? ['Standart'] : ['Küçük', 'Büyük']).map(size => ({
    id: p.id + '-' + slug(size), product_id: p.id, name: p.name, size, image: p.image, category: p.category,
    price_cents: Math.round(p.price * (size === 'Büyük' ? 1.5 : 1) * 100), stock: 5, active: 1
  })));
}

const sqlText = v => "'" + String(v).replace(/'/g, "''") + "'";
export const seedSql = rows => '-- TEST KATALOĞU (yerel, örnek fiyat; gerçek fiyat/stok değildir)\n' + rows.map(r =>
  `INSERT OR IGNORE INTO ws_catalog(id,product_id,name,size,image,category,price_cents,stock,active) VALUES(${[r.id, r.product_id, r.name, r.size, r.image, r.category].map(sqlText).join(',')},${r.price_cents},${r.stock},${r.active});`
).join('\n') + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (flag('--remote')) { console.error('Bu betik uzak veritabanına YAZMAZ. Test kataloğu canlıya taşınmaz.'); process.exit(1); }
  const persist = value('--persist-to');
  if (!persist) { console.error('Yerel veritabanı dizinini verin: --persist-to .wrangler/magaza-demo'); process.exit(1); }
  const products = sampleProducts();
  if (!products.length) { console.error('Önizlemede örnek ürün bulunamadı; hiçbir şey yazılmadı.'); process.exit(1); }
  const rows = catalogRows(products);
  if (flag('--dry-run')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  const dir = mkdtempSync(join(tmpdir(), 'lunapot-seed-')), file = join(dir, 'seed.sql');
  try {
    writeFileSync(file, seedSql(rows));
    const r = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--file', file, '--yes'],
      {cwd: root, stdio: 'inherit', env: {...process.env, WRANGLER_SEND_METRICS: 'false'}});
    if (r.status !== 0) process.exit(r.status || 1);
    console.log(rows.length + ' test kataloğu satırı hazır (var olanlar korunarak). Yalnızca yerel: ' + persist);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
