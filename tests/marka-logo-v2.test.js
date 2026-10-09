import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// LOGO KÜTÜPHANESİ v2: 32 şeffaf + 32 renkli zeminli.
//
// En sıkı şart: ONAYLI V8 GEOMETRİSİ DEĞİŞMEDİ. Yeni katalog eski dosyaların
// aynı baytlarıdır; renkli olanlar aynı çizimi bir <rect> ve TEK eş oranlı
// dönüşümün içine alır. Bu test her ikisini de ölçer.

const kok = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2 = join(kok, 'public', 'marka', 'logo-v2');
const v1 = join(kok, 'public', 'marka', 'logo');
const manifest = JSON.parse(readFileSync(join(v2, 'manifest.json'), 'utf8'));
const hash = yol => createHash('sha256').update(readFileSync(yol)).digest('hex');
const ailesi = v => v.family || (v.backgroundIncluded ? 'background' : 'transparent');

test('Manifest 2. sürüm: 64 varyant, 32 şeffaf + 32 renkli zemin', () => {
  assert.equal(manifest.version, 2);
  assert.equal(manifest.variants.length, 64);
  const sayim = {};
  for (const v of manifest.variants) sayim[ailesi(v)] = (sayim[ailesi(v)] || 0) + 1;
  assert.deepEqual(sayim, {transparent: 32, background: 32});
  assert.deepEqual(manifest.layouts.map(l => l.id), ['yatay', 'dikey', 'amblem', 'yazi']);
  for (const layout of ['yatay', 'dikey', 'amblem', 'yazi'])
    for (const aile of ['transparent', 'background'])
      assert.ok(manifest.variants.some(v => v.layout === layout && ailesi(v) === aile),
        layout + '/' + aile + ' eksik');
});

test('Her varyantta BİR SVG ve BİR 2048 px PNG var; hash değişmemiş', () => {
  let svg = 0, png = 0;
  for (const v of manifest.variants) {
    assert.ok(existsSync(join(v2, v.svg)), v.svg + ' eksik');
    svg++;
    assert.equal(v.pngs.length, 1, v.id + ' tek PNG taşımalı (eski 1024/2048/4096 geri gelmesin)');
    const p = v.pngs[0];
    assert.equal(p.width, manifest.standardPngWidth || 2048, v.id + ' PNG genişliği 2048 değil');
    assert.ok(existsSync(join(v2, p.path)), p.path + ' eksik');
    assert.equal(hash(join(v2, p.path)), p.sha256, p.path + ' değişmiş');
    png++;
  }
  assert.equal(svg, 64);
  assert.equal(png, 64);
});

