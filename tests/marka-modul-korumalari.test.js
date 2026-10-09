import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {dirname,join} from 'node:path';

// Bu dosya marka modullerinin TUZAKLARINI kod duzeyinde kilitler. Her biri
// tarayicida gercek CSP altinda bir kez olculdu; buradaki kontroller geri gitmesini onler.
const kok=join(dirname(fileURLToPath(import.meta.url)),'..');
const oku=yol=>readFileSync(join(kok,yol),'utf8');
// Kontroller KODA bakar, yorumlara bakmaz: aciklama metni kurali tetiklemesin.
const yorumsuz=kaynak=>kaynak.replace(/\/\*[\s\S]*?\*\//g,'')
 .split('\n').filter(satir=>!satir.trim().startsWith('//')).join('\n');
const logoJs=yorumsuz(oku('public/brand-logos-ui.js'));
const markaCss=oku('public/marka-modulleri.css');
const worker=oku('src/worker.js');

test('Satir ici style="..." niteligi KULLANILMAZ: style-src self altinda engellenir',()=>{
 // Panelin baska hicbir modulu de kullanmaz; renkler CSSOM ile atanir.
 assert.equal(/style="/.test(logoJs),false,'satir ici style niteligi CSP tarafindan engellenir');
 assert.ok(logoJs.includes('.style.background'),'renk noktalari programatik atanmali');
 assert.ok(logoJs.includes('data-hex'),'renk noktalari data-hex ile isaretlenmeli');
 // Panelin TAMAMI icin ayni kural: baska modul de satir ici stil kullanmaya baslamasin.
 assert.equal(/style="/.test(yorumsuz(oku('public/offers-ui.js'))),false,'offers-ui satir ici stil kullanmis');
});

test('CSP: img-src blob: acik, ama unsafe-inline KAPALI kalir',()=>{
 const csp=worker.match(/Content-Security-Policy',"([^"]+)"/)?.[1];
 assert.ok(csp,'CSP basligi bulunamadi');
 assert.match(csp,/img-src 'self' data: blob:/,'logo onizlemesi icin img-src blob: gerekli');
 assert.match(csp,/script-src 'self';/,"script-src unsafe-inline ACILMAMALI");
 assert.match(csp,/style-src 'self';/,"style-src unsafe-inline ACILMAMALI");
 assert.equal(csp.includes('unsafe-inline'),false,'CSP gevsetilmis');
 assert.equal(csp.includes('unsafe-eval'),false,'CSP gevsetilmis');
});

test('Modul mount/unmount yasam dongusune bagli: global document dinleyicisi yok',()=>{
 assert.equal(logoJs.includes('DOMContentLoaded'),false,'DOMContentLoaded mount dongusunu bozar');
 assert.equal(/document\.addEventListener/.test(logoJs),false,'olaylar yalniz modul kokune baglanmali');
 assert.equal(/window\.addEventListener/.test(logoJs),false,'pencere dinleyicisi unmount edilmiyor');
 assert.equal(/window\.Lunapot/.test(logoJs),false,'tek global nesne kalmamali');
 // Olaylar AbortController signal'i ile kalkar.
 assert.ok(logoJs.includes('const controller = new AbortController()'));
 assert.equal((logoJs.match(/\{signal\}\)/g)||[]).length>=4,true,'dinleyiciler signal ile baglanmali');
 assert.ok(/return \(\) => \{ state\.disposed = true; releasePreview\(\); controller\.abort\(\); \}/.test(logoJs),
  'unmount: blob serbest birakilmali ve istekler iptal edilmeli');
});

test('Blob URL leri is bitince VE unmount ta serbest birakilir',()=>{
 assert.ok(logoJs.includes('releasePreview'),'onizleme blob u icin serbest birakma yok');
 // Her createObjectURL icin bir revoke yolu bulunmali.
 const olustur=(logoJs.match(/URL\.createObjectURL/g)||[]).length;
 const birak=(logoJs.match(/URL\.revokeObjectURL/g)||[]).length;
 assert.ok(birak>=olustur-1,'createObjectURL sayisi revoke sayisini asmamali ('+olustur+' vs '+birak+')');
});

test('HEX yalniz alti hane kabul edilir; serbest SVG/HTML yuklemesi yok',()=>{
 assert.ok(logoJs.includes('/^#[0-9A-Fa-f]{6}$/'),'kati HEX dogrulamasi yok');
 assert.equal(/innerHTML\s*=\s*[^;]*\+\s*(state\.svg|source)/.test(logoJs),false,'kullanici SVG si HTML e basilmamali');
 assert.equal(/\.outerHTML\s*=/.test(logoJs),false);
 // Kaynak SVG yalniz renk yoluyla degisir.
 assert.ok(logoJs.includes('source.replace(/currentColor/g, color)'),'kaynak yalniz currentColor ile degismeli');
 assert.equal(/<input[^>]*type="file"/.test(logoJs),false,'serbest dosya yuklemesi eklenmemeli');
});

test('PNG oran korumasi aynen durur: tamsayi viewport, meet, dogal cizim',()=>{
 assert.ok(logoJs.includes("preserveAspectRatio', 'xMidYMid meet'"),'preserveAspectRatio degismis');
 assert.ok(logoJs.includes('drawImage(image, 0, 0)'),'dogal boyutta cizim yapilmali');
 assert.ok(logoJs.includes('Math.round(width * box[3] / box[2])'),'yukseklik viewBox oranindan gelmeli');
 // Bagimsiz x/y olcek UYGULANMAZ.
 assert.equal(/\.scale\(/.test(logoJs),false,'canvas scale cagrisi oran bozar');
 assert.equal(/drawImage\([^)]*,\s*width\s*,\s*height\s*\)/.test(logoJs),false,'germe ile cizim yapilmis');
 assert.ok(logoJs.includes('[1024, 2048, 4096]'),'PNG boyutlari manifestle ayni kalmali');
});

test('Modul CSS i modul kokune hapsedilmistir: global kural YOK',()=>{
 // Secici listesini cikar: her kural blogunun basi.
 const seciciler=markaCss.replace(/\/\*[\s\S]*?\*\//g,'').match(/[^{}]+(?=\{)/g)
  .map(s=>s.trim()).filter(s=>s&&!s.startsWith('@'));
 const kacak=seciciler.filter(s=>s.split(',').some(tek=>{
  const t=tek.trim();
  // Her secici marka- ile baslayan bir sinifa dayanmali.
  return !/\.marka-/.test(t);
 }));
 assert.deepEqual(kacak,[],'bu seciciler modul disina sizar');
 // Global etiket kurallari diger ekranlari bozar.
 for(const global of [/^body\s*\{/m,/^html\s*\{/m,/^form\s*\{/m,/^table\s*\{/m,/^input\s*\{/m,/^button\s*\{/m])
  assert.equal(global.test(markaCss),false,'global etiket kurali var: '+global);
 // Baski kurallari ortak print.css in isi.
 assert.equal(markaCss.includes('@media print'),false,'baski kurallari bu dosyada olmamali');
});

test('Dokunma hedefleri panelin 44px olcegine uyar',()=>{
 for(const secici of ['.marka-layout-buttons button','.marka-downloads a','.marka-preview-toggle button']){
  const blok=markaCss.slice(markaCss.indexOf(secici+' {'));
  const govde=blok.slice(0,blok.indexOf('}'));
  assert.match(govde,/min-height: 44px/,secici+' dokunma hedefi 44px altinda');
 }
});

test('Varliklar panelin kendi kokunden servis edilir: dis baglanti yok',()=>{
 assert.ok(logoJs.includes("const ASSET_ROOT = '/marka/logo-v2/'"),'varlik koku panelin kendi yolu olmali');
 assert.equal(/127\.0\.0\.1|localhost|8795|8806/.test(logoJs),false,'yerel sunucu bagimliligi kalmis');
 // XML ad alani (xmlns) bir AG BAGLANTISI degildir; SVG'nin kimligidir.
 const agBaglantilari=(logoJs.match(/https?:\/\/[^'"\s)]*/g)||[]).filter(u=>!u.startsWith('http://www.w3.org/'));
 assert.deepEqual(agBaglantilari,[],'dis kaynak baglantisi var');
 assert.equal(/<iframe/.test(logoJs),false,'modul iframe icine alinmamali');
});

test('Servis calisani: onbellek adi yukseldi, 14 MB varlik ON BELLEGE ALINMADI',()=>{
 const sw=oku('public/sw.js');
 assert.ok(sw.includes('/brand-logos-ui.js'),'modul kabuk listesinde yok');
 assert.ok(sw.includes('/marka-modulleri.css'),'modul CSS i kabuk listesinde yok');
 // Logo varliklari listede OLMAMALI: 32 SVG + 96 PNG + ZIP on bellege alinmaz.
 assert.equal(/'\/marka\/logo\//.test(sw),false,'logo varliklari kabuk on bellegine alinmis');
 const ad=sw.match(/const CACHE='([^']+)'/)?.[1];
 assert.ok(ad,'CACHE adi bulunamadi');
 const surum=Number(ad.match(/v(\d+)/)?.[1]);
 assert.ok(surum>=194,'public/ degisti, onbellek adi yukselmeli (su an '+ad+')');
});

// --- Eski Teklif ekraninin PDF ciktisinda marka basligi ---
import {offerPdfDocument} from '../public/offer-document.js';
import {pdfBytes} from '../public/doc-engine.js';
import {pdfKit} from './helpers/pdf-kit.js';
import {offerTotals} from '../public/offer-math.js';

const ornekYuk = (sunum) => ({
  offer: {kind: 'quote', document_no: 'TKF-2026-0007', revision: 1, status: 'draft'},
  today: '2026-10-09',
  snapshot: {
    party: {name: 'Şişli Çiçekçilik', tax_id: '1234567890'},
    workspace: 'ec', kind: 'quote', title: 'Deneme',
    issue_date: '2026-10-01', valid_until: '2026-10-31', terms: '', currency: 'TRY',
    totals: offerTotals([{description: 'Saksı', unit: 'adet', quantity_milli: 2000,
      unit_price_cents: 12500, discount_bps: 1000, vat_bps: 2000}]),
    notice: 'Bu belge bir ticari tekliftir.',
    ...(sunum === undefined ? {} : {presentation: sunum})
  }
});

test('PDF belgesi marka basligi tasir ve onaylı logoya isaret eder',()=>{
 const varsayilan=offerPdfDocument(ornekYuk());
 assert.ok(varsayilan.brand,'marka blogu yok');
 assert.equal(varsayilan.brand.src,'/marka/logo/02-PNG/lunapot-yatay-antrasit-1024px.png');
 assert.ok(varsayilan.brand.height>0);
 // Belgede kayitli logo secimi varsa O kullanilir.
 const secili=offerPdfDocument(ornekYuk({logo_variant_id:'lunapot-dikey-siyah'}));
 assert.equal(secili.brand.src,'/marka/logo/02-PNG/lunapot-dikey-siyah-1024px.png');
});

test('Uydurma logo kimligi YOLA girmez, varsayilana duser',()=>{
 for(const kotu of ['../../etc/passwd','lunapot-yatay-antrasit/../../x','<script>',
                    'lunapot_yatay_antrasit','',null,42,{}]){
  const belge=offerPdfDocument(ornekYuk({logo_variant_id:kotu}));
  assert.equal(belge.brand.src,'/marka/logo/02-PNG/lunapot-yatay-antrasit-1024px.png',
   JSON.stringify(kotu)+' yola sizdi');
 }
});

test('Logo YUKLENEMEZSE belge yine uretilir, yalnizca logosuz',async()=>{
 // Test ortaminda fetch logoyu bulamaz; cikti alinamamasindansa logosuz cikmasi iyidir.
 const bytes=await pdfBytes(offerPdfDocument(ornekYuk()),await pdfKit());
 assert.ok(bytes.length>1000,'PDF uretilemedi');
 assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');
});

test('Marka blogu ISTEGE BAGLIDIR: eski cagrilar aynen calisir',async()=>{
 const {brand,...markasiz}=offerPdfDocument(ornekYuk());
 assert.equal('brand' in markasiz,false);
 const bytes=await pdfBytes(markasiz,await pdfKit());
 assert.ok(bytes.length>1000,'markasiz cagri bozuldu');
});
