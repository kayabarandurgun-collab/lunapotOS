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

// --- Menu gorunurlugu ---
import {navigationGroups} from '../public/workspace-navigation.js';
const ecBasliklar={overview:'Genel durum',offers:'Teklif ve belgeler',settings:'Şirket ve yedek','logo-kutuphanesi':'Logo Kütüphanesi'};
const lpBasliklar={dashboard:'Genel durum',offers:'Teklif ve belgeler',settings:'Şirket ve yedek','logo-kutuphanesi':'Logo Kütüphanesi'};
const rotalar=(user,ns,basliklar)=>navigationGroups(ns,basliklar,user).flatMap(g=>g.routes);

test('Logo Kutuphanesi menude AYRI giris olarak cikar',()=>{
 const grup=navigationGroups('ec',ecBasliklar,owner).find(g=>g.key==='brand');
 assert.ok(grup,'marka grubu yok');
 assert.deepEqual(grup.routes,['logo-kutuphanesi']);
 // Teklif ekraninin icinde DEGIL: kendi grubunda.
 const teklifGrubu=navigationGroups('ec',ecBasliklar,owner).find(g=>g.routes.includes('offers'));
 assert.ok(!teklifGrubu.routes.includes('logo-kutuphanesi'));
});

test('Yetkisiz personel menude Logo girisini GORMEZ',()=>{
 assert.ok(!rotalar(secilmemis,'ec',ecBasliklar).includes('logo-kutuphanesi'));
 assert.ok(!rotalar(eskiHesap,'ec',ecBasliklar).includes('logo-kutuphanesi'));
 assert.ok(!rotalar(eskiHesap,'lp',lpBasliklar).includes('logo-kutuphanesi'));
 assert.ok(!rotalar(belgeOkur,'ec',ecBasliklar).includes('logo-kutuphanesi'));
});

test('Logo yetkisi verilen personel menude girisi gorur, iki alanda da',()=>{
 assert.ok(rotalar(logoOkur,'ec',ecBasliklar).includes('logo-kutuphanesi'));
 const lpLogo={lp_access:'read',permissions:parsePermissions({lp:{brand_logos:'read'}})};
 assert.ok(rotalar(lpLogo,'lp',lpBasliklar).includes('logo-kutuphanesi'));
 assert.ok(rotalar(owner,'lp',lpBasliklar).includes('logo-kutuphanesi'));
});
