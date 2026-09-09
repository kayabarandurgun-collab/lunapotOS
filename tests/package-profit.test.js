import test from 'node:test';
import assert from 'node:assert/strict';
import {packageProfit} from '../src/package-profit.js';
const lines=[{id:'line'}],parts=[{line_id:'line',sale_id:'sale',revenue_share_bps:10000}],sale={id:'sale',kind:'sale',revenue_cents:10000,cost_cents:4000,commission_cents:1000,shipping_cents:500,other_cents:100,fees_status:'confirmed'};
test('Teslim edilmiş setin eksik bileşeni veya eksik kesintisi kesin kâr oluşturmaz',()=>{
 let x=packageProfit({status:'delivered'},lines,parts,[{...sale,shipping_cents:null}]);assert.equal(x.profit_cents,null);assert.equal(x.estimated_profit_cents,null);assert.equal(x.status,'pending');
 x=packageProfit({status:'delivered'},lines,[{...parts[0],revenue_share_bps:5000}],[sale]);assert.equal(x.status,'incomplete_records');assert.equal(x.profit_cents,null);
 x=packageProfit({status:'delivered'},[...lines,{id:'unlinked'}],parts,[sale]);assert.equal(x.status,'incomplete_records');assert.equal(x.estimated_profit_cents,null);
 x=packageProfit({status:'cancelled'},lines,parts,[sale]);assert.equal(x.profit_cents,null);assert.equal(x.estimated_profit_cents,null);
});
test('İade giderleri katkıdan düşer; doğrulanmamış kesinti ancak tahmin oluşturur',()=>{
 const returned={id:'return',kind:'return',parent_id:'sale',revenue_cents:-10000,cost_cents:-4000,commission_cents:-1000,shipping_cents:500,other_cents:0,fees_status:'confirmed'};
 let x=packageProfit({status:'delivered'},lines,parts,[sale,returned]);assert.equal(x.profit_cents,-1100);
 x=packageProfit({status:'shipped'},lines,parts,[sale,returned]);assert.equal(x.profit_cents,null);assert.equal(x.estimated_profit_cents,-1100);
 x=packageProfit({status:'delivered'},lines,parts,[{...sale,fees_status:'estimated'}]);assert.equal(x.status,'pending');assert.equal(x.profit_cents,null);assert.equal(x.estimated_profit_cents,4400);
});
