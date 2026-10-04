import test from 'node:test';
import assert from 'node:assert/strict';
import {canRoute} from '../public/permissions.js';
import {permit} from '../src/permission-policy.js';
const staff=(permissions,ns='ec',access='write')=>({owner:false,ec_access:ns==='ec'?access:'none',lp_access:ns==='lp'?access:'none',permissions:{ec:{},lp:{},[ns]:{amounts:'none',...permissions}}});
const denied=(u,path,method='GET')=>assert.throws(()=>permit(u,path,method),e=>e.status===403);
test('new money views require full intersections; stock access cannot expose expenses or bank amounts',()=>{
 for(const ns of ['ec','lp']){
  const u=staff({ledger:'read',amounts:'read'},ns);assert.ok(canRoute(u,ns,'money'));assert.doesNotThrow(()=>permit(u,'/api/'+ns+'/money-calendar','GET'));denied(u,'/api/'+ns+'/money-calendar','POST');
  for(const p of [{ledger:'read'},{amounts:'read'},{stock:'write'}]){const v=staff(p,ns);assert.equal(canRoute(v,ns,'money'),false);denied(v,'/api/'+ns+'/money-calendar');}
 }
 const u=staff({performance:'read',expenses:'read',amounts:'read'});assert.ok(canRoute(u,'ec','business-result'));assert.doesNotThrow(()=>permit(u,'/api/ec/business-result','GET'));
 for(const key of ['performance','expenses','amounts']){const v=structuredClone(u);v.permissions.ec[key]='none';assert.equal(canRoute(v,'ec','business-result'),false);denied(v,'/api/ec/business-result');}
 denied(u,'/api/lp/business-result');denied(u,'/api/ec/business-result','POST');
});
test('profile/count routes inherit exact workspace rights and never create cross-workspace grants',()=>{
 for(const [ns,feature] of [['ec','stock'],['lp','accounts']]){
  const u=staff({[feature]:'read'},ns);assert.ok(canRoute(u,ns,'product'));assert.doesNotThrow(()=>permit(u,'/api/'+ns+'/product-profile/p1','GET'));denied(u,'/api/'+ns+'/product-profile/p1','POST');
  denied(u,'/api/'+(ns==='ec'?'lp':'ec')+'/product-profile/p1');
 }
 const reader=staff({stock:'read'});assert.ok(canRoute(reader,'ec','warehouse'));assert.equal(canRoute(reader,'ec','warehouse',true),false);denied(reader,'/api/ec/warehouse/sessions','POST');
 const writer=staff({stock:'write'});assert.doesNotThrow(()=>permit(writer,'/api/ec/warehouse/sessions','POST'));denied(writer,'/api/lp/warehouse/sessions','POST');
 const party=staff({ledger:'read'});assert.ok(canRoute(party,'ec','party'));assert.doesNotThrow(()=>permit(party,'/api/ec/party-profiles/s1','GET'));denied(party,'/api/ec/party-profiles/s1','POST');
});
test('intake requires a document writer plus amount visibility, and tasks respect read envelopes',()=>{
 for(const [ns,feature] of [['ec','invoices'],['ec','orders'],['lp','accounts']]){
  assert.ok(canRoute(staff({[feature]:'write',amounts:'read'},ns),ns,'intake'));
  assert.equal(canRoute(staff({[feature]:'write'},ns),ns,'intake'),false);
  assert.equal(canRoute(staff({[feature]:'write',amounts:'read'},ns,'read'),ns,'intake'),false);
 }
 const reader=staff({stock:'read'});assert.ok(canRoute(reader,'ec','workbench'));assert.equal(canRoute(reader,'ec','workbench',true),false);assert.doesNotThrow(()=>permit(reader,'/api/ec/workbench','GET'));denied(reader,'/api/ec/workbench/tasks','POST');
 const amounts=staff({amounts:'write'});assert.equal(canRoute(amounts,'ec','workbench'),false);denied(amounts,'/api/ec/workbench');
 denied(staff({stock:'write'}),'/api/workbench');denied(staff({stock:'write'}),'/api/ec/unknown-new-feature');
});
