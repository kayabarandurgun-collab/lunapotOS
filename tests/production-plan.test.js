import test from 'node:test';
import assert from 'node:assert/strict';
import {productionPlan} from '../public/production-plan.js';

const recipe={yield_qty:10,waste_pct:0};
const materials=[{id:'resin',name:'Reçine',unit:'kg'},{id:'pigment',name:'Pigment',unit:'g'}];

test('Planlama gereken, eldeki ve eksik miktarı hedef adede göre verir',()=>{
 const plan=productionPlan({recipe,items:[{material_id:'resin',quantity:2,unit:'kg'}],
  materials,balances:{resin:5000},quantity:20});
 assert.equal(plan.rows.length,1);
 assert.equal(plan.rows[0].needed_milli,4000,'10 adet için 2 kg ise 20 adet için 4 kg');
 assert.equal(plan.rows[0].available_milli,5000);
 assert.equal(plan.rows[0].missing_milli,0);
 assert.equal(plan.blocked,false);
 assert.equal(plan.max_units,25,'5 kg ile 25 adet yapılır');
});

test('Eksik hammadde bildirilir ve üretilebilir adet en dar hammaddeye göre bulunur',()=>{
 const plan=productionPlan({recipe,
  items:[{material_id:'resin',quantity:2,unit:'kg'},{material_id:'pigment',quantity:100,unit:'g'}],
  materials,balances:{resin:5000,pigment:300000},quantity:20});
 const pigment=plan.rows.find(r=>r.material_id==='pigment');
 assert.equal(pigment.needed_milli,200000,'20 adet için 200 g');
 assert.equal(pigment.available_milli,300000);
 assert.equal(pigment.missing_milli,0);
 assert.equal(plan.max_units,25,'reçine 25, pigment 30 adete yeter; en düşüğü geçerli');

 const tight=productionPlan({recipe,
  items:[{material_id:'resin',quantity:2,unit:'kg'},{material_id:'pigment',quantity:100,unit:'g'}],
  materials,balances:{resin:5000,pigment:150000},quantity:20});
 assert.equal(tight.rows[0].material_id,'pigment','eksik olan başa gelir');
 assert.equal(tight.rows[0].missing_milli,50000);
 assert.equal(tight.blocked,true);
 assert.equal(tight.max_units,15,'150 g ile 15 adet');
});

test('Birim dönüşümü reçete birimi ile stok birimi farklıyken doğru çalışır',()=>{
 const plan=productionPlan({recipe,items:[{material_id:'pigment',quantity:0.2,unit:'kg'}],
  materials,balances:{pigment:400000},quantity:10});
 assert.equal(plan.rows[0].unit,'g');
 assert.equal(plan.rows[0].needed_milli,200000,'0,2 kg = 200 g, 10 adet için 200 g');
 assert.equal(plan.max_units,20);
});

test('Fire oranı ve reçete verimi tüketime yansır',()=>{
 const plan=productionPlan({recipe:{yield_qty:10,waste_pct:10},
  items:[{material_id:'resin',quantity:2,unit:'kg'}],materials,balances:{resin:11000},quantity:10});
 assert.equal(plan.rows[0].needed_milli,2200,'%10 fire ile 2,2 kg');
 assert.equal(plan.max_units,50,'11 kg / 0,22 kg = 50 adet');
});

test('Aynı hammaddenin tekrarlı reçete satırları toplanır',()=>{
 const plan=productionPlan({recipe,
  items:[{material_id:'resin',quantity:2,unit:'kg'},{material_id:'resin',quantity:500,unit:'g'}],
  materials,balances:{resin:5000},quantity:10});
 assert.equal(plan.rows.length,1,'tek satırda birleşmeli');
 assert.equal(plan.rows[0].needed_milli,2500,'2 kg + 500 g = 2,5 kg');
 assert.equal(plan.max_units,20);
});

test('Stok yoksa üretilebilir adet sıfırdır ve eksik bildirilir',()=>{
 const plan=productionPlan({recipe,items:[{material_id:'resin',quantity:2,unit:'kg'}],
  materials,balances:{},quantity:10});
 assert.equal(plan.max_units,0);
 assert.equal(plan.rows[0].missing_milli,2000);
 assert.equal(plan.blocked,true);
});

test('Reçete yoksa veya hammadde satırı yoksa planlama güvenli davranır',()=>{
 assert.equal(productionPlan({recipe:null,items:[],materials,balances:{},quantity:5}).blocked,true);
 const empty=productionPlan({recipe,items:[],materials,balances:{},quantity:5});
 assert.deepEqual(empty.rows,[]);
 assert.equal(empty.max_units,0);
 assert.match(empty.reason,/hammadde satırı yok/);
});
