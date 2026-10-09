import test from 'node:test';import assert from 'node:assert/strict';
import {level,canRoute,parsePermissions,modules} from '../public/permissions.js';
import {permit} from '../src/permission-policy.js';

// Belge Atolyesi ve Logo Kutuphanesi IKI AYRI yetkidir: biri digerini acmaz.
// Yeni anahtarlar mirasla gelmez; yonetici acikca secmeden kapali kalirlar.

const owner={owner:true};
const eskiHesap={ec_access:'write',lp_access:'write',permissions:null};
const secilmemis={ec_access:'write',permissions:parsePermissions({ec:{orders:'write'}})};
const belgeOkur={ec_access:'write',permissions:parsePermissions({ec:{brand_documents:'read'}})};
const belgeYazar={ec_access:'write',permissions:parsePermissions({ec:{brand_documents:'write'}})};
const logoOkur={ec_access:'write',permissions:parsePermissions({ec:{brand_logos:'read'}})};

test('Iki modul yetki kutugunde ayri anahtar olarak vardir',()=>{
 for(const ns of ['ec','lp'])for(const key of ['brand_documents','brand_logos'])
  assert.ok(modules[ns][key],ns+'/'+key+' eksik');
});

test('permissions kaydi olmayan eski hesap yeni ekranlari MIRASLA kazanmaz',()=>{
 assert.equal(level(eskiHesap,'ec','brand_documents'),'none');
 assert.equal(level(eskiHesap,'ec','brand_logos'),'none');
 assert.equal(level(eskiHesap,'lp','brand_documents'),'none');
 assert.equal(level(eskiHesap,'lp','brand_logos'),'none');
 // Eski anahtarlarin miras davranisi DEGISMEZ.
 assert.equal(level(eskiHesap,'ec','orders'),'write');
 assert.equal(level(eskiHesap,'lp','products'),'write');
});

test('Yetki kaydi olup secilmemis anahtar kapalidir; owner acikti',()=>{
 assert.equal(level(secilmemis,'ec','brand_documents'),'none');
 assert.equal(level(secilmemis,'ec','brand_logos'),'none');
 assert.equal(level(owner,'ec','brand_documents'),'write');
 assert.equal(level(owner,'lp','brand_logos'),'write');
});

test('Zarf seviyesi yeni anahtari da sinirlar',()=>{
 assert.equal(level({...belgeYazar,ec_access:'read'},'ec','brand_documents'),'read');
 assert.equal(level({...belgeYazar,ec_access:'none'},'ec','brand_documents'),'none');
});

test('Bir modulun yetkisi digerini acmaz',()=>{
 assert.equal(canRoute(belgeOkur,'ec','belge-atolyesi'),true);
 assert.equal(canRoute(belgeOkur,'ec','logo-kutuphanesi'),false);
 assert.equal(canRoute(logoOkur,'ec','logo-kutuphanesi'),true);
 assert.equal(canRoute(logoOkur,'ec','belge-atolyesi'),false);
});

test('Okuma yetkisi yazma rotasini acmaz',()=>{
 assert.equal(canRoute(belgeOkur,'ec','belge-atolyesi',true),false);
 assert.equal(canRoute(belgeYazar,'ec','belge-atolyesi',true),true);
});

test('Uclar sunucuda yetki ister: menu gizlemek yetmez',()=>{
 // Yetkisiz personel ucu DOGRUDAN cagirinca 403 alir.
 assert.throws(()=>permit(secilmemis,'/api/ec/brand-documents','GET'),/yetkiniz yok/);
 assert.throws(()=>permit(eskiHesap,'/api/ec/brand-documents','GET'),/yetkiniz yok/);
 assert.throws(()=>permit(logoOkur,'/api/ec/brand-documents','GET'),/yetkiniz yok/);
 assert.throws(()=>permit(belgeOkur,'/api/ec/brand-logos','GET'),/yetkiniz yok/);
 // Okuma yetkisi okur, yazamaz.
 permit(belgeOkur,'/api/ec/brand-documents','GET');
 assert.throws(()=>permit(belgeOkur,'/api/ec/brand-documents','POST'),/yetkiniz yok/);
 permit(belgeYazar,'/api/ec/brand-documents','POST');
 permit(logoOkur,'/api/ec/brand-logos','GET');
 // Owner her ikisini de kullanir.
 permit(owner,'/api/ec/brand-documents','POST');
 permit(owner,'/api/lp/brand-logos','GET');
});

test('Calisma alani sinirı: ec yetkisi lp ucunu acmaz',()=>{
 assert.throws(()=>permit(belgeYazar,'/api/lp/brand-documents','GET'),/yetkiniz yok/);
 const lpYazar={lp_access:'write',ec_access:'none',permissions:parsePermissions({lp:{brand_documents:'write'}})};
 permit(lpYazar,'/api/lp/brand-documents','POST');
 assert.throws(()=>permit(lpYazar,'/api/ec/brand-documents','GET'),/yetkiniz yok/);
});

