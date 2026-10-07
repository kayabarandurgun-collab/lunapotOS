/**
 * "YOLDA" SAYILMAYAN PAKETLER. İadesi tamamlanmış (dönmüş) paket yolda değildir. İKAME ters kaydı
 * iade DEĞİLDİR: siparişteki ürün yerine başkası gönderilmiştir, paket yine yolda — sayılsaydı
 * düzeltilen sipariş kargo takibinden sessizce düşerdi. Çift aktarımın asıl kaydı da yolda
 * sayılmaz: teslimi kopyasıyla gelmiştir.
 *
 * TEK METİN, İKİ EKRAN. İş listesi rozeti ile sipariş ekranının süzgeci AYNI koşulu kullanmalı.
 * Ayrı yazıldıkları sürece ayrıştılar: ölçüldü (07.10.2026) rozet "2" diyordu, rozete tıklayınca
 * liste 10 satır gösteriyordu — kullanıcı aynı işi iki ekranda iki farklı sayıyla görüyordu.
 * Koşul `order_packages`a dışarıdan bağlanır, yani hem SUM(...) içinde hem WHERE'de çalışır.
 */
export const YOLDA_DEGIL = "NOT EXISTS(SELECT 1 FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id"
 + " WHERE l.package_id=order_packages.id AND s.kind='sale' AND (SELECT COALESCE(SUM(r.quantity_milli),0) FROM sale_entries r WHERE r.parent_id=s.id AND r.kind='return' AND r.external_id NOT LIKE 'DUZELTME-IKAME-%')>=s.quantity_milli)"
 + " AND NOT EXISTS(SELECT 1 FROM order_packages d JOIN order_lines l ON l.package_id=d.id JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id"
 + " WHERE d.channel=order_packages.channel AND d.order_no=order_packages.order_no AND d.status='delivered' AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%')";

const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const date=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('Tarih geçersiz.');return value;};
// Bind all user values. Search applies before paging, including old packages.
// İÇ AKTARIM ARTIĞI: aktarım sırasında kurulup sevk edilmeden iptal edilen ve YERİNE YENİSİ kurulan
// taslak. Kargoya çıkmamış, satışı yok, hiçbir rapor kaydına bağlı değil ve aynı siparişin iptal
// olmayan başka kaydı duruyor. Sipariş değildir; listede ve sayılarda gösterilmez. Gerçek iptal
// (rapora bağlı, sevk edilmiş ya da satışı olan) görünmeye devam eder.
export const AKTARIM_ARTIGI="(order_packages.status='cancelled' AND order_packages.shipped_on IS NULL"
 +" AND NOT EXISTS(SELECT 1 FROM ec_report_records r WHERE r.erp_package_id=order_packages.id)"
 +" AND NOT EXISTS(SELECT 1 FROM order_line_components c JOIN order_lines l ON l.id=c.line_id WHERE l.package_id=order_packages.id AND c.sale_id IS NOT NULL)"
 +" AND EXISTS(SELECT 1 FROM order_packages q WHERE q.order_no=order_packages.order_no AND q.channel=order_packages.channel AND q.id!=order_packages.id AND q.status!='cancelled'))";
export function ordersQuery(url,today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'})){
 const p=new URL(url).searchParams,selected=p.get('package');
 if(selected){if(!/^[\w-]{1,100}$/.test(selected))fail('Paket kimliği geçersiz.');return {scope:' WHERE id=?',args:[selected],page:1,limit:1,offset:0,sort:'date_desc',sonuc:''};}
 const clauses=[],args=[],add=(sql,...values)=>{clauses.push(sql);args.push(...values);};
 add('NOT '+AKTARIM_ARTIGI);
 const sonuc=p.get('sonuc')||'';if(!['','kar','zarar'].includes(sonuc))fail('Kâr/zarar süzgeci geçersiz.');
 const sort=p.get('sort')||'date_desc';if(!['date_desc','date_asc','amount_desc','amount_asc','profit_desc','profit_asc'].includes(sort))fail('Sıralama geçersiz.');
 const q=(p.get('q')||'').trim(),channel=p.get('channel')||'',status=p.get('status')||'',watch=p.get('watch')||'',from=p.get('from')||'',to=p.get('to')||'';
 if(q.length>200)fail('Arama en fazla 200 karakter olmalı.');
 if(channel&&!['trendyol','hepsiburada','other'].includes(channel))fail('Kanal geçersiz.');
 if(status&&!['draft','reserved','shipped','delivered','cancelled'].includes(status))fail('Sipariş durumu geçersiz.');
 if(watch&&!['source_changed','unmapped','missing_amounts','long_shipping','undelivered'].includes(watch))fail('Takip filtresi geçersiz.');
 if(q){const term='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';add("(external_id LIKE ? ESCAPE '\\' OR order_no LIKE ? ESCAPE '\\' OR shipment_reference LIKE ? ESCAPE '\\')",term,term,term);}
 if(channel)add('channel=?',channel);if(status)add('status=?',status);
 if(from)add('occurred_on>=?',date(from));if(to)add('occurred_on<=?',date(to));if(from&&to&&from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 if(watch==='source_changed')add("source_changed=1 AND status!='cancelled'");
 if(watch==='unmapped')add("status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM order_line_components c WHERE c.line_id=l.id)!=10000)");
 if(watch==='missing_amounts')add("status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (l.net_revenue_cents IS NULL OR l.gross_cents IS NULL OR l.vat_bps IS NULL))");
 // Rozetle AYNI koşul (YOLDA_DEGIL): eskiden yalnız "7 günden eski ve kargoda" bakılıyordu ve
 // iadesi dönmüş / çift aktarım ikizi paketler de listeye giriyordu.
 if(watch==='long_shipping')add("status='shipped' AND shipped_on<=? AND "+YOLDA_DEGIL,new Date(Date.parse(date(today))-7*86400000).toISOString().slice(0,10));
 // Pazaryeri "teslim edilemedi" diyor ama bizde teslim/kargoda duruyor. Durum KENDİLİĞİNDEN
 // geri alınmaz: teslim kaydını geri çevirmek satışı ve stoğu da geri almak demektir, o karar
 // kullanıcınındır. Burada yalnız görünür kılınır.
 if(watch==='undelivered')add("channel='hepsiburada' AND status IN ('delivered','shipped') AND order_no!='' AND EXISTS(SELECT 1 FROM provider_records pr WHERE pr.provider='hepsiburada' AND pr.kind='undelivered' AND json_extract(pr.payload_json,'$.order_no')=order_packages.order_no)");
 const page=Number(p.get('page')||1),limit=Number(p.get('limit')||500);
 if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('Sayfa bilgisi geçersiz.');
 return {scope:clauses.length?' WHERE '+clauses.map(c=>'('+c+')').join(' AND '):'',args,page,limit,offset:(page-1)*limit,sort,sonuc};
}