test('Renkli zemin DOSYANIN İÇİNDE: SVG rect taşır, şeffaf olan taşımaz', () => {
  for (const v of manifest.variants) {
    const metin = readFileSync(join(v2, v.svg), 'utf8');
    if (ailesi(v) === 'background') {
      assert.equal(v.backgroundIncluded, true, v.id + ' backgroundIncluded değil');
      assert.ok(/^#[0-9A-Fa-f]{6}$/.test(v.backgroundHex || ''), v.id + ' backgroundHex geçersiz');
      assert.match(metin, /<rect[^>]*fill="/i, v.id + ' zemin rect taşımıyor');
      // Zemin rengi gerçekten dosyada.
      assert.ok(metin.toLowerCase().includes(v.backgroundHex.toLowerCase()),
        v.id + ' zemin rengi dosyada yok');
    } else {
      assert.equal(/<rect/i.test(metin), false, v.id + ' şeffaf olmalı ama rect var');
    }
  }
});

test('ONAYLI GEOMETRİ: şeffaf katalog eski dosyalarla AYNI BAYTLAR', () => {
  // Eski 32 kimlik yeni katalogda -seffaf ekiyle duruyor; çizim bire bir aynı.
  const eslesme = JSON.parse(readFileSync(join(kok, '..', 'lunapot-claude-modul-guncelleme-2026-10-09',
    'ESKI-LOGO-YOLLARI.json'), 'utf8'));
  assert.equal(eslesme.variants.length, 32);
  for (const giris of eslesme.variants) {
    const yeni = manifest.variants.find(v => v.id === giris.newCatalogVariantId);
    assert.ok(yeni, giris.newCatalogVariantId + ' yeni katalogda yok');
    const yeniHash = hash(join(v2, yeni.svg));
    assert.equal(yeniHash, giris.sha256, giris.newCatalogVariantId + ' çizimi değişmiş');
    // Eski dosya hâlâ yerinde ve AYNI.
    const eskiYol = join(v1, '01-SVG', giris.legacyVariantId + '.svg');
    assert.ok(existsSync(eskiYol), giris.oldPublicUrl + ' silinmiş — geçmiş belgeler bozulur');
    assert.equal(hash(eskiYol), yeniHash, giris.legacyVariantId + ' eski ve yeni çizim farklı');
  }
});

test('Renkli varyant aynı çizimi TEK eş oranlı dönüşümle taşır', () => {
  // Kanıt: çerçeve sarmalayıcısı ve zemin soyulunca kalan gövde, AYNI yerleşimin
  // şeffaf sürümünün gövdesiyle birebir aynı olmalı. Yani parçalar ayrı ayrı
  // taşınmamış; bütün logo tek dönüşümün içine alınmış.
  const govde = metin => metin.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)[1]
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<rect\b[^>]*data-background="true"[^>]*\/>/g, '')
    .trim();

  for (const v of manifest.variants.filter(x => ailesi(x) === 'background')) {
    const metin = readFileSync(join(v2, v.svg), 'utf8');
    assert.equal(/<script/i.test(metin), false, v.id + ' script taşıyor');
    // Tek çerçeve dönüşümü; eş oranlı tek scale (x/y ayrı değil).
    const cerceve = metin.match(/<g data-frame-fit="true" transform="translate\([^)]*\) scale\(([^)]*)\)"/g) || [];
    assert.equal(cerceve.length, 1, v.id + ' tek çerçeve dönüşümü taşımalı, ' + cerceve.length + ' var');
    const olcek = cerceve[0].match(/scale\(([^)]*)\)/)[1];
    assert.equal(olcek.includes(','), false, v.id + ' x/y ayrı ölçeklenmiş: ' + olcek);
    assert.equal(olcek.trim().split(/\s+/).length, 1, v.id + ' eş oranlı ölçek değil: ' + olcek);

    // Çerçeve soyulunca kalan çizim, şeffaf sürümle AYNI.
    const seffaf = manifest.variants.find(x => ailesi(x) === 'transparent' && x.layout === v.layout
      && x.colorId.replace(/-seffaf$/, '') !== undefined
      && readFileSync(join(v2, x.svg), 'utf8').includes(v.id.includes('beyaz-logo') ? '' : ''));
    assert.ok(seffaf, v.layout + ' için şeffaf karşılık yok');
    const ic = govde(metin).replace(/^<g data-frame-fit="true"[^>]*>/, '').replace(/<\/g>\s*$/, '').trim();
    const seffafGovde = govde(readFileSync(join(v2, seffaf.svg), 'utf8'));
    // Renk farkı beklenir; ÇİZİM aynı olmalı: renk nitelikleri çıkarılıp karşılaştırılır.
    const cizim = s => s.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="X"').replace(/\s+/g, ' ').trim();
    assert.equal(cizim(ic), cizim(seffafGovde), v.id + ' çizimi şeffaf sürümden farklı');
  }
});

test('Dört currentColor kaynağı yerinde ve renk değişimine uygun', () => {
  assert.deepEqual(Object.keys(manifest.customSources).sort(), ['amblem', 'dikey', 'yatay', 'yazi']);
  for (const [layout, yol] of Object.entries(manifest.customSources)) {
    const tam = join(v2, yol);
    assert.ok(existsSync(tam), yol + ' eksik');
    const svg = readFileSync(tam, 'utf8');
    assert.ok(svg.includes('currentColor'), layout + ' currentColor taşımıyor');
    assert.match(svg, /viewBox="[\d.\s-]+"/, layout + ' viewBox yok');
    assert.equal(/<script/i.test(svg), false, layout + ' script taşıyor');
    // Özel renk kaynağı ŞEFFAFTIR; zemin composeSvg ile eklenir.
    assert.equal(/<rect/i.test(svg), false, layout + ' kaynağında rect var');
  }
});

test('Renkli çerçeve ölçüleri ve fitRatio kaynakla aynı', () => {
  const düzen = manifest.backgroundLayout;
  assert.ok(düzen, 'backgroundLayout yok');
  assert.equal(düzen.fitRatio, 2 / 3);
  assert.deepEqual(düzen.frames.yatay, {width: 1600, height: 640});
  assert.deepEqual(düzen.frames.yazi, {width: 1600, height: 640});
  assert.deepEqual(düzen.frames.dikey, {width: 1000, height: 1100});
  assert.deepEqual(düzen.frames.amblem, {width: 1000, height: 1000});
});

