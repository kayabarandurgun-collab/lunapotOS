// ARAYÜZ ÖLÇEĞİ: bütün ekranlar tek bir ölçü ölçeğine oturur.
//
//   · Düğmenin TEK köşe yarıçapı vardır (--radius-dugme).
//   · Düğme yazısı EN ÇOK iki kademedir: normal (--yazi-dugme) ve küçük (--yazi-dugme-kucuk).
//   · Düğme yazı kalınlığı tektir (--kalinlik-dugme).
//   · Kart köşesi ve iç boşluğu tek ölçektir (--radius-kart, --dolgu-kart / --dolgu-kart-dar).
//   · Giriş alanı düğmeyle aynı yarıçapı kullanır.
//
// Tarama SINIF ADIYLA DEĞİL, seçicinin en sağdaki bileşeniyle yapılır: `footer button`,
// `.ol-seg button` gibi sınıfsız düğmeler de ağa takılır. `font` KISAYOLU ayrıca yasaktır,
// çünkü `font:inherit` font-size'ı da sıfırlayıp düğmeyi kapsayıcıdan miras almaya zorlar
// (canlıda düğmelerin 14px çıkmasının sebebi buydu).
//
// Görsel kimlik (renk, yazı tipi, marka yeşili) bu testin konusu DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const CSS_DIZIN = new URL('../public/', import.meta.url);
const CSS_DOSYALARI = readdirSync(CSS_DIZIN).filter(f => f.endsWith('.css')).sort();

/** Parantez farkındalıklı virgül bölme: `:is(a,b)` parçalanmaz. */
function bolVirgul(metin) {
  const cikti = [];
  let derin = 0, parca = '';
  for (const harf of metin) {
    if (harf === '(') derin++;
    if (harf === ')') derin--;
    if (harf === ',' && !derin) { if (parca.trim()) cikti.push(parca.trim()); parca = ''; }
    else parca += harf;
  }
  if (parca.trim()) cikti.push(parca.trim());
  return cikti;
}

/** Bütün bildirimleri {dosya, satir, medya, secici, ozellik, deger} olarak çıkarır. */
function bildirimleriOku() {
  const cikti = [];
  for (const dosya of CSS_DOSYALARI) {
    const kaynak = readFileSync(new URL(dosya, CSS_DIZIN), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const katman = [];
    let derinlik = 0, tampon = '', satir = 1;
    for (let i = 0; i < kaynak.length; i++) {
      const harf = kaynak[i];
      if (harf === '\n') satir++;
      if (harf === '{') {
        const secici = tampon.trim().replace(/\s+/g, ' ');
        tampon = '';
        if (secici.startsWith('@')) { katman.push({secici, derinlik}); derinlik++; continue; }
        let govde = '', d = 1, j = i + 1;
        for (; j < kaynak.length; j++) {
          if (kaynak[j] === '{') d++;
          else if (kaynak[j] === '}') { d--; if (!d) break; }
          govde += kaynak[j];
        }
        const baslangic = satir;
        for (let q = i; q < j; q++) if (kaynak[q] === '\n') satir++;
        for (const parca of govde.split(';')) {
          const ayrac = parca.indexOf(':');
          if (ayrac < 0) continue;
          const ozellik = parca.slice(0, ayrac).trim().toLowerCase();
          if (!/^(border-radius|font-size|font-weight|font|padding|min-height)$/.test(ozellik)) continue;
          const deger = parca.slice(ayrac + 1).trim();
          for (const tek of bolVirgul(secici))
            cikti.push({dosya, satir: baslangic, medya: katman.map(k => k.secici).join(' '),
              secici: tek, ozellik, deger, govde});
        }
        i = j;
        continue;
      }
      if (harf === '}') { derinlik--; if (katman.length && katman[katman.length - 1].derinlik === derinlik) katman.pop(); tampon = ''; continue; }
      tampon += harf;
    }
  }
  return cikti;
}

const BILDIRIMLER = bildirimleriOku();
const yer = b => b.dosya + ':' + b.satir + ' {' + b.ozellik + ': ' + b.deger + '} ' + b.secici.slice(0, 85);

/** Seçicinin en sağdaki bileşeni (hedef aldığı öğe). */
const sonBilesen = secici => secici.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';

const DUGME_ADLARI = ['primary', 'secondary', 'danger-button', 'text-button', 'icon-button',
  'ol-chip', 'ol-seg', 'rb-tabs', 'ins-date-presets', 'ol-btn', 'button'];

/** Bu seçici bir DÜĞMEYİ mi biçimlendiriyor? (sınıfsız `button` dahil) */
function dugmeyiHedefler(secici) {
  const son = sonBilesen(secici).replace(/\[[^\]]*\]/g, '');
  if (son.includes('::')) return false;                 // sözde öğe, ölçüme girmez
  for (const ad of DUGME_ADLARI) {
    const desen = new RegExp('(^|[.:(,\\s])' + ad + '(?![a-zA-Z0-9_-])');
    if (desen.test(son)) return true;
  }
  return false;
}

