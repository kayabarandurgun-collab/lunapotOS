import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {dirname,join} from 'node:path';

// Onayli logo kaynaklari panelde BIREBIR durmali. Geometri degismez: bu test
// manifestteki her yolun var oldugunu ve sha256'sinin ayni kaldigini olcer.
const kok=join(dirname(fileURLToPath(import.meta.url)),'..','public','marka','logo');
const manifest=JSON.parse(readFileSync(join(kok,'manifest.json'),'utf8'));
const hash=yol=>createHash('sha256').update(readFileSync(join(kok,yol))).digest('hex');

test('Dort yerlesim, dokuz renk ve 32 varyant eksiksiz',()=>{
 assert.deepEqual(manifest.layouts.map(l=>l.id),['yatay','dikey','amblem','yazi']);
 assert.equal(manifest.colors.length,9);
 assert.equal(manifest.variants.length,32);
 for(const layout of ['yatay','dikey','amblem','yazi'])
  assert.ok(manifest.variants.some(v=>v.layout===layout),layout+' yerlesimi yok');
});

test('32 SVG dosyasi var ve hash degismemis',()=>{
 const gorulen=new Set();
 for(const v of manifest.variants){
  assert.ok(existsSync(join(kok,v.svg)),v.svg+' eksik');
  assert.equal(hash(v.svg),v.sha256,v.svg+' degismis');
  gorulen.add(v.svg);
 }
 assert.equal(gorulen.size,32);
});

test('96 seffaf PNG var, hash degismemis ve oran korunmus',()=>{
 let sayi=0;
 for(const v of manifest.variants){
  assert.equal(v.pngs.length,3,v.id+' uc PNG boyutu tasimali');
  assert.deepEqual(v.pngs.map(p=>p.width),[1024,2048,4096]);
  for(const png of v.pngs){
   assert.ok(existsSync(join(kok,png.path)),png.path+' eksik');
   assert.equal(hash(png.path),png.sha256,png.path+' degismis');
   assert.equal(png.transparent,true,png.path+' seffaf degil');
   // Yukseklik SVG oranindan tamsayiya yuvarlanir; bagimsiz x/y germe YOK.
   assert.equal(png.height,Math.max(1,Math.round(png.width*v.height/v.width)),png.path+' orani bozulmus');
   sayi++;
  }
 }
 assert.equal(sayi,96);
});

test('Dort ozel renk kaynagi currentColor ile calisir',()=>{
 const kaynaklar=manifest.customSources;
 assert.deepEqual(Object.keys(kaynaklar).sort(),['amblem','dikey','yatay','yazi']);
 for(const [layout,yol] of Object.entries(kaynaklar)){
  assert.ok(existsSync(join(kok,yol)),yol+' eksik');
  const svg=readFileSync(join(kok,yol),'utf8');
  assert.ok(svg.includes('currentColor'),layout+' kaynaginda currentColor yok');
  assert.ok(svg.includes('<svg'),layout+' kaynagi SVG degil');
  assert.ok(/viewBox="[\d.\s-]+"/.test(svg),layout+' kaynaginda viewBox yok');
  // Renk disinda hicbir sey degismez: kaynak sabit kalir.
  assert.ok(!svg.includes('<script'),layout+' kaynaginda script var');
 }
});

test('Toplu indirme ZIP dosyasi yerinde',()=>{
 assert.ok(manifest.zip,'manifestte zip adi yok');
 assert.ok(existsSync(join(kok,manifest.zip)),manifest.zip+' eksik');
});

test('Hazir varyantlar yalniz izinli renk kimliklerini kullanir',()=>{
 const renkler=new Set(manifest.colors.map(c=>c.id));
 for(const v of manifest.variants)assert.ok(renkler.has(v.colorId),v.id+' tanimsiz renk kullaniyor');
});

// --- Onayli kimlik listesi manifestle ayni kalmali ---
import {APPROVED_LOGO_VARIANTS,isApprovedLogoVariant} from '../public/brand-logo-variants.js';

test('Belge sunumunda kabul edilen logo kimlikleri manifestle BIREBIR aynidir',()=>{
 // Liste manifestten uretildi. Manifest degisirse bu test kirmizi olur ve
 // uydurma kimlik API den gecmez.
 assert.deepEqual([...APPROVED_LOGO_VARIANTS].sort(),manifest.variants.map(v=>v.id).sort());
 assert.equal(APPROVED_LOGO_VARIANTS.length,32);
 assert.ok(isApprovedLogoVariant(manifest.variants[0].id));
 assert.equal(isApprovedLogoVariant('lunapot-uydurma-renk'),false);
 assert.equal(isApprovedLogoVariant(''),false);
 assert.equal(isApprovedLogoVariant(null),false);
 assert.equal(isApprovedLogoVariant('__proto__'),false);
});
