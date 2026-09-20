import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import worker from '../src/worker.js';
import {hash} from '../src/access-api.js';
import {revokeTrustedDevices} from '../src/quick-access.js';
const PASSWORD='synthetic-owner-password',PIN='001234',origin='https://lunapot.test';
async function fixture(){const f=appFixture();await f.setup();const owner=(await f.req('/auth/login',{password:PASSWORD},'')).cookie;
 const send=async(path,{body,cookie='',ip='synthetic-ip',method=body===undefined?'GET':'POST',originHeader=origin}={})=>{const headers={'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':ip};if(originHeader!==null)headers.Origin=originHeader;const r=await worker.fetch(new Request(origin+'/api'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);return {status:r.status,data:await r.json(),headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const enroll=(extra={})=>send('/auth/quick/enroll',{cookie:owner,body:{label:'Sentetik cihaz',pin:PIN,current_password:PASSWORD},...extra});return {...f,owner,send,enroll};}

test('enrollment requires authenticated reauth, HTTPS, exact six digit strings; independent secret hashes and restricted cookie',async()=>{
 const f=await fixture();try{
  assert.equal((await f.enroll({cookie:''})).status,401);
  assert.equal((await f.enroll({body:{label:'Test',pin:PIN,current_password:'wrong-password'}})).status,401);
  for(const pin of [123456,'12345','1234567','１２３４５６','abcdef'])assert.equal((await f.enroll({body:{label:'Test',pin,current_password:PASSWORD}})).status,400);
  assert.deepEqual((await f.send('/auth/quick/status')).data,{available:false});
  const a=await f.enroll(),b=await f.enroll();assert.equal(a.status,200);assert.equal(b.status,200);
  assert.match(a.headers.get('set-cookie'),/^__Host-lunapot_device=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  assert.equal(a.headers.get('cache-control'),'no-store');assert.equal(a.data.expires_at>Math.floor(Date.now()/1000),true);
  const rows=f.sqlite.prepare('SELECT * FROM trusted_devices').all();assert.equal(rows.length,2);assert.notEqual(rows[0].pin_hash,rows[1].pin_hash);assert.notEqual(rows[0].pin_salt,rows[1].pin_salt);
  assert.equal(rows[0].token_hash,await hash(a.cookie.split('=')[1]));assert.equal(rows[0].pin_hash.length,64);
  const list=await f.send('/auth/quick/devices',{cookie:f.owner+'; '+a.cookie});assert.equal(list.status,200);assert.equal(list.data.devices.filter(x=>x.current).length,1);
  for(const data of [a.data,list.data,(await f.send('/auth/quick/status',{cookie:a.cookie})).data])assert.doesNotMatch(JSON.stringify(data),/pin_hash|pin_salt|password_hash|token_hash|001234|synthetic-owner-password/);
  assert.doesNotMatch(JSON.stringify(f.sqlite.prepare('SELECT * FROM access_audit').all()),/001234|synthetic-owner-password/);
  const r=await worker.fetch(new Request('http://lunapot.test/api/auth/quick/enroll',{method:'POST',headers:{Origin:'http://lunapot.test',Cookie:f.owner,'Content-Type':'application/json'},body:JSON.stringify({label:'HTTP',pin:PIN,current_password:PASSWORD})}),f.env);assert.equal(r.status,400);
 }finally{f.close();}
});

test('trusted cookie plus explicit PIN creates normal session; status and logout never silently log in',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie;
  const missing=await f.send('/auth/quick/login',{body:{pin:PIN}}),bad=await f.send('/auth/quick/login',{cookie:device,body:{pin:'999999'}});assert.equal(missing.status,401);assert.deepEqual(missing.data,bad.data);
  assert.deepEqual((await f.send('/auth/quick/status',{cookie:device})).data,{available:true});
  assert.equal((await f.send('/auth/status',{cookie:device})).data.authenticated,false);
  const good=await f.send('/auth/quick/login',{cookie:device,body:{pin:PIN,username:'missing.staff'}});assert.equal(good.status,200);assert.ok(good.cookie);assert.deepEqual(good.data,{ok:true});
  assert.equal((await f.send('/auth/status',{cookie:good.cookie})).data.user.owner,true);
  assert.equal((await f.send('/auth/logout',{cookie:good.cookie+'; '+device,body:{}})).status,200);
  assert.equal((await f.send('/auth/status',{cookie:good.cookie+'; '+device})).data.authenticated,false);
  assert.deepEqual((await f.send('/auth/quick/status',{cookie:device})).data,{available:true});
  assert.equal((await f.send('/auth/quick/login',{cookie:device,body:{pin:PIN}})).status,200);
 }finally{f.close();}
});

test('all new auth mutations preserve Origin/JSON guards and route/method exactness',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie;
  for(const path of ['/auth/quick/enroll','/auth/quick/login','/auth/quick/forget','/auth/quick/revoke','/auth/password'])for(const originHeader of [null,'https://attacker.test'])assert.equal((await f.send(path,{cookie:f.owner+'; '+device,body:{pin:PIN},originHeader})).status,403,path);
  for(const path of ['/auth/quick/enroll','/auth/quick/login','/auth/quick/forget','/auth/quick/revoke'])assert.equal((await f.send(path,{cookie:f.owner})).status,404,path);
  for(const path of ['/auth/quick/status/extra','/auth/password/extra','/admin/users/extra/extra'])assert.equal((await f.send(path,{cookie:f.owner})).status,404,path);
  const r=await worker.fetch(new Request(origin+'/api/auth/quick/login',{method:'POST',headers:{Origin:origin,Cookie:device,'Content-Type':'text/plain'},body:'{}'}),f.env);assert.equal(r.status,415);
 }finally{f.close();}
});

