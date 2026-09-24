import test from 'node:test';
import assert from 'node:assert/strict';
import {satisSayfasi,SATIS_SAYFA} from '../public/accounting-ui.js';

const kayitlar=n=>Array.from({length:n},(_,i)=>({id:'S'+i}));

test('satış listesi sayfalanır; her sayfa en fazla bir sayfa boyutu kadar satır basar',()=>{
 const liste=kayitlar(1255);
 const ilk=satisSayfasi(liste,1);
 assert.equal(ilk.rows.length,SATIS_SAYFA);
 assert.equal(ilk.rows[0].id,'S0');
 assert.equal(ilk.toplam,1255);
 assert.equal(ilk.sonSayfa,Math.ceil(1255/SATIS_SAYFA));
 const ikinci=satisSayfasi(liste,2);
 assert.equal(ikinci.rows[0].id,'S'+SATIS_SAYFA,'ikinci sayfa ilkinin devamından başlar');
 const son=satisSayfasi(liste,ilk.sonSayfa);
 assert.equal(son.rows.at(-1).id,'S1254','son kayıt son sayfada görünür');
 const tumu=new Set();
 for(let sayfa=1;sayfa<=ilk.sonSayfa;sayfa++)for(const kayit of satisSayfasi(liste,sayfa).rows)tumu.add(kayit.id);
 assert.equal(tumu.size,1255,'hiçbir kayıt kaybolmaz veya iki kez basılmaz');
});

test('sayfa numarası listenin dışına taşamaz; bozuk numara ilk sayfaya döner',()=>{
 const liste=kayitlar(120);
 const sonSayfa=satisSayfasi(liste,1).sonSayfa;
 assert.equal(satisSayfasi(liste,999).sayfa,sonSayfa,'liste kısaldığında sayfa sona çekilir');
 assert.ok(satisSayfasi(liste,999).rows.length>0,'taşan sayfada boş liste gösterilmez');
 for(const bozuk of [0,-3,null,undefined,NaN,'abc']){
  const sonuc=satisSayfasi(liste,bozuk);
  assert.equal(sonuc.sayfa,1,String(bozuk));
  assert.equal(sonuc.rows[0].id,'S0',String(bozuk));
 }
});

test('boş satış listesinde tek boş sayfa kalır, sayaç sıfır gösterir',()=>{
 const bos=satisSayfasi([],1);
 assert.deepEqual(bos.rows,[]);
 assert.equal(bos.toplam,0);
 assert.equal(bos.sonSayfa,1);
 assert.equal(bos.sayfa,1);
 assert.equal(satisSayfasi(undefined,1).toplam,0,'veri gelmemişse çökmez');
});

test('tam dolu son sayfadan sonra fazladan boş sayfa açılmaz',()=>{
 const liste=kayitlar(SATIS_SAYFA*3);
 const {sonSayfa}=satisSayfasi(liste,1);
 assert.equal(sonSayfa,3);
 assert.equal(satisSayfasi(liste,3).rows.length,SATIS_SAYFA);
});