const JETON = /^var\(--(radius-dugme|radius-kart|yazi-dugme|yazi-dugme-kucuk|yazi-rozet|kalinlik-dugme)\)/;

/**
 * Bilinçli istisnalar. Her biri GEREKÇELİ; gerekçesiz istisna eklenemez.
 * Anahtar: dosya + seçici parçası + özellik.
 */
const BILINCLI_ISTISNA = [
  {dosya: 'workspace-design.css', parca: ':is(.v2-tabs,.ac-tabs) :is(button,a)', ozellik: 'border-radius',
    neden: 'alt çizgili sekme şeridi — köşe yuvarlatmak alt çizgiyi bozar'},
  {dosya: 'style.css', parca: '.icon-button', ozellik: 'font-size',
    neden: 'simge düğmesindeki font-size etiket değil, glif boyutudur'},
  {dosya: 'insights-design.css', parca: '.ins-dialog .icon-button', ozellik: 'font-size',
    neden: 'kapatma glifinin boyutu'},
  {dosya: 'style.css', parca: '.disabled-input button', ozellik: 'font-size',
    neden: '32×32 glif düğmesi — etiket yazısı yok'},
  {dosya: 'style.css', parca: 'footer button', ozellik: 'font-weight',
    neden: 'alt bilgi bağlantıları bilinçli olarak metin ağırlığında (400), düğme ağırlığında değil'},
  {dosya: 'ui-polish.css', parca: '.ol-table th button', ozellik: 'font',
    neden: 'all:unset ile sıfırlanan sütun sıralama düğmesi — düz başlık metni gibi görünür'},
  {dosya: 'ui-polish.css', parca: '.ol-table th button:focus-visible', ozellik: 'border-radius',
    neden: 'düz metin sıralama düğmesinin odak halkası — düğme gövdesi değil'},
  {dosya: 'workspace-design.css', parca: '.mobile-dock', ozellik: 'font-size',
    neden: 'mobil alt gezinme çubuğunda simge altındaki mikro etiket (9px), düğme etiketi değil'},
  {dosya: 'production-design.css', parca: ':is(.primary,.secondary,.text-button,.icon-button)', ozellik: 'font-size',
    neden: 'ortak kural; .text-button küçük kademeye ayrı kuralla çekilir'}
];
const istisnaMi = b => BILINCLI_ISTISNA.some(i =>
  i.dosya === b.dosya && b.secici.includes(i.parca) && i.ozellik === b.ozellik);

/* ============================ DÜĞME ÖLÇEĞİ ============================ */

test('`font` kısayolu düğmenin boyutunu sessizce sıfırlamaz', () => {
  // `font:inherit` font-size'ı da miras alınan değere çeker; düğme kapsayıcının
  // boyutunu kapar ve ölçek sessizce delinir. Canlıda 14px çıkmasının kök sebebi buydu.
  // Kısayol ancak AYNI kuralda ARDINDAN font-size yeniden yazılıyorsa güvenlidir.
  const guvensiz = BILDIRIMLER.filter(b => {
    if (b.ozellik !== 'font' || !dugmeyiHedefler(b.secici) || istisnaMi(b)) return false;
    const sonra = b.govde.slice(b.govde.indexOf('font:'));
    return !/font-size\s*:/.test(sonra);
  });
  assert.deepEqual(guvensiz.map(yer), [],
    '`font` kısayolundan sonra font-size yeniden yazılmalı (ya da kısayol hiç kullanılmamalı)');
});

