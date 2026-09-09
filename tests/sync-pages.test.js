import test from 'node:test';
import assert from 'node:assert/strict';
import {pullSourcePages} from '../public/sync-pages.js';
const response=(page,hasMore,extra={})=>({page,next_page:page+1,hasMore,records:[{}],orders:{created:1},warnings:[],...extra});
test('Paginated pull drains deferred drafts before advancing and counts each source page once',async()=>{
 const calls=[];let first=true;
 const r=await pullSourcePages({requestPage:async page=>{calls.push(page);if(first){first=false;return response(page,true,{deferredOrders:2,orders:{created:3}});}return response(page,page===0);}});
 assert.deepEqual(calls,[0,0,1]);assert.equal(r.status,'complete');assert.equal(r.records,2);assert.equal(r.pages,2);assert.equal(r.created,5);
});
test('A failing page remains resumable and does not claim the remaining scope was fetched',async()=>{
 const r=await pullSourcePages({requestPage:async page=>{if(page===1)throw Error('Erişim sınırı');return response(page,true);}});
 assert.equal(r.status,'error');assert.equal(r.page,1);assert.equal(r.pages,1);assert.equal(r.error,'Erişim sınırı');
 const resumed=await pullSourcePages({startPage:r.page,requestPage:async page=>response(page,false)});assert.equal(resumed.status,'complete');assert.equal(resumed.pages,1);
});
test('Pull stops for cancellation, malformed pagination, no progress or request budget',async()=>{
 const abort=new AbortController();let calls=0;
 let r=await pullSourcePages({signal:abort.signal,requestPage:async page=>{calls++;abort.abort();return response(page,true);}});assert.equal(r.status,'paused');assert.equal(calls,1);
 r=await pullSourcePages({requestPage:async page=>response(page+1,false)});assert.equal(r.status,'error');
 r=await pullSourcePages({requestPage:async page=>response(page,true,{deferredOrders:2,orders:{created:0}})});assert.equal(r.status,'error');assert.equal(r.page,0);
 r=await pullSourcePages({maxRequests:2,requestPage:async page=>response(page,true)});assert.equal(r.status,'paused');assert.equal(r.page,2);
 r=await pullSourcePages({requestPage:async page=>response(page,false,{orderImportWarning:'Taslak aktarımı eksik'})});assert.equal(r.status,'error');assert.equal(r.page,0);
});
