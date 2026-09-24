// ARAYÜZ ÖLÇEĞİ: bütün ekranlar tek bir ölçü ölçeğine oturur.
//
//   · Düğmenin TEK köşe yarıçapı vardır (--radius-dugme).
//   · Düğme yazısı EN ÇOK iki kademedir: normal (--yazi-dugme) ve küçük (--yazi-dugme-kucuk).
//   · Düğme yazı kalınlığı tektir (--kalinlik-dugme).
//   · Kart köşesi ve iç boşluğu tek ölçektir (--radius-kart, --dolgu-kart / --dolgu-kart-dar).
//   · Giriş alanı düğmeyle aynı yarıçapı kullanır.
//
// Bilinçli istisnalar (0 yarıçap) korunur: alt çizgili sekme şeridi, tam ekran
// diyalog, kart görünümü kaldırılmış tablo sarmalayıcısı ve kahraman alanı.
//
// Görsel kimlik (renk, yazı tipi, marka yeşili) bu testin konusu DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const CSS_DIZIN = new URL('../public/', import.meta.url);
const CSS_DOSYALARI = readdirSync(CSS_DIZIN).filter(f => f.endsWith('.css')).sort();

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
          if (!/^(border-radius|font-size|font-weight|padding|min-height)$/.test(ozellik)) continue;
          cikti.push({dosya, satir: baslangic, medya: katman.map(k => k.secici).join(' '),
            secici, ozellik, deger: parca.slice(ayrac + 1).trim()});
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
const yer = b => b.dosya + ':' + b.satir + ' {' + b.ozellik + ': ' + b.deger + '} ' + b.secici.slice(0, 90);

/** Bilinçli olarak ölçek dışı bırakılan seçiciler; her biri için gerekçe zorunludur. */
const BILINCLI_SIFIR = [
  {dosya: 'workspace-design.css', parca: ':is(.v2-tabs,.ac-tabs)', neden: 'alt çizgili sekme şeridi'},
  {dosya: 'commerce-design.css', parca: ':is(.v2-tabs,.ac-tabs)', neden: 'alt çizgili sekme şeridi'},
  {dosya: 'commerce-workflows.css', parca: 'dialog.workflow-dialog', neden: 'mobilde tam ekran diyalog'},
  {dosya: 'production-design.css', parca: '.production-dialog', neden: 'mobilde tam ekran diyalog'},
  {dosya: 'design.css', parca: 'dialog.order-insights', neden: 'kenardan kenara tam ekran diyalog'},
  {dosya: 'webshop.css', parca: '.webstore-admin .table-wrap', neden: 'kart görünümü kaldırılmış tablo sarmalayıcısı'},
  {dosya: 'access-design.css', parca: '.access-hero', neden: 'kart görünümü kaldırılmış kahraman alanı'}
];

test('düğmenin tek köşe yarıçapı vardır', () => {
  const hedef = /(\.primary|\.secondary|\.danger-button|\.icon-button|\.text-button)/;
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && hedef.test(b.secici)
    && b.deger !== 'var(--radius-dugme)');
  assert.deepEqual(sapan.map(yer), [], 'düğme yarıçapı --radius-dugme dışında değer kullanıyor');
});

test('düğme yazı boyutu en çok iki kademedir', () => {
  // .icon-button dışarıda: oradaki font-size simge boyutudur, etiket boyutu değil.
  const hedef = /(\.primary|\.secondary|\.danger-button|\.text-button)/;
  const izin = new Set(['var(--yazi-dugme)', 'var(--yazi-dugme-kucuk)']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-size' && hedef.test(b.secici)
    && !/\.icon-button/.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'düğme yazı boyutu iki kademe dışına çıkıyor');
});

