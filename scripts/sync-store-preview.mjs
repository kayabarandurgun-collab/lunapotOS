// Onaylı mağaza tasarımını (../lunapot-store-preview) Worker'ın statik dizinine kopyalar.
//
// Liste ELLE tutulmaz: aktif sayfalardan başlanıp HTML src/href, CSS url() ve JS
// içindeki yerel yollar taranır. Elle liste yeni sayfaları sessizce eksik bırakıyordu
// (atelier, studio, luna-parts, nova.html... kopyalanmıyordu).
//
// Kodda birleştirilerek kurulan yollar (ör. 'assets/diagram-'+model+'-layers.png')
// statik taramayla bulunamaz; bunlar aşağıda KAYNAK SATIRIYLA BİRLİKTE açıkça yazılır.
// Tasarım bu kalıpları değiştirirse test kırılır ve eksik dosya sessizce kalmaz.
//
// Asla kopyalanmaz: work/, sırlar, eski konsept sayfaları, sunucu betikleri, belgeler.
// Canlı hostta /magaza zaten 404 döner (src/worker.js); bu betik o kapıyı değiştirmez.
import {copyFile, mkdir, readdir, readFile, stat, unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_SOURCE = path.resolve(root, '../lunapot-store-preview');
export const DEFAULT_TARGET = path.join(root, 'public/magaza');

// Müşterinin gezebildiği sayfalar. Yeni sayfa eklenince buraya yazılır; bağımlılıkları taranır.
export const ENTRY_PAGES = [
  'index.html', 'home.html', 'magaza.html', 'shop.html',
  'nova.html', 'luna.html', 'saksilar.html', 'toprak-bakim.html',
  'hakkimizda.html', 'kurumsal.html', 'iletisim.html', 'yardim.html',
  'hesabim.html', 'odeme.html', 'test-odeme.html', 'yasal.html'
];

const ALLOWED = /\.(html|css|js|webp|png|jpg|svg|woff2|txt|mp4)$/i;
const FORBIDDEN = [/^work\//, /^concept/i, /^app(-[a-z0-9]+)?\.js$/i, /^server\.cjs$/, /\.md$/i, /(^|\/)\./, /secret|token|\.env/i];

const isLocal = ref => ref && !/^([a-z]+:|\/\/|#|data:|mailto:|tel:)/i.test(ref);
const clean = ref => ref.split(/[?#]/)[0].replace(/^\.\//, '').replace(/^\//, '');

function htmlRefs(text) {
  return [...text.matchAll(/\s(?:src|href|poster)=["']([^"']+)["']/gi)].map(m => m[1]);
}
function cssRefs(text) {
  return [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(m => m[1]);
}
function jsRefs(text) {
  const found = [];
  for (const m of text.matchAll(/import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of text.matchAll(/["'`]((?:\.\/)?assets\/[A-Za-z0-9._-]+\.[a-z0-9]+)["'`]/g)) found.push(m[1]);
  for (const m of text.matchAll(/["'`]([a-z0-9-]+\.(?:html|css|js))["'`]/g)) found.push(m[1]);
  return found;
}

/**
 * Kodda parça parça kurulan dosya adları. Her kural, kalıbın kaynaktaki yerini söyler.
 * Kural yalnızca ilgili betik kopyalanan kümedeyse uygulanır.
 */
export const DYNAMIC_RULES = [
  {
    when: 'luna-parts.js',
    // luna-parts.js: key = 'nova-'+tone+'-part-'+name | 'luna-black-part-'+name | 'luna-part-'+name
    match: name => /^(nova-(white|black)-part-|luna-black-part-|luna-part-)[a-z]+\.png$/.test(name)
  },
  {
    when: 'product-stories.js',
    // product-stories.js: model+'-'+tone+'-planted.png'
    match: name => /^(nova|luna)-(white|black)-planted\.png$/.test(name)
  },
  {
    when: 'product-stories.js',
    // product-stories.js: 'assets/diagram-'+model+'-layers.png' ve 'assets/diagram-'+model+'-'+tone+'.png'
    match: name => /^diagram-(nova|luna)-(layers|white|black)\.png$/.test(name)
  },
  {
    when: 'shop.js',
    // shop.js / unified.js: 'assets/'+p.image her ürün için.
    // studio.js:13 yalnızca p.category==='saksı' iken 'assets/'+p.id+'-object.webp' ister;
    // toprak ürünlerinin nesne görseli yoktur ve istenmez.
    fromSource: text => {
      const names = [...text.matchAll(/image:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      const chunks = text.split(/(?=\{\s*id:\s*['"])/);
      for (const chunk of chunks) {
        const id = chunk.match(/^\{\s*id:\s*['"]([a-z0-9-]+)['"]/);
        const body = chunk.slice(0, chunk.indexOf('}') + 1 || undefined);
        if (id && /category:\s*['"]saksı['"]/.test(body)) names.push(id[1] + '-object.webp');
      }
      return names;
    }
  },
  {
    // Inter yazı tipi lisansı, yazı tipi dosyasıyla birlikte dağıtılmak ZORUNDADIR.
    whenAsset: /^inter.*\.woff2$/,
    match: name => name === 'INTER-LICENSE.txt'
  }
];

const forbidden = rel => FORBIDDEN.some(pattern => pattern.test(rel));

/**
 * Kopyalanacak kümeyi hesaplar; hiçbir şey yazmaz.
 * Dönüş: files (kopyalanacaklar), missing (bulunamayan referanslar), stale (hedefte olup
 * artık hiçbir sayfanın kullanmadığı dosyalar), skipped (yasaklı olduğu için alınmayanlar).
 */
export async function planStoreSync({source = DEFAULT_SOURCE, target = DEFAULT_TARGET} = {}) {
  const files = new Set(), missing = [], skipped = new Set(), queue = [...ENTRY_PAGES];
  const exists = async rel => { try { return (await stat(path.join(source, rel))).isFile(); } catch { return false; } };

  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    if (forbidden(rel)) { skipped.add(rel); continue; }
    if (!ALLOWED.test(rel)) { skipped.add(rel); continue; }
    if (!await exists(rel)) { missing.push(rel); continue; }
    files.add(rel);
    const ext = path.extname(rel).toLowerCase();
    if (!['.html', '.css', '.js'].includes(ext)) continue;
    const text = await readFile(path.join(source, rel), 'utf8');
    const refs = ext === '.html' ? htmlRefs(text) : ext === '.css' ? cssRefs(text) : jsRefs(text);
    const base = path.posix.dirname(rel);
    for (const ref of refs) {
      if (!isLocal(ref)) continue;
      const resolved = path.posix.normalize(path.posix.join(base === '.' ? '' : base, clean(ref)));
      if (resolved.startsWith('..')) { skipped.add(ref); continue; }
      if (!files.has(resolved)) queue.push(resolved);
    }
  }

  // Dinamik kalıplar: yalnızca betiği kopyalanan kurallar uygulanır.
  const assetNames = (await readdir(path.join(source, 'assets'), {withFileTypes: true}))
    .filter(entry => entry.isFile()).map(entry => entry.name);
  for (const rule of DYNAMIC_RULES) {
    if (rule.when && !files.has(rule.when)) continue;
    if (rule.whenAsset && ![...files].some(f => rule.whenAsset.test(path.posix.basename(f)))) continue;
    let names = [];
    if (rule.match) names = assetNames.filter(rule.match);
    if (rule.fromSource) {
      const sources = ['shop.js', 'unified.js'].filter(f => files.has(f));
      for (const f of sources) names.push(...rule.fromSource(await readFile(path.join(source, f), 'utf8')));
    }
    for (const name of new Set(names)) {
      const rel = 'assets/' + name;
      if (files.has(rel)) continue;
      if (await exists(rel)) files.add(rel);
      else if (rule.fromSource) missing.push(rel);   // koddan okunan ad dosyada yoksa eksiktir
    }
  }

  let stale = [];
  try {
    const walk = async dir => {
      const out = [];
      for (const entry of await readdir(path.join(target, dir), {withFileTypes: true})) {
        const rel = dir ? dir + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...await walk(rel)); else out.push(rel);
      }
      return out;
    };
    stale = (await walk('')).filter(rel => !files.has(rel));
  } catch { stale = []; }

  // Worker'ın güvenlik politikası (style-src 'self') metin olarak kurulan style="..." özniteliklerini
  // UYGULAMAZ. Tasarım betiği innerHTML ile style="..." yazıyorsa o konumlar canlıda bozulur.
  // Kopyalamayı durdurmaz; her senkronda görünür olsun diye raporlanır.
  const inlineStyleJs = [];
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const count = ((await readFile(path.join(source, rel), 'utf8')).match(/(?<![\w-])style=\\?["']/g) || []).length;
    if (count) inlineStyleJs.push({file: rel, count});
  }

  return {files: [...files].sort(), missing: [...new Set(missing)].sort(), stale: stale.sort(), skipped: [...skipped].sort(), inline_style_js: inlineStyleJs};
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const plan = await planStoreSync();
  if (plan.missing.length) {
    console.error('Eksik dosya — kopyalama yapılmadı:\n  ' + plan.missing.join('\n  '));
    process.exitCode = 1;
    return;
  }
  if (args.has('--dry-run')) {
    console.log(JSON.stringify({kopyalanacak: plan.files.length, dosyalar: plan.files, artik_kullanilmayan: plan.stale}, null, 2));
    return;
  }
  for (const rel of plan.files) {
    await mkdir(path.dirname(path.join(DEFAULT_TARGET, rel)), {recursive: true});
    await copyFile(path.join(DEFAULT_SOURCE, rel), path.join(DEFAULT_TARGET, rel));
  }
  // Artık kullanılmayan dosyalar yalnızca açıkça istenirse silinir.
  if (args.has('--prune')) for (const rel of plan.stale) await unlink(path.join(DEFAULT_TARGET, rel));
  console.log(`${plan.files.length} dosya public/magaza içine kopyalandı. work/, sırlar ve eski konsept dosyaları alınmadı.`);
  if (plan.inline_style_js.length)
    console.warn('UYARI — CSP bu satır içi stilleri uygulamaz (Worker üzerinden sunulunca yerleşim bozulur):\n  ' +
      plan.inline_style_js.map(x => `${x.file}: ${x.count} adet style="..."`).join('\n  ') +
      '\n  Çözüm: öğeyi oluşturduktan sonra el.style.left = ... gibi CSSOM ile yazın; bu, politikaya takılmaz.');
  if (plan.stale.length && !args.has('--prune'))
    console.log('Hiçbir sayfanın kullanmadığı eski kopyalar (silinmedi, --prune ile silinir):\n  ' + plan.stale.join('\n  '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
