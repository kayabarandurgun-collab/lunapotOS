import {hash,hex,passwordHash,equal,currentSession,reauthenticate} from './access-api.js';
import {takeLoginBudget} from './login-limits.js';

const now=()=>Math.floor(Date.now()/1000);
const fail=(status=401)=>{throw Object.assign(Error('İşlem doğrulanamadı. Şifrenizle giriş yapın veya daha sonra tekrar deneyin.'),{status});};
const DEVICE_COOKIE='__Host-lunapot_device';
const AGE=30*86400;
const reply=(data,headers={})=>Response.json(data,{headers:{'Cache-Control':'no-store',...headers}});
const deviceToken=request=>request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-lunapot_device=([a-f0-9]{64})(?:;|$)/)?.[1];
const cookie=(token,age=AGE)=>`${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
const ip=request=>request.headers.get('CF-Connecting-IP')||'local';
const audit=(db,user,action,target=null)=>db.prepare('INSERT INTO access_audit(id,actor_id,actor_name,action,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),user.id,user.name,action,target);
const liveGrant=`FROM trusted_devices d LEFT JOIN staff_users u ON u.id=d.staff_id LEFT JOIN admin a ON a.id=1
 WHERE d.token_hash=? AND d.expires_at>? AND ((d.staff_id IS NULL AND a.salt=d.password_version AND a.password_hash IS NOT NULL)
 OR (d.staff_id IS NOT NULL AND u.active=1 AND u.password_hash IS NOT NULL AND u.salt=d.password_version))`;
async function grant(request,db){const token=deviceToken(request);return token?db.prepare('SELECT d.* '+liveGrant).bind(await hash(token),now()).first():null;}
// Recovery orchestration must call this AFTER a database Time Travel restore (which restores triggers and grants too).
export async function revokeTrustedDevices(db,staffId=undefined){
 if(staffId===undefined)return db.batch([db.prepare('DELETE FROM trusted_devices'),db.prepare('DELETE FROM sessions')]);
 return db.batch([db.prepare('DELETE FROM trusted_devices WHERE staff_id IS ?').bind(staffId),db.prepare('DELETE FROM sessions WHERE staff_id IS ?').bind(staffId)]);
}
export async function quickAccessApi(request,env,path,readBody){
 const routes={
  '/api/auth/quick/status':'GET','/api/auth/quick/login':'POST','/api/auth/quick/forget':'POST',
  '/api/auth/quick/devices':'GET','/api/auth/quick/enroll':'POST','/api/auth/quick/revoke':'POST',
 };
 if(!Object.hasOwn(routes,path))return null;
 if(request.method!==routes[path])fail(404);
 const db=env.DB;
 if(path==='/api/auth/quick/status')return reply({available:!!await grant(request,db)});
 if(path==='/api/auth/quick/forget'){
  const token=deviceToken(request);
  if(token)await db.prepare('DELETE FROM trusted_devices WHERE token_hash=?').bind(await hash(token)).run();
  return reply({ok:true},{'Set-Cookie':cookie('',0)});
 }
 if(path==='/api/auth/quick/login'){
  await takeLoginBudget(db,'quick-ip:'+ip(request),30);
  const device=await grant(request,db);if(!device)fail();
  await takeLoginBudget(db,'quick-device:'+device.id,5);
  const current=await currentSession(request,db);
  if(current&&(current.user.owner?device.staff_id!==null:current.user.id!==device.staff_id))fail();
  const input=await readBody(request);
  if(typeof input?.pin!=='string'||!/^\d{6}$/.test(input.pin))fail();
  if(!equal(await passwordHash(input.pin,device.pin_salt),device.pin_hash))fail();
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  // Recheck grant, credential version and active state in the session INSERT itself.
  // A concurrent revoke/password reset must not mint a session from a stale JS snapshot.
  const inserted=await db.prepare('INSERT INTO sessions(token_hash,expires_at,staff_id,trusted_device_id) SELECT ?,?,d.staff_id,d.id '+liveGrant+' AND d.id=? AND d.pin_hash=? RETURNING token_hash').bind(await hash(token),now()+604800,device.token_hash,now(),device.id,device.pin_hash).first();
  if(!inserted)fail();
  await db.prepare('UPDATE trusted_devices SET last_used_at=? WHERE id=?').bind(now(),device.id).run();
  return reply({ok:true},{'Set-Cookie':`lunapot_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
 }
 const current=await currentSession(request,db);if(!current)fail();
 const user=current.user,staffId=user.owner?null:user.id;
 if(path==='/api/auth/quick/devices'){
  const currentToken=deviceToken(request),tokenHash=currentToken?await hash(currentToken):'';
  const rows=await db.prepare('SELECT id,label,created_at,expires_at,last_used_at,token_hash=? AS current FROM trusted_devices WHERE staff_id IS ? AND expires_at>? ORDER BY created_at DESC').bind(tokenHash,staffId,now()).all();
  return reply({devices:rows.results});
 }
 const input=await readBody(request);
 if(path==='/api/auth/quick/revoke'){
  if(typeof input?.id!=='string'||input.id.length>100)fail(400);
  await db.batch([db.prepare('DELETE FROM trusted_devices WHERE id=? AND staff_id IS ?').bind(input.id,staffId),audit(db,user,'Güvenilir cihaz kaldırıldı',input.id)]);
  return reply({ok:true});
 }
 if(new URL(request.url).protocol!=='https:')fail(400);
 if(typeof input?.pin!=='string'||!/^\d{6}$/.test(input.pin)||typeof input.label!=='string'||!input.label.trim()||input.label.length>80)fail(400);
 const existing=await grant(request,db);
 if(existing&&existing.staff_id!==staffId)fail();
 const account=await reauthenticate(request,db,user,input.current_password);
 const token=hex(crypto.getRandomValues(new Uint8Array(32))),salt=hex(crypto.getRandomValues(new Uint8Array(32))),id=crypto.randomUUID(),time=now();
 const pinHash=await passwordHash(input.pin,salt);
 // INSERT SELECT checks the still-valid authenticated session and primary credential in the same write.
 const validAccount=user.owner?'EXISTS(SELECT 1 FROM admin WHERE id=1 AND salt=? AND password_hash=?)':'EXISTS(SELECT 1 FROM staff_users WHERE id=s.staff_id AND active=1 AND salt=? AND password_hash=?)';
 const result=await db.batch([
  db.prepare(`INSERT INTO trusted_devices(id,token_hash,staff_id,password_version,pin_salt,pin_hash,label,created_at,expires_at)
   SELECT ?,?,s.staff_id,?,?,?,?,?,? FROM sessions s WHERE s.token_hash=? AND s.expires_at>? AND s.staff_id IS ? AND ${validAccount}
   AND (SELECT COUNT(*) FROM trusted_devices WHERE staff_id IS ? AND expires_at>? AND id<>?)<10 RETURNING id`).bind(id,await hash(token),account.salt,salt,pinHash,input.label.trim(),time,time+AGE,current.token_hash,time,staffId,account.salt,account.password_hash,staffId,time,existing?.id||''),
  // Preserve the reauthenticated caller before deleting the replaced grant; other quick sessions are revoked.
  db.prepare('UPDATE sessions SET trusted_device_id=? WHERE token_hash=? AND trusted_device_id IS NOT NULL AND EXISTS(SELECT 1 FROM trusted_devices WHERE id=?)').bind(id,current.token_hash,id),
  db.prepare('DELETE FROM trusted_devices WHERE (expires_at<=? OR (id=? AND staff_id IS ?)) AND EXISTS(SELECT 1 FROM trusted_devices WHERE id=?)').bind(time,existing?.id||'',staffId,id),
 ]);
 if(!result[0].results.length)fail(409);
 await audit(db,user,'Güvenilir cihaz kaydedildi',id).run();
 return reply({ok:true,expires_at:time+AGE},{'Set-Cookie':cookie(token)});
}
