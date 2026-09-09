# Lunapot: karar ekranları ve pazaryeri bağlantı araştırması

9 Eylül 2026. Bu not yeni Lunapot paneline aittir. Gerçek TY/HB/EDM bağlantıları bu çalışma sırasında açılmadı. Yeni geliştirmeler yereldedir; yayın ve muhasebe.lunapot.com geçişi ayrıca doğrulanacaktır.

## Kullanıcı için akış

1. **Satıştan ne kaldı?** Son 30 günde teslim edilen paketler. Kâr bırakan ve zarar eden paketler ayrı; TY/HB ayrı. Maliyeti veya kesintisi eksik paket varsa dönem toplamı kesin sonuç olarak gösterilmez. Hesaplanan alt toplamın kapsamı yazılır.
2. **Kargodaki tahminim:** tek tıkla hazırlanmakta / kargoda olan paketlerin tahmini raporu. Teslim edilenlerin toplamına karışmaz.
3. **Elimde ne var?** Güncel kullanılabilir stok ve kritik ürünlere erişim. Ürün bazında tarih, referans, giriş/çıkış filtreli tam stok geçmişi. Kg ve adet birbiriyle toplanmaz.
4. **Kaça satmalıyım?** Ürün, kanal ve satış fiyatı seçilir. Komisyon, kargo, maliyet, başabaş fiyat ve hedef kâr fiyatı gösterilir. Yakın barem sınırlarının bir kuruş altı ve sınırdaki fiyat karşılaştırılır. Daha yüksek fiyatın daha az kâr bırakabildiği eşikler uyarılır.

Hesaplanan kâr, satış katkısıdır: genel işletme giderleri ve gelir/kurumlar vergisi hariçtir. Hakediş başka bir büyüklüktür. Fiyat planındaki ürün maliyeti, kaydedilmiş planlama maliyetidir; güncel depo maliyetiyle otomatik aynı olduğu iddia edilmez. Tarifenin tarihi, kaynağı ve vergi koşulları görünür. Eksik veya çakışan tarife varsa sonuç uydurulmaz.

## Resmî dokümanlarla doğrulanan veri kapsamı

| Kaynak | Alınabilecek bilgi | Panelde doğrulanan mevcut durum / eksik |
|---|---|---|
| TY sipariş V2 | Paket / sipariş / satır kimliği, stok kodu, miktar, tutar, müşteri ve adres, durum, kargo bilgileri | V2 istemcisi ve inceleme taslağı mevcut. Bütün durumların düzenli otomatik yenilenmesi tamamlanmış değil. |
| TY finans | Satış / iade, indirim / kupon, kesinti faturaları ve ödeme kayıtları | Kaynak kayıt kutusu var. Tüm finans işlem türlerini satışlara otomatik dağıtan mutabakat tamamlanmış değil. |
| TY kargo faturası detayı | Paket ve sipariş numarası, desi, tutar, gönderi türü | Otomatik çekim ve eşleştirme henüz eklenmedi. |
| HB sipariş | Sipariş, HB SKU, ürün, miktar, tutar, KDV, müşteri / adres, komisyon alanı, vade ve taşıyıcı | Kaynak kayıt kutusu var. Otomatik paket aktarımı tamamlanmadı. |
| HB kargo durumu | Paket, takip bağlantısı / kodu, kargoda / teslim durumu; ilgili listelerde tarih ve desi | Tarihli durum taraması ve yerel paket güncellemesi tamamlanmalı. |
| HB komisyon | Komisyon sorgulama servisi mevcut | Yerel istemci var. Vergi matrahı ve ileri tarih geçerliliği doğrulanmadan otomatik tarife yapılmamalı. |
| HB muhasebe | Resmî doküman dizininde muhasebe entegrasyonu mevcut | Ayrıntılı güncel şema bu araştırmada okunamadı; canlı hesaba ait örnek yanıtla doğrulama bekliyor. |
| Fatura | Pazaryerine var olan faturanın bağlantısını iletmek mümkün | Bu işlem EDM üzerinden fatura oluşturmak anlamına gelmez. EDM bağlantısı ve resmî gönderim kullanıcıyla sonra kurulacak. |

### Trendyol kaynakları ve uygulama sonuçları