// --- Yerlesim: marka modulleri AYRI bir uygulamadir ---
// Kullanici 09.10'da acikca istedi: "ben e ticaretin icinde gormek istemiyorum ki bunu,
// muhasebe sayfasina ayri bi modul kur". Iki modul artik /atolye/ altinda yasar.
import {navigationGroups} from '../public/workspace-navigation.js';
import {moduleHref as href} from '../public/permissions.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const kok = join(dirname(fileURLToPath(import.meta.url)), '..');
const oku = yol => readFileSync(join(kok, yol), 'utf8');

const ecBasliklar = {overview: 'Genel durum', offers: 'Teklif ve belgeler', settings: 'Şirket ve yedek'};
const lpBasliklar = {dashboard: 'Genel durum', offers: 'Teklif ve belgeler', settings: 'Şirket ve yedek'};
const rotalar = (user, ns, basliklar) => navigationGroups(ns, basliklar, user).flatMap(g => g.routes);

test('Marka modulleri e-ticaret ve uretim menusunde YOKTUR', () => {
  for (const [ns, basliklar] of [['ec', ecBasliklar], ['lp', lpBasliklar]]) {
    const liste = rotalar(owner, ns, basliklar);
    assert.equal(liste.includes('belge-atolyesi'), false, ns + ' menusunde belge-atolyesi var');
    assert.equal(liste.includes('logo-kutuphanesi'), false, ns + ' menusunde logo-kutuphanesi var');
    assert.equal(navigationGroups(ns, basliklar, owner).some(g => g.key === 'brand'), false, ns + ' marka grubu geri gelmis');
  }
  // Kabuklarda da rota kaydi kalmamali: yoksa adres calisir ama menu gostermez.
  for (const dosya of ['public/ecommerce.js', 'public/app.js', 'public/workspace-navigation.js'])
    for (const rota of ['belge-atolyesi', 'logo-kutuphanesi'])
      assert.equal(oku(dosya).includes(rota), false, dosya + ' icinde ' + rota + ' izi kalmis');
});

test('Marka Atolyesi kendi uygulamasidir: rota, kabuk ve ana ekran karti yerinde', () => {
  const kabuk = oku('public/atolye.js');
  assert.ok(kabuk.includes("'belge-atolyesi'"), 'atolye kabugunda belge rotasi yok');
  assert.ok(kabuk.includes("'logo-kutuphanesi'"), 'atolye kabugunda logo rotasi yok');
  assert.ok(oku('public/atolye.html').includes('/atolye.js'), 'atolye sayfasi kabugu yuklemiyor');
  // Worker /atolye adresini sayfaya baglamali.
  assert.match(oku('src/worker.js'), /path==='\/atolye'\|\|path==='\/atolye\/'/, 'worker rotasi yok');
  // Ana ekranda kart olmali: kullanici buradan bulacak.
  const anaEkran = oku('public/index.html');
  assert.ok(anaEkran.includes('href="/atolye/#belge-atolyesi"'), 'ana ekranda atolye karti yok');
  assert.ok(anaEkran.includes('Marka Atölyesi'), 'kart basligi yok');
});

test('Personel kartlari ve kisayollar /atolye/ adresine gider', () => {
  assert.equal(href('ec', 'brand_documents'), '/atolye/#belge-atolyesi?alan=ec');
  assert.equal(href('lp', 'brand_documents'), '/atolye/#belge-atolyesi?alan=lp');
  assert.equal(href('ec', 'brand_logos'), '/atolye/#logo-kutuphanesi?alan=ec');
  assert.equal(href('ec', 'webshop'), '/webmagaza/');
  assert.equal(href('ec', 'orders'), '#orders');
  // Teklif ekranindaki baglanti da oraya gitmeli.
  assert.match(oku('public/offers-ui.js'), /\/atolye\/#belge-atolyesi\?alan=/, 'Teklif ekrani eski adrese gidiyor');
});

test('Yetki kontrolu atolye kabugunda da calisir', () => {
  // Kabuk canRoute ile sorar; rota takma adlari duruyor.
  assert.equal(canRoute(belgeOkur, 'ec', 'belge-atolyesi'), true);
  assert.equal(canRoute(belgeOkur, 'ec', 'logo-kutuphanesi'), false);
  assert.equal(canRoute(belgeOkur, 'lp', 'belge-atolyesi'), false, 'ec yetkisi lp alanini acmamali');
  assert.equal(canRoute(eskiHesap, 'ec', 'belge-atolyesi'), false);
  assert.equal(canRoute(owner, 'lp', 'logo-kutuphanesi'), true);
});
