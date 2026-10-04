import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyTasks,dailyTaskMarkup} from '../public/daily-actions.js';
import {navigationGroups} from '../public/workspace-navigation.js';
test('daily tasks distinguish reads from writes and respect workspace envelope',()=>{
 assert.deepEqual(dailyTasks(null),[]);
 assert.deepEqual(dailyTasks({ec_access:'none',permissions:{ec:{stock:'write'}}}),[]);
 assert.deepEqual(dailyTasks({ec_access:'read',permissions:{ec:{orders:'write',invoices:'write',stock:'write'}}}).map(t=>t.id),['warehouse']);
 const stock={ec_access:'write',lp_access:'none',permissions:{ec:{stock:'write'}}};
 assert.deepEqual(dailyTasks(stock).map(t=>t.id),['warehouse','count']);
 assert.deepEqual(dailyTasks({...stock,permissions:{ec:{stock:'read',ledger:'write'}}}).map(t=>t.id),['warehouse','unbilled']);assert.deepEqual(dailyTasks(stock,'lp'),[]);
 const owner=dailyTasks({owner:true});assert.equal(owner.length,4);assert.equal(owner.find(t=>t.id==='unbilled').href,'#stock?action=unbilled');
 assert.ok(dailyTasks({owner:true},'lp').every(t=>!t.href.startsWith('#stock')));
});
test('daily links remain unique, escaped, and usable from the application launcher',()=>{
 const markup=dailyTaskMarkup(dailyTasks({owner:true}),{prefix:'/eticaret/'});
 assert.ok(markup.includes('href="/eticaret/#intake"'));assert.ok(markup.includes('href="/eticaret/#warehouse"'));
 assert.ok(markup.includes('href="/eticaret/#stock?action=unbilled"'));
 const escaped=dailyTaskMarkup([{id:'<',title:'<img>',detail:'<script>',href:'#x',words:'"',icon:'stock'}]);assert.doesNotMatch(escaped,/<img>|<script>/);
});
test('one document intake and daily work are directly visible; all existing screens remain accessible once',()=>{
 const routes=['intake','workbench','warehouse','money','business-result','overview','orders','stock','performance','pricing','reports','catalog','invoices','documents','sales','reconciliation','ledger','bank','offers','expenses','integrations','settings'];
 const groups=navigationGroups('ec',Object.fromEntries(routes.map(k=>[k,k])),{owner:true});
 for(const key of ['intake','workbench','stock'])assert.ok(groups.find(g=>g.key==='daily').routes.includes(key));
 const all=groups.flatMap(g=>g.routes);assert.equal(new Set(all).size,all.length);assert.deepEqual(all.slice().sort(),routes.slice().sort());
});