test('düğmenin tek köşe yarıçapı vardır', () => {
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && dugmeyiHedefler(b.secici)
    && b.deger !== 'var(--radius-dugme)' && !istisnaMi(b));
  assert.deepEqual(sapan.map(yer), [], 'düğme yarıçapı --radius-dugme dışında değer kullanıyor');
});

test('düğme yazı boyutu en çok iki kademedir', () => {
  const izin = new Set(['var(--yazi-dugme)', 'var(--yazi-dugme-kucuk)', 'var(--yazi-dugme-kucuk)!important']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-size' && dugmeyiHedefler(b.secici)
    && !izin.has(b.deger) && !istisnaMi(b));
  assert.deepEqual(sapan.map(yer), [], 'düğme yazı boyutu iki kademe dışına çıkıyor');
});

test('düğme yazı kalınlığı tektir', () => {
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-weight' && dugmeyiHedefler(b.secici)
    && b.deger !== 'var(--kalinlik-dugme)' && !istisnaMi(b));
  assert.deepEqual(sapan.map(yer), [], 'düğme yazı kalınlığı --kalinlik-dugme dışında değer kullanıyor');
});

test('düğme ölçeği tarayıcısı gerçekten yakalıyor (kendi kendini sınar)', () => {
  // Tarayıcı sessizce boş dönerse test işe yaramaz. Bilinen kötü örnekler YAKALANMALI.
  for (const kotu of ['footer button', '.ol-seg button', '.ol-chip', '.primary',
    '.workflow-page :is(button,.primary,.secondary)', '.launchpad button', 'td .secondary'])
    assert.ok(dugmeyiHedefler(kotu), kotu + ' düğme olarak tanınmadı — tarayıcı kör');
  for (const iyi of ['.card', '.v2-card-head', 'input, select', 'button[aria-busy=true]::after'])
    assert.ok(!dugmeyiHedefler(iyi), iyi + ' yanlışlıkla düğme sayıldı');
  // Ağ gerçekten bildirim görüyor mu?
  const gorulen = BILDIRIMLER.filter(b => dugmeyiHedefler(b.secici)
    && /^(border-radius|font-size|font-weight)$/.test(b.ozellik));
  assert.ok(gorulen.length > 60, 'düğme bildirimleri taranmıyor (' + gorulen.length + ' adet)');
  assert.ok(gorulen.every(b => JETON.test(b.deger) || istisnaMi(b)),
    'taranan düğme bildirimlerinin hepsi jeton ya da gerekçeli istisna olmalı');
});

/* ============================ SEKME / KART / GİRİŞ ============================ */

