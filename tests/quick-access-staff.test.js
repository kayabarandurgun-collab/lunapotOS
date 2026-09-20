import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {modules} from '../public/permissions.js';
const OWNER='synthetic-owner-password',PASSWORD='synthetic-staff-password',PIN='000042';
const permissions=(stock='write',amounts='none')=>({ec:Object.fromEntries(Object.keys(modules.ec).map(k=>[k,k==='stock'?stock:k==='amounts'?amounts:'none'])),lp:Object.fromEntries(Object.keys(modules.lp).map(k=>[k,'none'])),delete_records:false});
async function fixture(){const f=appFixture();await f.setup();
 const invite=await f.ok('/admin/users',{name:'Sentetik Ekip',username:'synthetic.staff',permissions:permissions()});
 assert.equal((await f.req('/auth/accept-invite',{token:invite.invite_path.split('=')[1],password:PASSWORD},'')).status,200);
 const staff=(await f.req('/auth/login',{username:'synthetic.staff',password:PASSWORD},'')).cookie;
 const enroll=()=>f.req('/auth/quick/enroll',{label:'Sentetik personel cihazı',current_password:PASSWORD,pin:PIN},staff);
 const quick=device=>f.req('/auth/quick/login',{pin:PIN},device);
 return {...f,id:invite.id,staff,enroll,quick};
}

test('staff may manage own credentials with no workspace permissions but never admin or another account',async()=>{
 const f=await fixture();try{
  assert.equal((await f.req('/auth/quick/devices',undefined,'')).status,401);
  assert.equal((await f.req('/admin/users',undefined,f.staff)).status,403);
  assert.equal((await f.req('/admin/password',{current_password:OWNER,password:'synthetic-replacement'},f.staff)).status,403);
  const device=(await f.enroll()).cookie;
  const ownerDevice=await f.req('/auth/quick/enroll',{label:'Owner',current_password:OWNER,pin:'123456'});
  const ownerId=(await f.ok('/auth/quick/devices')).devices[0].id;
  assert.equal((await f.req('/auth/quick/revoke',{id:ownerId},f.staff)).status,200);
  assert.equal((await f.req('/auth/quick/status',undefined,ownerDevice.cookie)).data.available,true,'staff cannot revoke another identity');
  assert.equal((await f.req('/auth/quick/login',{pin:'123456'},f.staff+'; '+ownerDevice.cookie)).status,401,'quick login cannot silently switch authenticated identity');
  assert.equal((await f.req('/auth/quick/enroll',{label:'Other identity',pin:PIN,current_password:PASSWORD},f.staff+'; '+ownerDevice.cookie)).status,401);
  await f.ok('/admin/users/'+f.id,{name:'Sentetik Ekip',active:true,permissions:permissions('none')});
  const quick=await f.quick(device);assert.equal(quick.status,200);const self=await f.req('/auth/status',undefined,quick.cookie);assert.equal(self.data.user.id,f.id);assert.equal(self.data.user.ec_access,'none');
  assert.equal((await f.req('/auth/quick/devices',undefined,quick.cookie)).status,200);
  assert.equal((await f.req('/auth/password',{current_password:PASSWORD,password:'synthetic-new-personal',staff_id:'owner'},quick.cookie)).status,200);
  assert.equal((await f.req('/auth/login',{password:OWNER},'')).status,200,'owner credential unchanged');
 }finally{f.close();}
});

test('quick login reads latest page/amount/delete permissions and never serializes privileges into device grants',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie,first=await f.quick(device);assert.equal(first.status,200);
  await f.ok('/admin/users/'+f.id,{name:'Yeni Personel Adı',active:true,permissions:permissions('read','none')});
  assert.equal((await f.req('/auth/status',undefined,first.cookie)).data.authenticated,false);
  const second=await f.quick(device);assert.equal(second.status,200);
  const me=(await f.req('/auth/status',undefined,second.cookie)).data.user;assert.equal(me.name,'Yeni Personel Adı');assert.equal(me.permissions.ec.stock,'read');assert.equal(me.permissions.ec.amounts,'none');assert.equal(me.permissions.delete_records,false);
  assert.equal((await f.req('/ec/products',{name:'Not permitted'},second.cookie)).status,403);
  assert.equal((await f.req('/ec/ledger',undefined,second.cookie)).status,403);
  assert.equal((await f.req('/admin/users',undefined,second.cookie)).status,403);
  assert.deepEqual(Object.keys(f.sqlite.prepare('SELECT * FROM trusted_devices').get()).filter(k=>/role|permissions|access/.test(k)),[]);
 }finally{f.close();}
});

