import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {appFixture} from './helpers/app-fixture.js';
test('release gate returns uncached 503 before every API, asset and scheduled write',async()=>{
 const forbidden=()=>{throw Error('Gate touched a backend');};
 const env={RELEASE_MAINTENANCE:'1',DB:{prepare:forbidden,batch:forbidden},ASSETS:{fetch:forbidden},AI:{run:forbidden}};
 for(const method of ['GET','POST','PUT','DELETE','OPTIONS'])for(const path of ['/api/ec/ledger/provisional','/api/lp/accounting','/api/auth/logout','/api/magaza/orders']){
  const r=await worker.fetch(new Request('https://lunapot.test'+path,{method}),env);
  assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'30');assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Set-Cookie'),null);assert.equal((await r.json()).maintenance,true);
 }
 for(const path of ['/','/eticaret/','/sw.js','/daily-actions.js','/magaza/']){
  const r=await worker.fetch(new Request('https://lunapot.test'+path),env);assert.equal(r.status,503);assert.match(r.headers.get('content-type'),/text\/html/);assert.match(await r.text(),/Güncelleme/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 }
 await worker.scheduled({},env,{waitUntil:forbidden});
});
test('disabled release gate keeps authenticated normal operations available',async()=>{
 const f=appFixture();f.env.RELEASE_MAINTENANCE='0';try{await f.setup();const r=await f.req('/auth/status');assert.equal(r.status,200);assert.equal(r.data.user.owner,true);}finally{f.close();}
});
