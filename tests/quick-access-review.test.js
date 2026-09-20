import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import worker from '../src/worker.js';
import {hash,passwordHash} from '../src/access-api.js';
import {planRecovery,applyRecovery} from '../scripts/recovery.mjs';

// Security sidecar: synthetic memory databases only; no server, Wrangler or live calls.
const PASSWORD='synthetic-owner-password', PIN='001234', origin='https://lunapot.test';
async function fixture(){
 const f=appFixture();await f.setup();
 const owner=(await f.req('/auth/login',{password:PASSWORD},'')).cookie;
 const send=async(path,{body,cookie='',ip='review-ip',method=body===undefined?'GET':'POST',originHeader=origin}={})=>{
  const headers={'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':ip};if(originHeader!==null)headers.Origin=originHeader;
  const r=await worker.fetch(new Request(origin+'/api'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);
  return {status:r.status,data:await r.json(),headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};
 };
 const enroll=(cookie=owner,pin=PIN,password=PASSWORD)=>send('/auth/quick/enroll',{cookie,body:{label:'Synthetic review device',pin,current_password:password}});
 async function staff(username='review.staff'){
  const created=await send('/admin/users',{cookie:owner,body:{username,name:'Synthetic staff',ec_access:'read',lp_access:'none'}});assert.equal(created.status,200);
  const password='synthetic-staff-password';const accepted=await send('/auth/accept-invite',{body:{token:created.data.invite_path.split('=')[1],password}});assert.equal(accepted.status,200);
  const login=await send('/auth/login',{body:{username,password}});assert.equal(login.status,200);return {id:created.data.id,cookie:login.cookie,password,username};
 }
 return {...f,owner,send,enroll,staff};
}

test('review: old primary password login must not create a session after concurrent credential reset',async()=>{
 const f=await fixture();try{
  const newSalt='synthetic-review-new-version',newHash=await passwordHash('synthetic-reset-password',newSalt);
  const prepare=f.env.DB.prepare.bind(f.env.DB);let reset=false;
  f.env.DB.prepare=sql=>{
   if(!reset&&sql.startsWith('INSERT INTO sessions')){reset=true;f.sqlite.prepare('UPDATE admin SET salt=?,password_hash=? WHERE id=1').run(newSalt,newHash);}
   return prepare(sql);
  };
  const result=await f.send('/auth/login',{body:{password:PASSWORD}});assert.equal(reset,true);
  const valid=result.cookie?(await f.send('/auth/status',{cookie:result.cookie})).data.authenticated:false;
  assert.equal(valid,false,'An old-password request minted an authenticated owner session after reset completed');
  assert.equal(result.status,401);
 }finally{f.close();}
});

test('review: replacing the current PIN grant from its own PIN session must succeed atomically',async()=>{
 const f=await fixture();try{
  const first=await f.enroll();assert.equal(first.status,200);
  const login=await f.send('/auth/quick/login',{cookie:first.cookie,body:{pin:PIN}});assert.equal(login.status,200);
  const other=await f.send('/auth/quick/login',{cookie:first.cookie,body:{pin:PIN}});assert.equal(other.status,200);
  // Fill all ten slots without spending reauthentication budget. All rows are synthetic.
  for(let i=1;i<=9;i++)f.sqlite.prepare('INSERT INTO trusted_devices(id,token_hash,staff_id,password_version,pin_salt,pin_hash,label,created_at,expires_at) SELECT ?,?,staff_id,password_version,pin_salt,pin_hash,label,created_at,expires_at FROM trusted_devices LIMIT 1').run('cap-'+i,'f'.repeat(63)+i);
  const replacement=await f.enroll(login.cookie+'; '+first.cookie,'998877');
  assert.equal(replacement.status,200,'Replacing at ten-device capacity must preserve the reauthenticated caller');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM trusted_devices').get().n,10);
  assert.equal((await f.send('/auth/status',{cookie:login.cookie})).data.authenticated,true);
  assert.equal((await f.send('/auth/status',{cookie:other.cookie})).data.authenticated,false);
  assert.equal((await f.send('/auth/quick/login',{cookie:replacement.cookie,body:{pin:'998877'}})).status,200);
  assert.equal((await f.send('/auth/quick/login',{cookie:first.cookie,body:{pin:PIN}})).status,401);
  await f.send('/auth/quick/forget',{cookie:replacement.cookie,body:{}});
  assert.equal((await f.send('/auth/status',{cookie:login.cookie})).data.authenticated,false,'Transferred session must remain revocable through its replacement grant');
 }finally{f.close();}
});

test('review: Time Travel orchestration invalidates grants and sessions restored from a revoked snapshot',async()=>{
 const f=await fixture();try{
  const enrolled=await f.enroll();const grant=f.sqlite.prepare('SELECT * FROM trusted_devices').get();
  const quick=await f.send('/auth/quick/login',{cookie:enrolled.cookie,body:{pin:PIN}});
  const savedSession=f.sqlite.prepare('SELECT * FROM sessions WHERE trusted_device_id=?').get(grant.id);
  f.sqlite.exec('DELETE FROM trusted_devices');
  const safety='a'.repeat(40),target='b'.repeat(40),time=Date.parse('2026-09-20T12:00:00Z');let restored=false;
  const run=async(args)=>{
   if(args[1]==='time-travel'&&args[2]==='info')return {bookmark:args.includes('--timestamp')?target:safety};
   if(args[1]==='time-travel'&&args[2]==='restore'){
    restored=true;
    for(const [table,row] of [['trusted_devices',grant],['sessions',savedSession]]){
     const keys=Object.keys(row);f.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
    }
    return {success:true,bookmark:target,previous_bookmark:safety};
   }
   if(args[1]==='execute'){
    const command=args[args.indexOf('--command')+1]||'';
    return command.split(';').filter(sql=>sql.trim()).map(sql=>{
     if(/^\s*SELECT/i.test(sql))return {success:true,results:f.sqlite.prepare(sql).all()};
     f.sqlite.exec(sql);return {success:true,results:[]};
    });
   }
   throw Error('Unexpected synthetic recovery command: '+args.join(' '));
  };
  const plan=await planRecovery(run,'2026-09-20T11:00:00Z',time);await applyRecovery(run,plan,target,time);assert.equal(restored,true);
  assert.equal((await f.send('/auth/quick/status',{cookie:enrolled.cookie})).data.available,false,'Revoked device grant became valid after the real recovery orchestrator returned');
  assert.equal((await f.send('/auth/status',{cookie:quick.cookie})).data.authenticated,false);
 }finally{f.close();}
});

test('review: enrollment cannot survive concurrent session revocation',async()=>{
 const f=await fixture();try{
  const batch=f.env.DB.batch.bind(f.env.DB);let removed=false;
  f.env.DB.batch=items=>{if(!removed){removed=true;f.sqlite.exec('DELETE FROM sessions');}return batch(items);};
  const result=await f.enroll();assert.equal(removed,true);assert.ok([401,409].includes(result.status));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM trusted_devices').get().n,0);
 }finally{f.close();}
});

test('review: mixed account device cannot switch sessions, reveal identity, or be revoked by another account',async()=>{
 const f=await fixture();try{
  const staff=await f.staff(),device=await f.enroll();assert.equal(device.status,200);
  assert.deepEqual((await f.send('/auth/quick/status',{cookie:device.cookie})).data,{available:true});
  const mixed=staff.cookie+'; '+device.cookie;
  assert.equal((await f.send('/auth/quick/login',{cookie:mixed,body:{pin:PIN}})).status,401);
  assert.equal((await f.enroll(mixed,PIN,staff.password)).status,401);
  assert.deepEqual((await f.send('/auth/quick/devices',{cookie:mixed})).data,{devices:[]});
  const id=f.sqlite.prepare('SELECT id FROM trusted_devices').get().id;
  assert.equal((await f.send('/auth/quick/revoke',{cookie:staff.cookie,body:{id}})).status,200);
  assert.equal((await f.send('/auth/quick/login',{cookie:device.cookie,body:{pin:PIN}})).status,200);
 }finally{f.close();}
});

test('review: quick staff session reflects revoked roles and deactivation immediately',async()=>{
 const f=await fixture();try{
  const staff=await f.staff();const device=await f.enroll(staff.cookie,PIN,staff.password);assert.equal(device.status,200);
  const login=await f.send('/auth/quick/login',{cookie:device.cookie,body:{pin:PIN}});assert.equal(login.status,200);
  f.sqlite.prepare("UPDATE staff_users SET ec_access='none',lp_access='none',permissions_json=NULL WHERE id=?").run(staff.id);
  assert.equal((await f.send('/ec/catalog/products',{cookie:login.cookie})).status,401);
  const fresh=await f.send('/auth/quick/login',{cookie:device.cookie,body:{pin:PIN}});assert.equal(fresh.status,200);
  const status=await f.send('/auth/status',{cookie:fresh.cookie});assert.equal(status.data.user.ec_access,'none');
  assert.equal((await f.send('/ec/catalog/products',{cookie:fresh.cookie})).status,403);
  assert.equal((await f.send('/auth/quick/devices',{cookie:fresh.cookie})).status,200);
  f.sqlite.prepare('UPDATE staff_users SET active=0 WHERE id=?').run(staff.id);
  assert.equal((await f.send('/auth/status',{cookie:login.cookie})).data.authenticated,false);
  f.sqlite.prepare('UPDATE staff_users SET active=1 WHERE id=?').run(staff.id);
  assert.equal((await f.send('/auth/quick/login',{cookie:device.cookie,body:{pin:PIN}})).status,401);
 }finally{f.close();}
});

test('review: self password endpoint preserves primary length, account isolation, Origin and security headers',async()=>{
 const f=await fixture();try{
  const staff=await f.staff(),adminBefore=f.sqlite.prepare('SELECT password_hash FROM admin').get().password_hash;
  f.sqlite.prepare("UPDATE staff_users SET ec_access='none',lp_access='none',permissions_json=NULL WHERE id=?").run(staff.id);
  staff.cookie=(await f.send('/auth/login',{body:{username:staff.username,password:staff.password}})).cookie;
  for(const originHeader of [null,'https://attacker.test'])assert.equal((await f.send('/auth/password',{cookie:staff.cookie,originHeader,body:{current_password:staff.password,password:'synthetic-replacement'}})).status,403);
  const short=await f.send('/auth/password',{cookie:staff.cookie,body:{current_password:staff.password,password:'123456'}});assert.equal(short.status,400);
  const changed=await f.send('/auth/password',{cookie:staff.cookie,body:{id:'owner',staff_id:null,current_password:staff.password,password:'synthetic-replacement'}});assert.equal(changed.status,200);
  assert.equal(f.sqlite.prepare('SELECT password_hash FROM admin').get().password_hash,adminBefore);
  assert.equal((await f.send('/auth/status',{cookie:changed.cookie})).data.user.id,staff.id);
  assert.equal((await f.send('/auth/status',{cookie:staff.cookie})).data.authenticated,false);
  assert.equal((await f.send('/admin/users',{cookie:changed.cookie})).status,403);
  for(const response of [short,changed,await f.send('/auth/quick/status'),await f.send('/auth/quick/login',{body:{pin:PIN}})]){
   assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-frame-options'),'DENY');
   assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.ok(response.headers.get('strict-transport-security'));
   assert.doesNotMatch(JSON.stringify(response.data),/token_hash|password_hash|pin_hash|pin_salt|synthetic-owner-password|001234/);
  }
 }finally{f.close();}
});

test('review: business exports exclude credentials, grants, sessions and keep query/table budgets',async()=>{
 const f=await fixture();try{
  await f.enroll();const prepare=f.env.DB.prepare.bind(f.env.DB);let queries=0;f.env.DB.prepare=sql=>{queries++;return prepare(sql);};
  for(const ns of ['ec','lp']){
   queries=0;const result=await f.send('/'+ns+'/settings/backup',{cookie:f.owner});assert.equal(result.status,200,ns+' export must remain available');
   assert.ok(Object.keys(result.data.tables).length<=40);assert.ok(queries<45,'export queries: '+queries);
   assert.ok(!Object.keys(result.data.tables).some(n=>/trusted_devices|sessions|admin|staff_users|login_limits|connections/.test(n)));
   assert.doesNotMatch(JSON.stringify(result.data),/pin_hash|pin_salt|password_hash|token_hash/);
  }
 }finally{f.close();}
});

test('review: primary staff login rechecks password reset and deactivation at mint',async()=>{
 for(const action of ['reset','deactivate']){
  const f=await fixture();try{
   const staff=await f.staff(),salt='synthetic-race-version',next=await passwordHash('synthetic-recovery-password',salt),prepare=f.env.DB.prepare.bind(f.env.DB);let changed=false;
   f.env.DB.prepare=sql=>{
    if(!changed&&sql.startsWith('INSERT INTO sessions')){
     changed=true;if(action==='reset')f.sqlite.prepare('UPDATE staff_users SET salt=?,password_hash=? WHERE id=?').run(salt,next,staff.id);
     else f.sqlite.prepare('UPDATE staff_users SET active=0 WHERE id=?').run(staff.id);
    }return prepare(sql);
   };
   const result=await f.send('/auth/login',{body:{username:staff.username,password:staff.password}});assert.equal(changed,true);assert.equal(result.status,401,action);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sessions WHERE staff_id=?').get(staff.id).n,0,action);
  }finally{f.close();}
 }
});

test('review: recovery fails closed for cancelled restore or cleanup failure and supports pre-device schema',async()=>{
 const safety='a'.repeat(40),target='b'.repeat(40),time=Date.parse('2026-09-20T12:00:00Z');
 for(const mode of ['cancelled','cleanup-failed','old-schema','count-nonzero']){
  const commands=[];const run=async args=>{
   if(args[1]==='time-travel'&&args[2]==='info')return {bookmark:args.includes('--timestamp')?target:safety};
   if(args[1]==='time-travel'&&args[2]==='restore')return mode==='cancelled'?{}:{bookmark:target,previous_bookmark:safety};
   if(args[1]==='execute'){
    const sql=args[args.indexOf('--command')+1];commands.push(sql);
    if(sql.includes('sqlite_master'))return [{success:true,results:[{name:'sessions'},...(mode==='old-schema'?[]:[{name:'trusted_devices'}])]}];
    if(sql.startsWith('DELETE')){if(mode==='cleanup-failed')return [{success:false,results:[]}];return [{success:true,results:[]}];}
    return [{success:true,results:[{name:'sessions',remaining:mode==='count-nonzero'?1:0},...(mode==='old-schema'?[]:[{name:'trusted_devices',remaining:0}])]}];
   }throw Error('Unexpected command');
  };
  const plan=await planRecovery(run,'2026-09-20T11:00:00Z',time);
  if(mode==='old-schema'){
   assert.equal((await applyRecovery(run,plan,target,time)).access_revoked,true);
   assert.ok(commands.some(sql=>sql==='DELETE FROM sessions;'));
   assert.ok(!commands.filter(sql=>!sql.includes('sqlite_master')).some(sql=>sql.includes('trusted_devices')));
  }else{
   await assert.rejects(()=>applyRecovery(run,plan,target,time));
   if(mode==='cancelled')assert.equal(commands.length,0);
  }
 }
});