test('staff changes own primary password: reauth/minimum12, other sessions and all quick grants revoked',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie,quick=await f.quick(device);
  assert.equal((await f.req('/auth/password',{current_password:'incorrect-password',password:'synthetic-new-personal'},f.staff)).status,401);
  assert.equal((await f.req('/auth/password',{current_password:PASSWORD,password:'123456'},f.staff)).status,400);
  const change=await f.req('/auth/password',{current_password:PASSWORD,password:'synthetic-new-personal'},f.staff);assert.equal(change.status,200);
  for(const cookie of [f.staff,quick.cookie])assert.equal((await f.req('/auth/status',undefined,cookie)).data.authenticated,false);
  assert.equal((await f.req('/auth/status',undefined,change.cookie)).data.user.id,f.id);
  assert.equal((await f.quick(device)).status,401);
  assert.equal((await f.req('/auth/login',{username:'synthetic.staff',password:PASSWORD},'')).status,401);
  assert.equal((await f.req('/auth/login',{username:'synthetic.staff',password:'synthetic-new-personal'},'')).status,200);
  assert.doesNotMatch(JSON.stringify(await f.ok('/admin/users')),/synthetic-new-personal|000042|password_hash|pin_hash|pin_salt/);
 }finally{f.close();}
});

test('reinvite revokes sessions/devices, old invite/password cannot revive grants, new invite is one-use',async()=>{
 const f=await fixture();try{
  const device=(await f.enroll()).cookie,quick=await f.quick(device);
  const oldInvite=await f.ok('/admin/users/'+f.id+'/invite',{}),newInvite=await f.ok('/admin/users/'+f.id+'/invite',{});
  assert.equal((await f.req('/auth/status',undefined,quick.cookie)).data.authenticated,false);assert.equal((await f.quick(device)).status,401);
  assert.equal((await f.req('/auth/accept-invite',{token:oldInvite.invite_path.split('=')[1],password:PASSWORD},'')).status,400);
  assert.equal((await f.req('/auth/login',{username:'synthetic.staff',password:PASSWORD},'')).status,401);
  assert.equal((await f.req('/auth/accept-invite',{token:newInvite.invite_path.split('=')[1],password:'synthetic-reinvited-password'},'')).status,200);
  assert.equal((await f.req('/auth/accept-invite',{token:newInvite.invite_path.split('=')[1],password:PASSWORD},'')).status,400);
  assert.equal((await f.quick(device)).status,401);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM trusted_devices WHERE staff_id=?').get(f.id).n,0);
 }finally{f.close();}
});

test('deactivation revokes device grants permanently; reactivation cannot bring old credentials grants back',async()=>{
 const f=await fixture();try{const device=(await f.enroll()).cookie,quick=await f.quick(device);
  await f.ok('/admin/users/'+f.id,{name:'Sentetik Ekip',active:false,permissions:permissions()});
  assert.equal((await f.req('/auth/status',undefined,quick.cookie)).data.authenticated,false);assert.equal((await f.quick(device)).status,401);
  await f.ok('/admin/users/'+f.id,{name:'Sentetik Ekip',active:true,permissions:permissions()});
  assert.equal((await f.quick(device)).status,401);assert.equal((await f.req('/auth/login',{username:'synthetic.staff',password:PASSWORD},'')).status,200);
 }finally{f.close();}
});

test('unused and expired invite states stay distinguishable without exposing invite or credential hashes',async()=>{
 const f=await fixture();try{
  const invite=await f.ok('/admin/users',{name:'Bekleyen Personel',username:'pending.staff',permissions:permissions('read')});
  let row=(await f.ok('/admin/users')).users.find(x=>x.id===invite.id);assert.equal(row.activated,0);assert.ok(row.invite_expires_at>Math.floor(Date.now()/1000));
  f.sqlite.prepare('UPDATE staff_users SET invite_expires_at=1 WHERE id=?').run(invite.id);
  row=(await f.ok('/admin/users')).users.find(x=>x.id===invite.id);assert.equal(row.activated,0);assert.equal(row.invite_expires_at,1);
  assert.equal((await f.req('/auth/accept-invite',{token:invite.invite_path.split('=')[1],password:PASSWORD},'')).status,400);
  assert.doesNotMatch(JSON.stringify(row),/invite_hash|password_hash|salt/);
 }finally{f.close();}
});