- [Sipariş paketleri V2](https://developers.trendyol.com/docs/sipari%C5%9F-paketlerini-%C3%A7ekme-getshipmentpackages): V2 zorunluluk tarihi 15 Ekim 2026. Tarih aralığı ve sayfalama sınırları gözetilmeli; büyük dönemler parçalara ayrılmalı. Mevcut istemci V2 yolunu kullanıyor.
- [Cari hesap ekstresi](https://developers.trendyol.com/docs/cari-hesap-ekstresi-entegrasyonu): teslimat sonrası finans kayıtları, satış/iade ve diğer finans hareketleri ayrıdır. Sorgu aralığı en fazla 15 gün. Ödeme kimliği ödeme sonrasında oluşabilir. Satıcı geliri ve komisyon düzeltmeleri gibi ilişkili kayıtlar birlikte değerlendirilmelidir. Platform hizmet bedeli alt türü de bulunur. **Bizim çıkarımımız:** teslimatı kesin finans sonucu için tek başına yeterli saymamalıyız.
- [Kargo faturası ayrıntıları](https://developers.trendyol.com/docs/kargo-faturas%C4%B1-detaylar%C4%B1): fatura seri numarasıyla sayfalı kalemler sorgulanır; paket, sipariş, gönderi türü, desi ve tutar döner. **Uygulama planımız:** paket ve fatura kimliğiyle tekrar işlemeyi önleyerek eşleştirmek; vergi kapsamını doğrulamadan net gider saymamak.
- [Servis limitleri](https://developers.trendyol.com/docs/1-servis-limitleri): limitler servise göre değişir. Finans ve kargo fatura servisi için dokümanda 100 istek/dakika görülüyor; sipariş tarafında tek evrensel sayı varsayılmamalı.
- [Fatura bağlantısı gönderme](https://developers.trendyol.com/docs/fatura-linki-g%C3%B6nderme-sendinvoicelink): mevcut faturanın bağlantısını pazaryerine iletir. Fatura kesme servisiyle karıştırılmamalı.

### Hepsiburada kaynakları ve uygulama sonuçları

- [Sipariş entegrasyonu rehberi](https://developers.hepsiburada.com/tr/companies/hepsiburada?guide=siparis-entegrasyonu-onemli-bilgiler&product=siparis-olusturma-entegrasyonu&view=guide): ücretli/ödemesi tamamlanmamış sipariş ayrımı, ürün ve komisyon alanları, paket ve kargo takip akışları açıklanıyor. Bazı kargo/teslim/iptal listeleri yalnızca son bir ayı kapsıyor. Bu yüzden gelecekte düzenli arşivleme gerekir; geçmişin tamamını sonradan çekebileceğimiz söylenemez.
- [Ödemesi tamamlanan siparişler](https://developers.hepsiburada.com/tr/companies/hepsiburada?category=siparis-yonetimi&op=Get__orders_merchantid_merchantId&product=siparis-olusturma-entegrasyonu&version=v1.0&view=endpoint): kimlik doğrulama, User-Agent ve limit/offset sayfalaması kullanılır.
- [Ürün listeleme sorgusu](https://developers.hepsiburada.com/tr/companies/hepsiburada?category=baslangic&op=Listing+Bilgilerini+Sorgulama&product=listeleme&version=v1&view=endpoint): HB SKU / satıcı SKU ve güncelleme tarihleriyle listeleme sorgulanabilir. **Bizim tasarımımız:** ürün adına güvenmek yerine kalıcı kodları aynı stok kartına eşleştirmek.
- [Resmî değişiklik günlüğü](https://developers.hepsiburada.com/tr/changelogs): komisyon sorgulama servisinin varlığı doğrulandı. Bu, gelecekteki her haftanın komisyon tarifesinin önceden alınabileceğini kanıtlamaz. Güncel ayrıntılı şema ve hesap cevabı ayrıca kontrol edilmeli.
- [Resmî doküman araması](https://developers.hepsiburada.com/tr/search): muhasebe rehberi listeleniyor; bu çalışmada rehber sayfası boş döndü. Ayrıntılı finans alanlarını okumuş veya doğrulamış gibi kabul etmiyoruz.

## Barem ve otomasyon için açık kalanlar

Eylül 2026 için mağazanıza uygulanacak güncel TY/HB kargo destek tablosu doğrulanamadı. Eski resmî PDF'ler ve üçüncü taraf tabloları güncel gerçek ücret olarak sisteme yüklenmedi. Testlerde kullanılan rakamlar sentetiktir. Canlı bağlantıda tarifelerin başlangıç/bitiş tarihi, KDV kapsamı, taşıyıcı, fiyat aralığı ve desi koşulu doğrulanacak. Çekilen tek bir komisyon gözlemi geçmişteki bütün siparişlerin tarifesini değiştirmemeli.

Öncelik sırası: kimlik doğrulama ve küçük örnek yanıt → kalıcı ürün/paket eşleştirme → teslimat güncelleme → finans/kargo kayıtlarını kaynağıyla eşleştirme → fark inceleme → zamanlanmış alım. Yeniden denemeler stok veya gideri iki kez işlememeli. Her aşamanın kaynağı ve son başarılı çekim tarihi görülebilmeli.

Set satışı bileşen ve adetlerle stoktan düşer. Satış adı veya tedarikçinin alış adı farklı olsa da kalıcı ürün eşleştirmesi esas alınır. Faturada tek kalem görünen beş fiziksel çeşidin dağılımı belgede yoksa sistem bunu bilemez: tedarikçi detayı veya doğrulanmış başlangıç dağılımı gerekir. Sonraki kesin kod eşleştirmeleri otomatikleşebilir.

## Tasarım araştırması

[Inventory Management Design](https://dribbble.com/shots/24988093-CRM-Dashboard-Inventory-Management-Design) sayfası ve tasarım görseli incelendi: az sayıda öne çıkan metrik, ürün bağlamında stok/maliyet, sakin renkler ve ayrıntıya kademeli geçiş. [Profit Panel](https://dribbble.com/shots/27531675-Profit-Panel-eCommerce-Analytics-Dashboard-Design) sayfası da araştırıldı. Görseller/kodlar kopyalanmadı.

Lunapot'a uygulanan yaklaşım: dört belirgin karar alanı, tek tık tahmin, negatif sonuçların görünürlüğü, ayrıntıların açılır alanlarda tutulması, telefonda paket kartları ve tam genişlikli formlar. Mobilde yatay tabloyu okumak yerine paket bazlı özet kullanılır. Çevrimdışı durum açıkça belirtilir; çevrimdışı muhasebe işlemi sıraya alınmaz.
