const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function attentionItems(data,connections,settings,pendingFees=0){
 const list=[],add=(count,href,title,detail,tone='warning')=>{if(count>0)list.push({count,href,title,detail,tone});};
 const {orders,stock,invoices,sales,tariffs}=data;
 add(orders.changed,'#orders?watch=source_changed','Kaynak sipariş değişti','Stok işlemlerinden önce pazaryerindeki son kaydı karşılaştır.','danger');
 add(orders.unmapped,'#orders?watch=unmapped','Ürün eşleşmesi bekleyen paket','İlanı doğru stok kartına veya setine bağla.');
 add(orders.missing_amounts,'#orders?watch=missing_amounts','Satış tutarı eksik paket','KDV, indirim ve net tutarı kaynak siparişle doğrula.');
 add(orders.reserved,'#orders?status=reserved','Stok ayrıldı, gönderim bekliyor','Depodan çıkan paketleri kaydet; stok bir kez düşsün.');
 add(orders.long_shipping,'#orders?watch=long_shipping','7+ gündür kargoda görünen paket','Teslim durumunu kontrol et. Bu süre uyarı eşiğidir; teslim taahhüdü değildir.');
 add(orders.undelivered,'#orders?watch=undelivered','Pazaryeri teslim edilemedi diyor','Bizde teslim/kargoda görünüyor. Kâr yanlışlıkla sayılmış olabilir; iadeyi veya gerçek durumu sen onayla.','danger');
 add(stock.low,'#stock?filter=low','Kritik kullanılabilir stok','Siparişlere ayrılan miktar düşüldükten sonra alt sınırda.');
 add(invoices.drafts,'#invoices','İncelenecek alış faturası','Tedarikçiyi, ürün bağlantısını ve tutarları kontrol et.');
 add(invoices.awaiting_receipt,'#invoices','Mal teslimi tamamlanmamış fatura','Borç kaydedilmiş; depoya gelen miktarı ayrıca işle.');
 // YALNIZ TESLIM EDILMIS OLAN IS SAYILIR. Teslim edilmemis pakete kural geregi kesinti yazilmaz;
 // onu listeye koymak "236 is var" izlenimi veriyor, gercekten bakilmasi gereken 61'i gizliyordu.
 // Bekleyenlerin sayisi yine yazilir ama is olarak sayilmaz.
 const teslimEdilmis=sales.delivered_unconfirmed??sales.unconfirmed,bekleyen=(sales.unconfirmed||0)-(teslimEdilmis||0);
 add(teslimEdilmis,'#sales','Teslim edilmiş ama kesintisi yazılmamış satış',
  'Kargo ve komisyon tamamlanmadan kâr kesinleşmez.'+(bekleyen>0?' Ayrıca '+bekleyen+' satış teslim bekliyor; onlara kural gereği henüz kesinti yazılmaz.':''));
 add(pendingFees>0?1:0,'#reconciliation','Satışlara dağıtılacak kesinti faturası','Kargo ve komisyon belgelerini satışlara eşleştir.');
 // Component allocations are not independent sold offerings; profitability belongs to Satış ve kâr.

 add(tariffs.shipping_expiring+tariffs.commission_expiring,'#pricing','7 gün içinde bitecek tarife','Geçerlilik tarihlerini ve yeni fiyat koşullarını kontrol et.');
 add(!settings.tax_id||!settings.legal_name?1:0,'#settings','Şirket bilgilerini tamamla','Alış faturalarının doğru şirket adına geldiğini doğrulayalım.','neutral');
 add(stock.total?stock.no_history:1,'#stock',stock.total?'Stok geçmişi olmayan ürün':'İlk stok kartlarını oluştur','Açılış veya mal teslimi olmadan depodaki gerçek miktar bilinmez.','neutral');
 add(!tariffs.shipping_active||!tariffs.commission_active?1:0,'#pricing','Geçerli kargo / komisyon tarifesi eksik','Maliyetler tamamlanmadan güvenilir kâr tahmini oluşmaz.','neutral');
 // Bağlantı durumu günlük iş değil kurulum bilgisidir: her mağaza için ayrı satır yerine tek satır.
 const kanallar=connections.providers.filter(p=>p.id!=='edm'),sorunlu=kanallar.filter(p=>!p.configured||!p.last_success_at||p.stale||p.last_error);
 // BAĞLANTI YOKLUĞU TEK BAŞINA EKSİK İŞ DEĞİLDİR. Kullanıcı API'leri bilerek kapatıp raporu elle
 // yükleme düzenine geçebilir (26.09.2026'da öyle oldu). Eskiden bu satır "Satış kanalları henüz
 // bağlı değil · Bağlanınca haftalık dosya yükleme işi kendiliğinden yapılır" diye her gün
 // görünüyordu: bilinçli bir karar, kapatılamayan bir "yapılacak iş" gibi duruyordu.
 // Asıl sorulacak soru şu: pazaryeri verisi akıyor mu? Rapor son 14 gün içinde işlendiyse akıyor.
 // Ne bağlantı ne de güncel rapor varsa uyarı GERÇEKTİR ve daha sert yazılır.
 // Yarim kalan yukleme: dosya alinmis ama islenmemis. Kullanici ayni dosyayi yeniden secince
 // kaldigi yerden surer; bilmedigi surece o donemin raporu hic islenmemis kalir.
 // Arka planda calisan is surekli hata veriyorsa kullanici bunu yalnizca paneli acip etkinlik
 // listesini okuyarak fark edebiliyordu; otomatik bakimin var olma amaci tam olarak ekran
 // kapaliyken is yapmaktir. Telegram'a gonderilmiyor (her tur ayni hatayi tekrarlardi).
 add(data.reports?.bakim_sorunu||0,'#settings','Otomatik bakım turu hata verdi','Son 24 saatte bu kadar turda sorun yazıldı. Etkinlik listesinden sebebine bak; işler ertelenmiş olabilir.');
 add(data.reports?.yarim||0,'#reports','Yarım kalan rapor yüklemesi','Aynı dosyayı yeniden seç; kaldığı yerden sürer. İşlenmeden o dönemin siparişleri ve kesintileri panele girmez.');
 const sonRapor=data.reports?.last_applied?String(data.reports.last_applied).slice(0,10):'';
 const gunFarki=sonRapor?Math.floor((Date.parse(data.as_of+'T00:00:00Z')-Date.parse(sonRapor+'T00:00:00Z'))/86400000):null;
 const raporGuncel=gunFarki!==null&&gunFarki<=14;
 // kanallar BOŞSA (hiç sağlayıcı tanımlı değil) 0===0 tuzağına düşülmez: ortada kanal yoksa
 // "hepsi bozuk" denemez, bu ekranın konusu da değildir.
 const hicVeriYok=kanallar.length>0&&sorunlu.length===kanallar.length&&!raporGuncel;
 if(hicVeriYok)add(1,'#reports','Pazaryeri verisi akmıyor',sonRapor?'Bağlantı kapalı ve son rapor '+gunFarki+' gün önce işlendi. Güncel raporu yükle.':'Bağlantı da yok, işlenmiş rapor da yok. Raporu yükle ya da mağazayı bağla.','warning');
 else if(sorunlu.length&&sorunlu.length<kanallar.length)add(1,'#integrations',sorunlu.map(p=>p.name).join(', ')+' bağlantısı kontrol bekliyor','Bağlantı hata veriyor ya da uzun süredir veri çekmedi.','neutral');
 return list;
}
export function renderAttention(data,connections,settings,pendingFees){
 const items=attentionItems(data,connections,settings,pendingFees);
 return `<section class="attention-center"><div class="attention-heading"><div><span class="eyebrow">ÖNCE BUNLARA BAK</span><h2>Bugünün iş listesi</h2><p>Tüm kayıtlardaki açık işler · ${esc(data.as_of)} · Aynı paket birden fazla başlıkta görünebilir.</p></div><span class="v2-badge ${items.length?'warning':'success'}">${items.length} başlık</span></div><div class="attention-grid">${items.length?items.map(i=>`<a class="attention-item ${i.tone}" href="${i.href}"><span class="attention-count">${i.count}</span><div><strong>${esc(i.title)}</strong><p>${esc(i.detail)}</p></div><span aria-hidden="true">↗</span></a>`).join(''):'<p class="help">Kontrol edilen kayıtlarda bekleyen iş bulunmadı. Mağaza aktarımının ve fiziksel stok hareketlerinin eksiksiz olması gerekir.</p>'}</div></section>`;
}
