const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function attentionItems(data,connections,settings,pendingFees=0){
 const list=[],add=(count,href,title,detail,tone='warning')=>{if(count>0)list.push({count,href,title,detail,tone});};
 const {orders,stock,invoices,sales,tariffs}=data;
 add(orders.changed,'#orders','Kaynak sipariş değişti','Stok işlemlerinden önce pazaryerindeki son kaydı karşılaştır.','danger');
 add(orders.unmapped,'#orders','Ürün eşleşmesi bekleyen paket','İlanı doğru stok kartına veya setine bağla.');
 add(orders.missing_amounts,'#orders','Satış tutarı eksik paket','KDV, indirim ve net tutarı kaynak siparişle doğrula.');
 add(orders.reserved,'#orders','Stok ayrıldı, gönderim bekliyor','Depodan çıkan paketleri kaydet; stok bir kez düşsün.');
 add(stock.low,'#stock','Kritik kullanılabilir stok','Siparişlere ayrılan miktar düşüldükten sonra alt sınırda.');
 add(invoices.drafts,'#invoices','İncelenecek alış faturası','Tedarikçiyi, ürün bağlantısını ve tutarları kontrol et.');
 add(invoices.awaiting_receipt,'#invoices','Mal teslimi tamamlanmamış fatura','Borç kaydedilmiş; depoya gelen miktarı ayrıca işle.');
 add(sales.unconfirmed,'#sales','Kesintisi doğrulanmamış satış / iade','Kargo ve komisyon tamamlanmadan kâr kesinleşmez.');
 add(pendingFees>0?1:0,'#reconciliation','Satışlara dağıtılacak kesinti faturası','Kargo ve komisyon belgelerini satışlara eşleştir.');
 add(sales.losses,'#sales','Zarar gösteren satış','Doğrulanmış satış kesintilerine göre; iadeler ayrıca değerlendirilir.','danger');
 add(tariffs.shipping_expiring+tariffs.commission_expiring,'#pricing','7 gün içinde bitecek tarife','Geçerlilik tarihlerini ve yeni fiyat koşullarını kontrol et.');
 add(!settings.tax_id||!settings.legal_name?1:0,'#settings','Şirket bilgilerini tamamla','Alış faturalarının doğru şirket adına geldiğini doğrulayalım.','neutral');
 add(stock.total?stock.no_history:1,'#stock',stock.total?'Stok geçmişi olmayan ürün':'İlk stok kartlarını oluştur','Açılış veya mal teslimi olmadan depodaki gerçek miktar bilinmez.','neutral');
 add(!tariffs.shipping_active||!tariffs.commission_active?1:0,'#pricing','Geçerli kargo / komisyon tarifesi eksik','Maliyetler tamamlanmadan güvenilir kâr tahmini oluşmaz.','neutral');
 for(const p of connections.providers.filter(p=>p.id!=='edm'))add(!p.configured||!p.last_success_at||p.stale||p.last_error?1:0,'#integrations',p.name+(!p.configured?' henüz bağlı değil':p.last_error?' bağlantı hatası':!p.last_success_at?' doğrulama bekliyor':' verisi güncel değil'),'Son başarılı veri alımını Bağlantılar ekranında kontrol et.','neutral');
 return list;
}
export function renderAttention(data,connections,settings,pendingFees){
 const items=attentionItems(data,connections,settings,pendingFees);
 return `<section class="attention-center"><div class="attention-heading"><div><span class="eyebrow">ÖNCE BUNLARA BAK</span><h2>Bugünün iş listesi</h2><p>Tüm kayıtlardaki açık işler · ${esc(data.as_of)} · Aynı paket birden fazla başlıkta görünebilir.</p></div><span class="v2-badge ${items.length?'warning':'success'}">${items.length} başlık</span></div><div class="attention-grid">${items.length?items.map(i=>`<a class="attention-item ${i.tone}" href="${i.href}"><span class="attention-count">${i.count}</span><div><strong>${esc(i.title)}</strong><p>${esc(i.detail)}</p></div><span aria-hidden="true">↗</span></a>`).join(''):'<p class="help">Kontrol edilen kayıtlarda bekleyen iş bulunmadı. Mağaza aktarımının ve fiziksel stok hareketlerinin eksiksiz olması gerekir.</p>'}</div></section>`;
}
