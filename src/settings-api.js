const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export async function settingsApi(request,env,path,readBody){
 if(!path.startsWith('/api/settings'))return null;
 const db=env.ROOT_DB||env.DB,ns=env.WORKSPACE;
 if(!['ec','lp'].includes(ns))fail('Çalışma alanı geçersiz.',403);
 if(path==='/api/settings'&&request.method==='GET'){
  const settings=await db.prepare('SELECT * FROM workspace_settings WHERE workspace=?').bind(ns).first();
  return {settings,workspace:ns,storage:'Cloudflare D1',ai_enabled:false,credentials_storage_ready:!!env.CREDENTIAL_KEY};
 }
 if(path==='/api/settings'&&request.method==='POST'){
  const x=await readBody(request);
  if(typeof x.legal_name!=='string'||x.legal_name.trim().length>200)fail('Ticari unvanı kontrol edin.');
  if(typeof x.tax_id!=='string'||(x.tax_id&&!/^\d{10,11}$/.test(x.tax_id)))fail('Vergi numarası 10 veya 11 rakam olmalı.');
  const old=await db.prepare('SELECT tax_id FROM workspace_settings WHERE workspace=?').bind(ns).first();
  if(old.tax_id&&old.tax_id!==x.tax_id&&await env.DB.prepare("SELECT id FROM purchase_invoices WHERE status='posted' LIMIT 1").first())fail('İşlenmiş faturalar varken şirket vergi numarası değiştirilemez.',409);
  await db.prepare('UPDATE workspace_settings SET legal_name=?,tax_id=?,updated_at=CURRENT_TIMESTAMP WHERE workspace=?').bind(x.legal_name.trim(),x.tax_id,ns).run();
  return {ok:true};
 }
 if(path==='/api/settings/backup'&&request.method==='GET'){
  const all=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results.map(x=>x.name);
  // Authentication tokens and integration secrets never enter business exports.
  const names=all.filter(n=>n.startsWith(ns+'_')&&!/connections|cursors|records/.test(n));
  if(ns==='lp')names.push('products','materials','recipes','recipe_items');
  if(names.some(n=>!/^\w+$/.test(n)))fail('Yedek tablo adı doğrulanamadı.',500);
  if(!names.length||names.length>40)fail('Bu dışa aktarma en fazla 40 veri tablosunu destekler; D1 dışa aktarımını kullanın.',409);
  // D1 limits compound SELECT terms more strictly than desktop SQLite.
  // Scalar counts use one query without UNION and leave Free-tier query headroom.
  const counts=await db.prepare('SELECT '+names.map(n=>'(SELECT COUNT(*) FROM '+n+')').join(' + ')+' AS total_rows').first();
  if(counts.total_rows>25000)fail('Bu dışa aktarma 25.000 satırı destekler. Büyük yedek için D1 dışa aktarımı gerekir.',409);
  const rows=await db.batch(names.map(n=>db.prepare('SELECT * FROM '+n+' LIMIT 25001')));
  if(rows.reduce((sum,r)=>sum+r.results.length,0)>25000)fail('Yedek sınırı aşıldı. Daha sonra tekrar deneyin.',409);
  return {format:'lunapot-business-export',version:2,workspace:ns,exported_at:new Date().toISOString(),tables:Object.fromEntries(names.map((n,i)=>[n,rows[i].results])),note:'İş verileri dışa aktarımı; şifreler ve bağlantı anahtarları dahil değildir.'};
 }
 fail('Ayar işlemi bulunamadı.',404);
}