test('parallel wrong PIN attempts reserve device budget atomically across different IPs, with bounded reset',async()=>{
 const f=await fixture();try{
  const cookie=(await f.enroll()).cookie;
  const all=await Promise.all(Array.from({length:18},(_,i)=>f.send('/auth/quick/login',{cookie,ip:'ip-'+i,body:{pin:'999999'}})));
  assert.equal(all.filter(r=>r.status===401).length,5);assert.equal(all.filter(r=>r.status===429).length,13);
  assert.equal((await f.send('/auth/quick/login',{cookie,ip:'fresh-ip',body:{pin:PIN}})).status,429);
  const id=f.sqlite.prepare('SELECT id FROM trusted_devices').get().id,key=await hash('quick-device:'+id),window=f.sqlite.prepare('SELECT * FROM login_limits WHERE key=?').get(key);
  assert.equal(window.attempts,6);const reset=window.reset_at;
  await f.send('/auth/quick/login',{cookie,ip:'another-ip',body:{pin:PIN}});assert.equal(f.sqlite.prepare('SELECT reset_at FROM login_limits WHERE key=?').get(key).reset_at,reset);
  f.sqlite.prepare('UPDATE login_limits SET reset_at=0 WHERE key=?').run(key);
  assert.equal((await f.send('/auth/quick/login',{cookie,body:{pin:PIN}})).status,200);
 }finally{f.close();}
});

test('parallel successful attempts cannot clear device budget or open unlimited sessions',async()=>{
 const f=await fixture();try{const cookie=(await f.enroll()).cookie;
  const all=await Promise.all(Array.from({length:14},(_,i)=>f.send('/auth/quick/login',{cookie,ip:'ip-'+i,body:{pin:PIN}})));
  assert.equal(all.filter(r=>r.status===200).length,5);assert.equal(all.filter(r=>r.status===429).length,9);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sessions WHERE trusted_device_id IS NOT NULL').get().n,5);
 }finally{f.close();}
});

test('IP budget is independent of cookie/device identity and primary password remains reachable',async()=>{
 const f=await fixture();try{const cookie=(await f.enroll()).cookie;
  const all=await Promise.all(Array.from({length:30},()=>f.send('/auth/quick/login',{body:{pin:'999999'}})));assert.ok(all.every(r=>r.status===401));
  assert.equal((await f.send('/auth/quick/login',{cookie,body:{pin:PIN}})).status,429);
  assert.equal((await f.send('/auth/quick/login',{cookie,ip:'fresh',body:{pin:PIN}})).status,200);
  assert.equal((await f.send('/auth/login',{body:{password:PASSWORD}})).status,200);
 }finally{f.close();}
});

