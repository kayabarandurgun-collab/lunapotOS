import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const identity={account_id:config.account_id,database_id:config.d1_databases[0].database_id};
const validBookmark=x=>typeof x==='string'&&/^[a-f0-9-]{40,100}$/.test(x);
export function validateTimestamp(timestamp,now=Date.now()){
 if(typeof timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp))throw Error('Saat dilimi içeren ISO tarih girin; örn. 2026-09-09T14:00:00+03:00.');
 const time=Date.parse(timestamp);if(!Number.isFinite(time)||time>now||now-time>7*86400000)throw Error('Ücretsiz kurtarma için son 7 gün içinde bir zaman seçin.');return new Date(time).toISOString();
}
export async function planRecovery(run,timestamp,now=Date.now()){
 const targetTime=validateTimestamp(timestamp,now),current=await run(['d1','time-travel','info','DB','--json']),target=await run(['d1','time-travel','info','DB','--timestamp',targetTime,'--json']);
 if(!validBookmark(current.bookmark)||!validBookmark(target.bookmark))throw Error('Cloudflare kurtarma noktaları doğrulanamadı.');
 return {format:'lunapot-recovery-plan',version:1,...identity,created_at:new Date(now).toISOString(),target_time:targetTime,target_bookmark:target.bookmark,safety_bookmark:current.bookmark,scope:'both-workspaces-and-accounts',note:'İki panel ve kullanıcılar birlikte geri döner. Uygulama kodu geri alınmaz; şema uyumu kontrol edilmelidir.'};
}
export async function applyRecovery(run,plan,confirmation,now=Date.now()){
 if(plan?.format!=='lunapot-recovery-plan'||plan.version!==1||plan.account_id!==identity.account_id||plan.database_id!==identity.database_id||plan.scope!=='both-workspaces-and-accounts'||!validBookmark(plan.target_bookmark)||!validBookmark(plan.safety_bookmark)||confirmation!==plan.target_bookmark)throw Error('Plan kimliği veya açık kurtarma noktası onayı uyuşmuyor.');
 const age=now-Date.parse(plan.created_at);if(!Number.isFinite(age)||age<0||age>15*60000)throw Error('Planın süresi doldu; güncel güvenlik noktasıyla yeniden hazırlayın.');
 validateTimestamp(plan.target_time,now);
 const current=await run(['d1','time-travel','info','DB','--json']);if(current.bookmark!==plan.safety_bookmark)throw Error('Plan sonrasında veritabanı değişmiş. İşlem girişini durdurup yeniden plan hazırlayın.');
 const target=await run(['d1','time-travel','info','DB','--timestamp',plan.target_time,'--json']);if(target.bookmark!==plan.target_bookmark)throw Error('Hedef zaman ve kurtarma noktası uyuşmuyor.');
 // The runner retains an explicit default-no terminal confirmation and returns the JSON restore result.
 const restored=await run(['d1','time-travel','restore','DB','--bookmark',plan.target_bookmark],false);
 if(restored?.bookmark!==plan.target_bookmark||restored?.previous_bookmark!==plan.safety_bookmark)throw Error('Kurtarmanın tamamlandığı doğrulanamadı veya güvenlik noktası değişti. Uygulamayı açmadan sonucu ve erişimleri kontrol edin.');
 // Older recovery points may predate trusted-device schema. Inspect first; never CREATE auth tables here.
 const execute=command=>run(['d1','execute','DB','--remote','--json','--command',command]);
 const resultRows=value=>{if(!Array.isArray(value)||!value.length||value.some(x=>x.success!==true||!Array.isArray(x.results)))throw Error('Kurtarma sonrası erişim temizliği doğrulanamadı; uygulamayı henüz açmayın.');return value.flatMap(x=>x.results);};
 const schema=resultRows(await execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','trusted_devices')"));
 if(schema.some(row=>!['sessions','trusted_devices'].includes(row.name)))throw Error('Kurtarma sonrası erişim şeması doğrulanamadı.');
 const tables=['sessions','trusted_devices'].filter(name=>schema.some(row=>row.name===name));
 if(tables.length){
  resultRows(await execute(tables.map(name=>'DELETE FROM '+name+';').join(' ')));
  const counts=resultRows(await execute(tables.map(name=>"SELECT '"+name+"' AS name,COUNT(*) AS remaining FROM "+name).join(' UNION ALL ')));
  if(counts.length!==tables.length||counts.some(row=>row.remaining!==0)||tables.some(name=>!counts.some(row=>row.name===name)))throw Error('Kurtarma sonrası oturum/cihaz iptali doğrulanamadı. Uygulamayı açmayın.');
 }
 return {requested_target:plan.target_bookmark,undo_bookmark:plan.safety_bookmark,access_revoked:true,verification_required:true};
}
async function wrangler(args,json=true){
 let commandArgs=args;
 if(!json){
  // Piping Wrangler's interactive output makes its noninteractive fallback answer YES.
  // Ask explicitly before requesting JSON, so cancellation and provider success are distinguishable.
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Kurtarma için etkileşimli terminal onayı gerekli. Hiçbir geri yükleme yapılmadı.');
  const rl=createInterface({input:process.stdin,output:process.stdout});let answer;
  try{answer=await rl.question('Veritabanı geri yüklenecek; mevcut oturumlar ve cihaz kayıtları iptal edilecek. Devam edilsin mi? (y/N) ');}finally{rl.close();}
  if(!/^(y|yes)$/i.test(answer.trim()))throw Error('Kurtarma iptal edildi.');
  commandArgs=[...args,'--json'];
 }
 const r=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),...commandArgs],{cwd:root,encoding:'utf8',stdio:'pipe',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 if(r.status!==0)throw Error('Cloudflare işlemi tamamlanamadı. Kimlik doğrulamayı ve çıktıyı kontrol edin.');return JSON.parse(r.stdout);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,value,confirmation]=process.argv.slice(2);if(mode==='plan'){
  const plan=await planRecovery(wrangler,value),file=resolve(root,'work/recovery/plan-'+Date.now()+'.json');mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(plan,null,2));console.log('Yalnızca plan hazırlandı; canlı kayıtlar değiştirilmedi.\n'+file+'\nHedef: '+plan.target_time+'\nKurtarma noktası: '+plan.target_bookmark+'\nGeri alma noktası: '+plan.safety_bookmark);
 }else if(mode==='apply'){
  const file=resolve(value||'');const plan=JSON.parse(readFileSync(file,'utf8')),result=await applyRecovery(wrangler,plan,confirmation);writeFileSync(file+'.result.json',JSON.stringify(result,null,2));console.log('Kurtarma doğrulandı; önceki oturumlar ve güvenilir cihaz kayıtları iptal edildi. Güvenlik noktası: '+result.undo_bookmark+'\nUygulama şemasını ve çalışan yetkilerini kontrol edin.');
 }else throw Error('Kullanım: node scripts/recovery.mjs plan <saat-dilimli-tarih> veya apply <plan-dosyası> <hedef-kurtarma-noktası>');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