test('sekme yazısı ölçek kademelerini kullanır', () => {
  const hedef = /\.(v2-tabs|ac-tabs|rb-tabs|performance-tabs|ins-product-tabs|ins-date-presets)\b/;
  const izin = new Set(['var(--yazi-dugme-kucuk)', 'var(--yazi-dugme)']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-size' && hedef.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'sekme yazı boyutu ölçek dışında');
});

test('kart köşesi tek ölçektir', () => {
  const hedef = /(^|[\s,>+~(])\.(card|v2-card|pn-card|recipe-card|stat|v2-stat)\b/;
  const izin = new Set(['var(--radius-kart)', 'var(--radius-kart)!important', 'inherit']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && hedef.test(b.secici)
    && !izin.has(b.deger) && !/^0(px)?$/.test(b.deger) && !/\.stat\.highlight::after/.test(b.secici));
  assert.deepEqual(sapan.map(yer), [], 'kart yarıçapı --radius-kart dışında değer kullanıyor');
});

test('kart iç boşluğu tek ölçektir', () => {
  const hedef = /\.(card-heading|v2-card-head|v2-card-body)\b/;
  const izin = new Set(['var(--dolgu-kart)', 'var(--dolgu-kart-dar)', 'var(--dolgu-kart-dar)!important']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'padding' && hedef.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'kart iç boşluğu ölçek dışında');
});

test('giriş alanı düğmeyle aynı yarıçapı kullanır', () => {
  const hedef = /(^|[\s,>+~(])(input|select|textarea)\b/;
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && hedef.test(b.secici)
    && b.deger !== 'var(--radius-dugme)' && !/file-selector-button|\[type=(checkbox|radio)\]|::-webkit/.test(b.secici));
  assert.deepEqual(sapan.map(yer), [], 'giriş alanı yarıçapı --radius-dugme dışında değer kullanıyor');
});

/* ============================ KORUMALAR ============================ */

test('ölçek değişkenleri bütün ekranların yüklediği dosyada tanımlıdır', () => {
  const kaynak = readFileSync(new URL('workspace-design.css', CSS_DIZIN), 'utf8');
  for (const ad of ['--radius-dugme', '--radius-kart', '--radius-rozet', '--yazi-dugme', '--yazi-dugme-kucuk',
    '--yazi-rozet', '--kalinlik-dugme', '--dolgu-kart', '--dolgu-kart-dar', '--dolgu-dugme'])
    assert.match(kaynak, new RegExp(ad + '\\s*:'), ad + ' workspace-design.css içinde tanımlı değil');
  for (const sayfa of ['index.html', 'ecommerce.html', 'production.html', 'access.html', 'webshop.html'])
    assert.match(readFileSync(new URL(sayfa, CSS_DIZIN), 'utf8'), /workspace-design\.css/, sayfa + ' ölçeği yüklemiyor');
});

test('bilinçli sıfır yarıçaplar gerekçesiyle korunur', () => {
  const BILINCLI_SIFIR = [
    {dosya: 'workspace-design.css', parca: ':is(.v2-tabs,.ac-tabs)', neden: 'alt çizgili sekme şeridi'},
    {dosya: 'commerce-design.css', parca: ':is(.v2-tabs,.ac-tabs)', neden: 'alt çizgili sekme şeridi'},
    {dosya: 'commerce-workflows.css', parca: 'dialog.workflow-dialog', neden: 'mobilde tam ekran diyalog'},
    {dosya: 'production-design.css', parca: '.production-dialog', neden: 'mobilde tam ekran diyalog'},
    {dosya: 'design.css', parca: 'dialog.order-insights', neden: 'kenardan kenara tam ekran diyalog'},
    {dosya: 'webshop.css', parca: '.webstore-admin .table-wrap', neden: 'kart görünümü kaldırılmış tablo sarmalayıcısı'},
    {dosya: 'access-design.css', parca: '.access-hero', neden: 'kart görünümü kaldırılmış kahraman alanı'}
  ];
  for (const {dosya, parca, neden} of BILINCLI_SIFIR) {
    const eslesen = BILDIRIMLER.filter(b => b.dosya === dosya && b.ozellik === 'border-radius'
      && b.secici.includes(parca) && /^0(px)?$/.test(b.deger));
    assert.ok(eslesen.length > 0, dosya + ' · ' + parca + ' sıfır yarıçapı kayboldu (' + neden + ')');
  }
});

test('her bilinçli istisnanın gerekçesi yazılıdır ve gerçekten kullanılır', () => {
  for (const i of BILINCLI_ISTISNA) {
    assert.ok(i.neden && i.neden.length > 20, i.dosya + ' · ' + i.parca + ' için gerekçe yetersiz');
    const kullanilan = BILDIRIMLER.some(b => b.dosya === i.dosya && b.secici.includes(i.parca) && b.ozellik === i.ozellik);
    assert.ok(kullanilan, 'ölü istisna: ' + i.dosya + ' · ' + i.parca + ' · ' + i.ozellik);
  }
});

test('mobil dokunma hedefi 44px altına düşmez', () => {
  const kaynak = readFileSync(new URL('workspace-design.css', CSS_DIZIN), 'utf8');
  assert.match(kaynak, /body\.workspace-redesign :is\(\.primary,\.secondary,\.text-button,\.icon-button[^}]*min-height:44px/,
    'mobil dokunma hedefi kuralı kayboldu');
});