test('device expiration, unknown cookies, version mismatch, explicit forget and revoke are enforced',async()=>{
 const f=await fixture();try{
  const a=await f.enroll();f.sqlite.prepare('UPDATE trusted_devices SET created_at=1,expires_at=2').run();
  assert.deepEqual((await f.send('/auth/quick/status',{cookie:a.cookie})).data,{available:false});assert.equal((await f.send('/auth/quick/login',{cookie:a.cookie,body:{pin:PIN}})).status,401);
  assert.deepEqual((await f.send('/auth/quick/status',{cookie:'__Host-lunapot_device='+'a'.repeat(64)})).data,{available:false});
  const b=await f.enroll();f.sqlite.prepare("UPDATE trusted_devices SET password_version='old-version'").run();assert.equal((await f.send('/auth/quick/login',{cookie:b.cookie,body:{pin:PIN}})).status,401);
  const c=await f.enroll(),session=await f.send('/auth/quick/login',{cookie:c.cookie,body:{pin:PIN}});assert.equal(session.status,200);
  const forget=await f.send('/auth/quick/forget',{cookie:c.cookie,body:{}});assert.equal(forget.status,200);assert.match(forget.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await f.send('/auth/status',{cookie:session.cookie})).data.authenticated,false);
  assert.equal((await f.send('/auth/quick/login',{cookie:c.cookie,body:{pin:PIN}})).status,401);
  const d=await f.enroll();const id=f.sqlite.prepare('SELECT id FROM trusted_devices WHERE token_hash=?').get(await hash(d.cookie.split('=')[1])).id;
  assert.equal((await f.send('/auth/quick/revoke',{cookie:f.owner,body:{id}})).status,200);assert.equal((await f.send('/auth/quick/login',{cookie:d.cookie,body:{pin:PIN}})).status,401);
 }finally{f.close();}
});

test('owner password update and direct credential recovery revoke every grant and old session',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie;
  const change=await f.send('/auth/password',{cookie:f.owner,body:{current_password:PASSWORD,password:'synthetic-changed-password'}});assert.equal(change.status,200);assert.ok(change.cookie);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM trusted_devices').get().n,0);assert.equal((await f.send('/auth/quick/login',{cookie:device,body:{pin:PIN}})).status,401);
  const enrolled=await f.enroll({cookie:change.cookie,body:{label:'Recovered',current_password:'synthetic-changed-password',pin:PIN}});assert.equal(enrolled.status,200);
  f.sqlite.prepare("UPDATE admin SET salt='synthetic-recovery-version'").run();
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM trusted_devices').get().n,0);assert.equal((await f.send('/auth/status',{cookie:change.cookie})).data.authenticated,false);
 }finally{f.close();}
});

test('post-Time-Travel recovery revocation hook clears restored sessions and device grants',async()=>{
 const f=await fixture();try{const d=await f.enroll();await f.send('/auth/quick/login',{cookie:d.cookie,body:{pin:PIN}});await revokeTrustedDevices(f.env.DB);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM trusted_devices').get().n,0);
  assert.equal((await f.send('/auth/quick/login',{cookie:d.cookie,body:{pin:PIN}})).status,401);
 }finally{f.close();}
});

test('revocation during PIN derivation cannot mint a session from a stale grant',async()=>{
 const f=await fixture();try{
  const cookie=(await f.enroll()).cookie,prepare=f.env.DB.prepare.bind(f.env.DB);let revoked=false;
  f.env.DB.prepare=sql=>{if(sql.startsWith('INSERT INTO sessions(token_hash,expires_at,staff_id,trusted_device_id)')){f.sqlite.exec('DELETE FROM trusted_devices');revoked=true;}return prepare(sql);};
  const r=await f.send('/auth/quick/login',{cookie,body:{pin:PIN}});assert.equal(revoked,true);assert.equal(r.status,401);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sessions WHERE trusted_device_id IS NOT NULL').get().n,0);
 }finally{f.close();}
});

test('reauthentication attempts are account scoped, atomic, bounded and do not enable a PIN on failure',async()=>{
 const f=await fixture();try{
  const all=await Promise.all(Array.from({length:15},(_,i)=>f.enroll({ip:'reauth-'+i,body:{label:'Test',pin:PIN,current_password:'incorrect-primary'}})));
  assert.equal(all.filter(x=>x.status===401).length,10);assert.equal(all.filter(x=>x.status===429).length,5);
  assert.equal((await f.enroll()).status,429);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM trusted_devices').get().n,0);
 }finally{f.close();}
});