test('düğme yazı kalınlığı tektir', () => {
  const hedef = /(\.primary|\.secondary|\.danger-button|\.text-button)/;
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-weight' && hedef.test(b.secici)
    && b.deger !== 'var(--kalinlik-dugme)');
  assert.deepEqual(sapan.map(yer), [], 'düğme yazı kalınlığı --kalinlik-dugme dışında değer kullanıyor');
});

test('sekme yazısı ölçek kademelerini kullanır', () => {
  const hedef = /\.(v2-tabs|ac-tabs|rb-tabs|performance-tabs|ins-product-tabs|ins-date-presets)\b/;
  const izin = new Set(['var(--yazi-dugme-kucuk)', 'var(--yazi-dugme)']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'font-size' && hedef.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'sekme yazı boyutu ölçek dışında');
});

test('kart köşesi tek ölçektir', () => {
  const hedef = /(^|[\s,>+~(])\.(card|v2-card|pn-card|recipe-card)\b/;
  const izin = new Set(['var(--radius-kart)', 'inherit']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && hedef.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'kart yarıçapı --radius-kart dışında değer kullanıyor');
});

test('kart iç boşluğu tek ölçektir', () => {
  const hedef = /\.(card-heading|v2-card-head|v2-card-body)\b/;
  const izin = new Set(['var(--dolgu-kart)', 'var(--dolgu-kart-dar)']);
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'padding' && hedef.test(b.secici) && !izin.has(b.deger));
  assert.deepEqual(sapan.map(yer), [], 'kart iç boşluğu ölçek dışında');
});

test('giriş alanı düğmeyle aynı yarıçapı kullanır', () => {
  const hedef = /(^|[\s,>+~(])(input|select|textarea)\b/;
  const sapan = BILDIRIMLER.filter(b => b.ozellik === 'border-radius' && hedef.test(b.secici)
    && b.deger !== 'var(--radius-dugme)' && !/file-selector-button|\[type=(checkbox|radio)\]|::-webkit/.test(b.secici));
  assert.deepEqual(sapan.map(yer), [], 'giriş alanı yarıçapı --radius-dugme dışında değer kullanıyor');
});

test('ölçek değişkenleri bütün ekranların yüklediği dosyada tanımlıdır', () => {
  const kaynak = readFileSync(new URL('workspace-design.css', CSS_DIZIN), 'utf8');
  for (const ad of ['--radius-dugme', '--radius-kart', '--yazi-dugme', '--yazi-dugme-kucuk',
    '--kalinlik-dugme', '--dolgu-kart', '--dolgu-kart-dar', '--dolgu-dugme'])
    assert.match(kaynak, new RegExp(ad + '\\s*:'), ad + ' workspace-design.css içinde tanımlı değil');
  // workspace-design.css bütün ekranlarda yüklenir; ölçeğin oraya yazılması şarttır.
  for (const sayfa of ['index.html', 'ecommerce.html', 'production.html', 'access.html', 'webshop.html'])
    assert.match(readFileSync(new URL(sayfa, CSS_DIZIN), 'utf8'), /workspace-design\.css/, sayfa + ' ölçeği yüklemiyor');
});

test('bilinçli sıfır yarıçaplar korunur', () => {
  for (const {dosya, parca, neden} of BILINCLI_SIFIR) {
    const eslesen = BILDIRIMLER.filter(b => b.dosya === dosya && b.ozellik === 'border-radius'
      && b.secici.includes(parca) && /^0(px)?$/.test(b.deger));
    assert.ok(eslesen.length > 0, dosya + ' · ' + parca + ' sıfır yarıçapı kayboldu (' + neden + ')');
  }
});

test('mobil dokunma hedefi 44px altına düşmez', () => {
  const kaynak = readFileSync(new URL('workspace-design.css', CSS_DIZIN), 'utf8');
  assert.match(kaynak, /body\.workspace-redesign :is\(\.primary,\.secondary,\.text-button,\.icon-button[^}]*min-height:44px/,
    'mobil dokunma hedefi kuralı kayboldu');
});
