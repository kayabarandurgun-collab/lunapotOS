import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationGroups,workspaceNavigation} from '../public/workspace-navigation.js';
import {attentionItems} from '../public/attention-ui.js';
const titles=Object.fromEntries(['overview','orders','stock','performance','pricing','reports','catalog','invoices','documents','sales','reconciliation','ledger','bank','offers','expenses','integrations','settings'].map(k=>[k,k]));
test('navigation exposes assigned screens and aliases without empty groups or admin routes to staff',()=>{
 const user={ec_access:'read',lp_access:'none',permissions:{ec:{orders:'read',stock:'read',ledger:'read'}}};
 const groups=navigationGroups('ec',titles,user),links=groups.flatMap(g=>g.routes);
 assert.deepEqual(links,['overview','orders','stock','reports','ledger','bank']);
 assert.ok(groups.every(g=>g.routes.length));
 const markup=workspaceNavigation('ec',titles,'bank',user,()=>'<svg></svg>');
 assert.match(markup,/<details class="nav-group" open>/);assert.match(markup,/href="#bank" class="nav-link active" aria-current="page"/);
 assert.doesNotMatch(markup,/href="#settings"|href="#performance"/);
 assert.deepEqual(navigationGroups('ec',titles,null),[]);
});
test('owner keeps every existing commerce route reachable once through grouped navigation',()=>{
 const links=navigationGroups('ec',titles,{owner:true}).flatMap(g=>g.routes);
 assert.equal(new Set(links).size,links.length);assert.deepEqual([...links].sort(),Object.keys(titles).sort());
});
test('component allocation losses alone never trigger a product loss warning on the work list',()=>{
 const data={orders:{},stock:{total:10,no_history:0},invoices:{},sales:{losses:18,unconfirmed:0},tariffs:{shipping_active:1,commission_active:1,shipping_expiring:0,commission_expiring:0}};
 assert.deepEqual(attentionItems(data,{providers:[]},{tax_id:'1',legal_name:'Lunapot'}),[]);
});


import {canRoute} from '../public/permissions.js';
import {permit} from '../src/permission-policy.js';
test('production labels expose read routes but every write requires a write-capable module',()=>{
 for(const key of ['production','materialstock']){
  const reader={lp_access:'write',ec_access:'none',permissions:{lp:{[key]:'read'}}};
  for(const route of ['barcodes','lots']){
   assert.equal(canRoute(reader,'lp',route),true);assert.equal(canRoute(reader,'lp',route,true),false);
   assert.doesNotThrow(()=>permit(reader,'/api/lp/'+route,'GET'));
   assert.throws(()=>permit(reader,'/api/lp/'+route,'POST'),e=>e.status===403);
   const writer={...reader,permissions:{lp:{[key]:'write'}}};
   assert.equal(canRoute(writer,'lp',route,true),true);assert.doesNotThrow(()=>permit(writer,'/api/lp/'+route,'POST'));
  }
 }
 const recipeReader={lp_access:'read',permissions:{lp:{recipes:'read'}}};
 assert.equal(canRoute(recipeReader,'lp','barcodes'),true);
});
