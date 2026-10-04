const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export async function settingsApi(request,env,path,readBody){
 if(!path.startsWith('/api/settings'))return null;
 const db=env.ROOT_DB||env.DB,ns=env.WORKSPACE;
 if(!['ec','lp'].includes(ns))fail('Çalışma alanı geçersiz.',403);
 if(path==='/api/settings'&&request.method==='GET'){
  const settings=await db.prepare('SELECT * FROM workspace_settings WHERE workspace=?').bind(ns).first();
  // Sunucunun kendiliğinden yaptığı işler (15 dakikalık otomatik bakım dahil) ekranda görünsün:
  // ekranda hiç iz olmayınca bakımın çalışıp çalışmadığı anlaşılmıyordu.
  const jobs=ns==='ec'?(await env.DB.prepare('SELECT description,created_at FROM activity ORDER BY created_at DESC LIMIT 12').all()).results:[];
  return {settings,workspace:ns,storage:'Cloudflare D1',ai_enabled:false,credentials_storage_ready:!!env.CREDENTIAL_KEY,jobs,owner:!!env.USER?.owner};
 }
 if(path==='/api/settings'&&request.method==='POST'){
  const x=await readBody(request);
  if(typeof x.legal_name!=='string'||x.legal_name.trim().length>200)fail('Ticari unvanı kontrol edin.');
  if(typeof x.tax_id!=='string'||(x.tax_id&&!/^\d{10,11}$/.test(x.tax_id)))fail('Vergi numarası 10 veya 11 rakam olmalı.');
  // Stok başlangıç tarihi UYDURULMAZ: boş bırakılabilir. Girilirse gerçek bir gün olmalı ve
  // gelecek tarih kabul edilmez. Bu tarih girilmeden, bu tarihten önceki pazaryeri siparişleri
  // bugünkü stoktan otomatik düşülmez (rapor-stok köprüsü "historical" der).
  const startRaw=typeof x.inventory_start_date==='string'?x.inventory_start_date.trim():'';
  if(startRaw&&(!/^\d{4}-\d{2}-\d{2}$/.test(startRaw)||!Number.isFinite(Date.parse(startRaw))||new Date(startRaw).toISOString().slice(0,10)!==startRaw))fail('Stok başlangıç tarihi geçersiz.');
  if(startRaw&&startRaw>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}))fail('Stok başlangıç tarihi gelecekte olamaz.');
  // Stok eksiye dusebilsin mi? ACIK beyan: varsayilan kapali. Acikken kaydi olmayan alistan
  // satilmis mal eksi bakiye olarak GORUNUR; kapaliyken satis reddedilir.
  const negatif=x.allow_negative_stock===true?1:0;
  // STOPAJI RAPORLAMAYAN KANAL. Bazi pazaryerleri stopaji siparis raporunda hic bildirmiyor
  // (olculdu 28.09.2026: Trendyol'un raporunda stopaj sutunu yok, 548 siparisin hicbirinde
  // kayit gelmiyor; Hepsiburada 205 siparisin 205'inde bildiriyor). Kayit yokken sifir saymak
  // o kanalin nakit sonucunu oldugundan yuksek gosteriyor. Isaretlenen kanalda stopaj, KDV
  // haric satisin girilen oraniyla TAHMIN edilir ve satir "tahmini" isaretini alir.
  // Varsayilan BOS: kimse acmadan hicbir rakam degismez. Gercek kayit varsa tahmin kullanilmaz.
  const kanalListesi=Array.isArray(x.withholding_estimate_channels)?x.withholding_estimate_channels
   :typeof x.withholding_estimate_channels==='string'?x.withholding_estimate_channels.split(','):[];
  const kanallar=[...new Set(kanalListesi.map(v=>String(v).trim()).filter(Boolean))];
  if(kanallar.some(v=>!['trendyol','hepsiburada'].includes(v)))fail('Stopaj tahmini yalnız tanımlı pazaryerleri için açılabilir.');
  const stopajBps=x.withholding_estimate_bps===undefined||x.withholding_estimate_bps===null||x.withholding_estimate_bps===''
   ?100:Number(x.withholding_estimate_bps);
  if(!Number.isInteger(stopajBps)||stopajBps<0||stopajBps>2000)fail('Stopaj tahmin oranı %0 ile %20 arasında olmalı.');
  const old=await db.prepare('SELECT tax_id FROM workspace_settings WHERE workspace=?').bind(ns).first();
  if(old.tax_id&&old.tax_id!==x.tax_id&&await env.DB.prepare("SELECT id FROM purchase_invoices WHERE status='posted' LIMIT 1").first())fail('İşlenmiş faturalar varken şirket vergi numarası değiştirilemez.',409);
  await db.prepare('UPDATE workspace_settings SET legal_name=?,tax_id=?,inventory_start_date=?,allow_negative_stock=?,withholding_estimate_channels=?,withholding_estimate_bps=?,updated_at=CURRENT_TIMESTAMP WHERE workspace=?')
   .bind(x.legal_name.trim(),x.tax_id,startRaw||null,negatif,kanallar.join(','),stopajBps,ns).run();
  return {ok:true};
 }
 if(path==='/api/settings/backup'&&request.method==='GET'){
  const schema=(await db.prepare("SELECT name,(SELECT json_group_array(name) FROM pragma_table_info(m.name)) columns_json FROM sqlite_master m WHERE type='table' ORDER BY name").all()).results;
  const all=schema.map(x=>x.name),columns=new Map(schema.map(x=>[x.name,JSON.parse(x.columns_json)]));
  // Authentication tokens and integration secrets never enter business exports.
  // Rapor Kutusu, alış belgeleri ve ürün ailesi tabloları bu küçük JSON dışa aktarımına girmez:
  // tablolar küçük gruplar halinde sorgulanır (D1 sorgu kotası). Ham belge parçaları zaten bu boyuttaki
  // bir JSON'a sığmaz. Hepsi tam D1 yedeğinde ve zaman yolculuğu geri sarmasında durur. Açık maliyet
  // ve kapanış kayıtları da ara hesaptır: sonuç maliyet satış satırlarında (cost_cents) zaten vardır.
  // Ödeme yöntemi/çek vadesi ve planlanan ödeme tarihi cari hareketin yan bilgisidir; tutar, tarih ve
  // kapama zaten party_entries/payment_allocations ile dışa aktarılır. Faturasız girişin
  // başlığı, satırları ve miktar tahsisleri birlikte korunur; gruplama sorgu bütçesini korur.
  // Hakediş–banka eşleştirmesi (bank_matches) ham ekstre satırına bakar; bank_lines bu küçük
  // JSON'a girmediği için eşleştirme satırı tek başına boşa düşerdi. PARANIN KENDİSİ zaten
  // cash_transactions ile dışa aktarılıyor; eşleştirme izi tam D1 yedeğinde durur.
  const names=all.filter(n=>n.startsWith(ns+'_')&&!/connections|cursors|records|_report_|purchase_document|sales_document|product_famil|purchase_family|import_batches|import_items|bank_files|bank_lines|bank_matches|party_profile_file_chunks|open_costs|cost_settlements|cost_dirty|cost_revaluations|party_payment_methods|party_entry_plans|expense_schedules/.test(n));
  if(ns==='lp')names.push('products','materials','recipes','recipe_items');
  if(names.some(n=>!/^\w+$/.test(n)))fail('Yedek tablo adı doğrulanamadı.',500);
  if(!names.length||names.length>80)fail('Bu dışa aktarma en fazla 80 veri tablosunu destekler; D1 dışa aktarımını kullanın.',409);
  // D1 limits compound SELECT terms more strictly than desktop SQLite.
  // Scalar counts use one query without UNION and leave Free-tier query headroom.
  const counts=await db.prepare('SELECT '+names.map(n=>'(SELECT COUNT(*) FROM '+n+')').join(' + ')+' AS total_rows').first();
  if(counts.total_rows>25000)fail('Bu dışa aktarma 25.000 satırı destekler. Büyük yedek için D1 dışa aktarımı gerekir.',409);
  // Four SELECT terms per query keep both the D1 compound-term and request budgets small.
  // Column names come from SQLite metadata; quote identifiers and JSON keys independently.
  const identifier=v=>'"'+v.replaceAll('"','""')+'"',literal=v=>"'"+v.replaceAll("'","''")+"'";
  const statements=[];
  for(let i=0;i<names.length;i+=4)statements.push(db.prepare(names.slice(i,i+4).map(n=>
   'SELECT '+literal(n)+' AS table_name,json_object('+columns.get(n).map(c=>literal(c)+','+identifier(c)).join(',')+') AS row_json FROM (SELECT * FROM '+identifier(n)+' LIMIT 25001)'
  ).join(' UNION ALL ')));
  const results=await db.batch(statements),tables=Object.fromEntries(names.map(n=>[n,[]]));
  if(results.reduce((sum,r)=>sum+r.results.length,0)>25000)fail('Yedek sınırı aşıldı. Daha sonra tekrar deneyin.',409);
  for(const batch of results)for(const row of batch.results)tables[row.table_name].push(JSON.parse(row.row_json));
  return {format:'lunapot-business-export',version:2,workspace:ns,exported_at:new Date().toISOString(),tables,note:'İş verileri dışa aktarımı; şifreler, bağlantı anahtarları ve ham belge/ek dosyaları dahil değildir. Ek dosyalar tam D1 yedeğinde korunur.'};
 }
 fail('Ayar işlemi bulunamadı.',404);
}
