import {parsePermissions,envelope} from '../public/permissions.js';
import {permit} from './permission-policy.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const encoder=new TextEncoder();
export const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export const hash=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
export async function passwordHash(password,salt){const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256));}
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
export const owner={id:'owner',name:'Yönetici',owner:true,ec_access:'write',lp_access:'write'};
export async function currentSession(request,db){const token=request.headers.get('Cookie')?.match(/(?:^|; )lunapot_session=([a-f0-9]{64})(?:;|$)/)?.[1];if(!token)return null;
 const row=await db.prepare('SELECT s.token_hash,s.staff_id,u.name,u.ec_access,u.lp_access,u.active,u.permissions_json,u.password_hash FROM sessions s LEFT JOIN staff_users u ON u.id=s.staff_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(token),Math.floor(Date.now()/1000)).first();
 if(!row||row.staff_id&&(!row.active||!row.password_hash))return null;
 return {token_hash:row.token_hash,user:row.staff_id?{id:row.staff_id,name:row.name,owner:false,ec_access:row.ec_access,lp_access:row.lp_access,permissions:row.permissions_json?JSON.parse(row.permissions_json):null}:owner};
}
export const authorize=permit;
const field=(v,label,max=100)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const log=(db,user,action,target)=>db.prepare('INSERT INTO access_audit(id,actor_id,actor_name,action,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),user.id,user.name,action,target);
export async function accessApi(request,env,path,readBody,user){
 if(!path.startsWith('/api/admin/users'))return null;
 if(!user.owner)fail('Çalışanları yalnızca yönetici yönetebilir.',403);
 const db=env.DB,match=path.match(/^\/api\/admin\/users(?:\/([\w-]+)(?:\/(invite))?)?$/);if(!match)fail('İşlem bulunamadı.',404);
 if(request.method==='GET'&&!match[1]){const result=await db.batch([db.prepare('SELECT id,username,name,ec_access,lp_access,permissions_json,active,password_hash IS NOT NULL activated,invite_expires_at,created_at,updated_at FROM staff_users ORDER BY name'),db.prepare('SELECT * FROM access_audit ORDER BY created_at DESC,rowid DESC LIMIT 100')]);return {users:result[0].results.map(({permissions_json,...u})=>({...u,permissions:permissions_json?JSON.parse(permissions_json):null})),audit:result[1].results};}
 if(request.method!=='POST')fail('İşlem bulunamadı.',404);
 const x=await readBody(request),id=match[1]||crypto.randomUUID(),existing=match[1]?await db.prepare('SELECT id FROM staff_users WHERE id=?').bind(id).first():null;
 if(match[1]&&!existing)fail('Çalışan bulunamadı.',404);
 let permissions;if(Object.hasOwn(x,'permissions')){try{permissions=parsePermissions(x.permissions);}catch(e){fail(e.message);}x.ec_access=envelope(permissions,'ec');x.lp_access=envelope(permissions,'lp');}
 if(!match[1]||match[2]==='invite'){
  const token=hex(crypto.getRandomValues(new Uint8Array(32))),expires=Math.floor(Date.now()/1000)+86400,items=[];
  if(!match[1]){const username=field(x.username,'Kullanıcı adı',60).toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)||username==='admin'||username==='owner')fail('Kullanıcı adı 3–60 harf/rakam içermeli; admin ve owner ayrılmıştır.');
   if(!['none','read','write'].includes(x.ec_access)||!['none','read','write'].includes(x.lp_access)||x.ec_access==='none'&&x.lp_access==='none')fail('En az bir çalışma alanı yetkisi seçin.');
   items.push(db.prepare('INSERT INTO staff_users(id,username,name,ec_access,lp_access,invite_hash,invite_expires_at,permissions_json) VALUES(?,?,?,?,?,?,?,?)').bind(id,username,field(x.name,'Ad',100),x.ec_access,x.lp_access,await hash(token),expires,permissions?JSON.stringify(permissions):null));
  }else items.push(db.prepare('UPDATE staff_users SET invite_hash=?,invite_expires_at=?,password_hash=NULL,salt=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(await hash(token),expires,id));
  try{await db.batch([...items,log(db,user,existing?'Çalışan için yeni kurulum bağlantısı':'Çalışan daveti oluşturuldu',id)]);}catch(e){if(String(e.message).includes('UNIQUE'))fail('Bu kullanıcı adı zaten kayıtlı.',409);throw e;}
  return {id,invite_path:'/access#invite='+token,expires_at:expires};
 }
 if(!['none','read','write'].includes(x.ec_access)||!['none','read','write'].includes(x.lp_access)||typeof x.active!=='boolean')fail('Yetki bilgisi geçersiz.');
 await db.batch([db.prepare('UPDATE staff_users SET name=?,ec_access=?,lp_access=?,active=?,permissions_json=COALESCE(?,permissions_json),updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(field(x.name,'Ad'),x.ec_access,x.lp_access,x.active?1:0,permissions?JSON.stringify(permissions):null,id),log(db,user,'Çalışan yetkisi güncellendi; eski oturumları kapatıldı',id)]);return {id};
}
export async function acceptInvite(db,input){
 if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))fail('Kurulum bağlantısı geçersiz veya süresi dolmuş.',400);
 const tokenHash=await hash(input.token),now=Math.floor(Date.now()/1000),row=await db.prepare('SELECT id FROM staff_users WHERE invite_hash=? AND invite_expires_at>? AND active=1').bind(tokenHash,now).first();if(!row)fail('Kurulum bağlantısı geçersiz veya süresi dolmuş.',400);
 const password=input.password;if(typeof password!=='string'||password.length>200||password.length<12)fail('Şifre en az 12 karakter olmalı.');const salt=crypto.randomUUID();
 const results=await db.batch([db.prepare('UPDATE staff_users SET salt=?,password_hash=?,invite_hash=NULL,invite_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND invite_hash=? AND invite_expires_at>? AND active=1 RETURNING id').bind(salt,await passwordHash(password,salt),row.id,tokenHash,now)]);
 if(!results[0].results.length)fail('Kurulum bağlantısı daha önce kullanıldı.',409);return {ok:true};
}