test('Toplu indirme ZIP yerinde; tam kurumsal ZIP localhost bırakmaz', () => {
  assert.ok(manifest.zip, 'zip adı yok');
  assert.ok(existsSync(join(v2, manifest.zip)), manifest.zip + ' eksik');
  // 88 MB tam paket panele konmadı; arayüz onu SUNMUYOR, 404 ya da localhost bırakmıyor.
  const modul = readFileSync(join(kok, 'public', 'brand-logos-ui.js'), 'utf8');
  assert.equal(modul.includes('fullPackageZip'), false, 'sunulmayan tam paket bağlantısı eklenmiş');
  assert.equal(/127\.0\.0\.1|localhost|8795/.test(modul), false, 'canlıda localhost bağlantısı kalmış');
});

test('Belge anteti ESKİ 32 kimlikte kalır: galeri genişlemesi antede taşmaz', async () => {
  const {APPROVED_LOGO_VARIANTS, isApprovedLogoVariant} = await import('../public/brand-logo-variants.js');
  assert.equal(APPROVED_LOGO_VARIANTS.length, 32, 'antet listesi galeriyle birlikte büyümüş');
  // Eski kayıtların kimlikleri HÂLÂ geçerli.
  const eslesme = JSON.parse(readFileSync(join(kok, '..', 'lunapot-claude-modul-guncelleme-2026-10-09',
    'ESKI-LOGO-YOLLARI.json'), 'utf8'));
  for (const giris of eslesme.variants)
    assert.ok(isApprovedLogoVariant(giris.legacyVariantId), giris.legacyVariantId + ' artık kabul edilmiyor');
  // Zeminli katalog kimliği antede OTOMATİK girmez.
  assert.equal(isApprovedLogoVariant('lunapot-yatay-lime-zemin-antrasit'), false);
  assert.equal(isApprovedLogoVariant('lunapot-yatay-antrasit-seffaf'), false);
});

test('Modül kaynak davranışını korur: tek dönüşüm, meet, doğal çizim', () => {
  const modul = readFileSync(join(kok, 'public', 'brand-logos-ui.js'), 'utf8');
  assert.ok(modul.includes("preserveAspectRatio', 'xMidYMid meet'"), 'preserveAspectRatio değişmiş');
  assert.ok(modul.includes('drawImage(image, 0, 0)'), 'doğal boyutta çizim yok');
  assert.ok(modul.includes('Math.round(width * box[3] / box[2])'), 'yükseklik viewBox oranından gelmeli');
  // Renkli modda canvas ÖNCE doldurulur, rect YALNIZ rasterizasyon kopyasından çıkar.
  assert.ok(modul.includes('context.fillRect(0, 0, width, height)'), 'canvas önce doldurulmuyor');
  assert.ok(modul.includes('rect.remove()'), 'rasterizasyon kopyasından rect çıkarılmıyor');
  assert.equal(/\.scale\(/.test(modul), false, 'canvas scale oranı bozar');
  // Satır içi style niteliği CSP'ye takılır.
  const yorumsuz = modul.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(s => !s.trim().startsWith('//')).join('\n');
  assert.equal(/style="/.test(yorumsuz), false, 'satır içi stil CSP tarafından engellenir');
  assert.ok(modul.includes('.style.background'), 'renk noktaları CSSOM ile atanmalı');
  // Mount/unmount yaşam döngüsü.
  assert.equal(yorumsuz.includes('DOMContentLoaded'), false);
  assert.equal(/document\.addEventListener/.test(yorumsuz), false);
  assert.equal(/window\.addEventListener/.test(yorumsuz), false);
});

test('Modül CSS i .lk-root altına hapsedilmiştir', () => {
  const css = readFileSync(join(kok, 'public', 'marka-logo-kutuphanesi.css'), 'utf8');
  // Yalnız @font-face ve .lk-root en üst düzeyde olabilir. Derinliği gerçekten say:
  // yuvalanmış kurallar girintili yazılmadığı için satır başı yeterli ölçü değil.
  const sade = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ustDuzey = [];
  let derinlik = 0, basla = 0;
  for (let i = 0; i < sade.length; i++) {
    if (sade[i] === '{') {
      if (derinlik === 0) ustDuzey.push(sade.slice(basla, i).trim());
      derinlik++;
    } else if (sade[i] === '}') {
      derinlik--;
      if (derinlik === 0) basla = i + 1;
    }
  }
  for (const secici of ustDuzey.filter(Boolean))
    assert.ok(/^@font-face$/.test(secici) || /^\.lk-root$/.test(secici),
      'kapsam dışına çıkan kural: ' + secici);
  assert.equal(derinlik, 0, 'CSS parantez dengesi bozuk');
  assert.ok(css.includes('LkInter'), 'font adı çakışmaya karşı yeniden adlandırılmalı');
  assert.equal(css.includes('LogoInter'), false, 'eski font adı kalmış');
  assert.equal(/url\('assets\//.test(css), false, 'göreli kaynak yolu kalmış');
});
