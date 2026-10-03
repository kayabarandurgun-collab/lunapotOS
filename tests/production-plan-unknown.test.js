import test from 'node:test';
import assert from 'node:assert/strict';
import {productionPlan} from '../public/production-plan.js';
const input={recipe:{yield_qty:10,waste_pct:0},items:[{material_id:'a',quantity:2,unit:'kg'}],materials:[{id:'a',name:'Torf',unit:'kg'}],quantity:10};
test('explicitly unknown material stock cannot become zero stock or a numeric production capacity',()=>{
 for(const value of [null,undefined,NaN,Infinity]){
  const plan=productionPlan({...input,balances:{a:value}});
  assert.equal(plan.max_units,null);assert.equal(plan.rows[0].available_milli,null);assert.equal(plan.rows[0].missing_milli,null);assert.equal(plan.blocked,true);assert.match(plan.reason,/bilgi|bilinmiyor/i);
 }
});
test('a known zero and a material with no stock movement keep the existing zero convention',()=>{
 for(const balances of [{a:0},{}]){const plan=productionPlan({...input,balances});assert.equal(plan.max_units,0);assert.equal(plan.rows[0].missing_milli,2000);}
});
