import test from 'node:test';
import assert from 'node:assert/strict';
import {can,routeKey} from '../public/permissions.js';
import {permit} from '../src/permission-policy.js';
test('report and bank navigation use the same existing permissions as their API, without granting writes',()=>{
 for(const [route,feature,path] of [['reports','orders','/api/ec/reports'],['bank','ledger','/api/ec/statement/accounts']]){
  const reader={owner:false,ec_access:'read',lp_access:'none',permissions:{ec:{[feature]:'read'},lp:{}}};
  assert.equal(routeKey('ec',route),feature);
  assert.equal(can(reader,'ec',routeKey('ec',route)),true);
  assert.equal(can(reader,'ec',routeKey('ec',route),true),false);
  assert.doesNotThrow(()=>permit(reader,path,'GET'));
  assert.throws(()=>permit(reader,path,'POST'),e=>e.status===403);
  const unrelated={...reader,permissions:{ec:{stock:'write'},lp:{}}};
  assert.equal(can(unrelated,'ec',routeKey('ec',route)),false);
  assert.throws(()=>permit(unrelated,path,'GET'),e=>e.status===403);
 }
 assert.equal(routeKey('lp','reports'),'reports');
});
