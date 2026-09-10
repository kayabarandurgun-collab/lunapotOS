# Web Mağaza — devir ve satışa hazırlık

10 Eylül 2026. Bu çalışma yalnızca yerel ortamda hazırlandı. Codex canlıya yayın, Git push, gerçek tahsilat, fatura veya gerçek müşteri mesajı göndermedi. Son kontrol sırasında diğer çalışma 2b7d31d / 5a97057 mutabakat commitlerini oluşturmuştu. src/scoped-db.js ve 0025_offers.sql teklif çalışmasına aittir; Codex bunları değiştirmedi.

## Açılışlar

- Mevcut tasarım önizlemesi: http://127.0.0.1:8795/
- Ayrı mağaza / arama / kategori: http://127.0.0.1:8795/magaza.html
- Müşteri hesabı: http://127.0.0.1:8795/hesabim.html
- Yasal bilgiler: http://127.0.0.1:8795/yasal.html
- Birleşik yerel uygulamalar: http://127.0.0.1:8796/
- Yönetim modülü: http://127.0.0.1:8796/webmagaza/
- Aynı Worker üzerindeki mağaza kopyası: http://127.0.0.1:8796/magaza/
- Yerel test yönetici bilgileri: work/WEB-MAGAZA-TEST-GIRISI.txt. Gitignore kapsamındadır; canlı hesap değildir. Şifreleri belgelere/repoya kopyalamayın.

Önizleme kaynağı ../lunapot-store-preview; panelde public/magaza dağıtım kopyası var. Kaynakta değişiklik yapılırsa scripts/sync-store-preview.mjs ile açık liste kopyalanır. Sunucu/API kaynağı lunapot-panel içindedir.

## Tamamlanan yerel akış

Ana sayfada manuel/otomatik 3 sahneli, duraklatılabilen, azaltılmış hareket tercihini dikkate alan açılış; 4 seçili ürün; form/doku anlatımı; tamamlayıcı toprak seçkisi. Kategori, arama ve favoriler ayrı magaza.html üzerinde çalışır. Satış verisi olmadan çok satan veya yorum sayısı uydurulmaz.

Müşteri kayıt/giriş/çıkış, şifre değişimi, teslimat ve ayrı fatura adresi, sunucu fiyatıyla 15 dakikalık sipariş özeti, ön bilgilendirme ve sözleşme kabulü, salt okunur sipariş nüshası, idempotent sipariş, stok rezervasyonu, test ödeme başarı/başarısızlık, kargo takibi, indirilebilir sözleşme TXT, destek/cayma/kişisel veri talepleri.

Yönetimde Web Mağaza uygulama kartı: özet, sayfalı sipariş/müşteri/talep listeleri, arama, durum süzgeci, sipariş detayı, sevk ve takip no, test katalog fiyat/miktar düzenleme (yalnızca yönetici), talep durumları, satışa hazırlık.

## Veri ve güvenlik sınırları

- Migration 0024_webshop.sql: ws_* tabloları ayrıdır. ec_* / lp_* defterlerine veya gerçek stoklara yazılmaz. Test siparişleri is_test=1 SQL kısıtı taşır. Test ödeme demo_paid olarak ayrı tutulur; gerçek tahsilat/kâr diye gösterilmez.
- Sipariş oluşturma + tüm kalemler + stok ayırma aynı D1 batch işlemindedir. CHECK stok negatifliğini engeller; kayıtlardan biri hata verirse hepsi geri döner. Tek quote_id yalnızca tek sipariş oluşturabilir.
- İptal stoğu yalnızca ilk durum geçişinde geri verir. 30 dakika ödeme bekleyen yeni test siparişi sonraki müşteri API etkinliğinde otomatik iptal edilip stoğu bırakır. Planlı üretim temizliği/cron henüz yoktur.
- Sözleşme, fiyat ve adres snapshot alanları SQL trigger ile değiştirilemez. Yeni metin sürümü eski sipariş nüshasını değiştirmez.
- Müşteri oturumu ws_customer HttpOnly / SameSite=Strict (HTTPS üzerinde Secure). Yönetici oturumu farklıdır. PBKDF2 mevcut ortak yardımcıyı kullanır. Origin/JSON denetimi ve giriş/kayıt/talep hız sınırları vardır.
- Personelde ec.webshop özel izni gerekir; eski genel ec erişimi otomatik olarak bu modülü açmaz. ec.amounts yoksa paralar null, para içeren sözleşme metni yönetici yanıtından çıkarılır. Müşteri kendi siparişine sahiplik denetiminden sonra erişir.
- WS_MODE=demo yalnızca localhost/127.0.0.1 hostunda yazma açar. Canlı hostta müşteri ve test ödeme mutasyonları 503 verir. Üretim wrangler.jsonc dosyasına demo modu/anahtar eklenmedi.
- Reklam/analitik/pazarlama servisi eklenmedi; zorunlu olmayan çerez yüklenmez. KVKK aydınlatması pazarlama veya üyelik onayıyla birleştirilmez. Müşteri kişisel bilgileri sessionStorage/localStorage'a yazılmaz; yalnızca sepet/favori ürün seçimleri sekme deposundadır.
- Mevcut admin/personel API'sinden bağımsız müşteri API'si /api/store/*; personel API'si /api/webshop/*. Kendi yönetim modülü /webmagaza/. Kamuya açık API hiçbir yönetici oturumunu müşteri oturumu saymaz.
- Web mağaza ve API cevapları PWA çalışma alanı önbelleğine alınmaz.

## Henüz tamamlanmayan gerçek satış işleri — hazır diye sunmayın

1. Gerçek iyzico/diğer sağlayıcı entegrasyonu henüz yazılıp bağlanmadı. Şu an yalnızca açıkça etiketli yerel ödeme simülasyonu var; kart alanı yok. Merchant/sandbox hesabı, callback alan adı, sunucu sırları, imza doğrulaması, sağlayıcıdan bağımsız sorguyla teyit, tutar/para birimi/sipariş eşleştirmesi, idempotent tahsilat/iade ve gerçek sandbox testi gerekiyor. Tarayıcı başarı dönüşü tek başına tahsilat sayılamaz.
2. E-posta doğrulama, şifre sıfırlama ve sipariş/sözleşme bildirim gönderimi için servis bağlantısı yok. Üye şifre değişimi çalışır; sıfırlama yok. Sipariş nüshası hesaptan indirilebilir, e-postayla kalıcı nüsha teslimi henüz kurulmadı.
3. Katalog örnek fiyat/ölçü/miktar taşır. Gerçek ürün özellikleri, KDV dahil fiyatlar, sevk bedeli, taşıyıcı/iade adresi ve üretim/depo stok kartlarıyla eşleme tamamlanmalı. Mevcut ws_catalog rezervasyonu yalnızca test stoğudur.
4. Şirket kayıtları eski siteden alındı: unvan, adres, VKN/MERSİS/sicil, e-posta ve telefon. KEP ve oda bilgileri teyitsiz. ETBİS kaydı/bildirimi, e-ticaret satıcı bilgi yükümlülükleri ve ödeme kuruluşu hesabı işletme tarafında doğrulanmalı; sahte ETBİS/güven damgası yok.
5. KVKK metinleri taslaktır. Canlı veri akışına göre saklama süreleri, başvuru kimlik doğrulaması, veri işleyenler, Cloudflare yurt dışı aktarım mekanizması ve gerekiyorsa kayıt/bildirimler kesinleştirilmeli. Genel rıza kutusu bu sürecin yerine geçmez. Pazarlama açılacaksa ayrı isteğe bağlı izin ve İYS/ret süreci gerekir.
6. Yasal taslaklar işletmenin kesin ticari koşullarıyla ve uygun uzman kontrolüyle sonlandırılmalı; her metnin sürümü güncellenmeli. Gerçek satışa geçiş yeni migration + entegrasyon ve güvenlik kontrolü gerektirir; tek bir bayrakla gerçek ödeme açılmaz.
7. Yeni modül, migration ve mağaza henüz commit/push/yayın yapılmadı. Eşzamanlı Claude teklif/mutabakat değişikliklerini karıştırmadan gözden geçirilmeli. Yeni modülün gerçek personel kapsamı ayrı permission anahtarıyla yönetilir; ec grubu içinde listelense de verileri pazaryerinden ayrıdır.

## Resmî kaynaklar — 10 Eylül 2026 kontrolü

- Ticaret Bakanlığı güncel mesafeli sözleşme bilgilendirmesi (17 Ağustos 2026): https://tuketici.ticaret.gov.tr/yayinlar/tuketici-bilgi-rehberi/mesafeli-sozlesmeler-hakkinda-bilgilendirme
- Elektronik ticaret satıcı bilgileri / işlem rehberi / ETBİS: https://ticaret.gov.tr/ic-ticaret/sikca-sorulan-sorular/elektronik-ticaret
- ETBİS: https://ticaret.gov.tr/ic-ticaret/bilgi-sistemleri/elektronik-ticaret-bilgi-sistemi-etbis-ve-e-ticaret-bilgi-platformu
- KVKK aydınlatma: https://www.kvkk.gov.tr/Icerik/6765/AYDINLATMA-YUKUMLULUGUNUN-YERINE-GETIRILMESI-HAKKINDA-KAMUOYU-DUYURUSU
- Çerez rehberi: https://www.kvkk.gov.tr/Icerik/7353/Cerez-Uygulamalari-Hakkinda-Rehber
- Yurt dışı aktarım standart sözleşmeleri: https://www.kvkk.gov.tr/Icerik/7938/Standart-Sozlesmeler-ve-Baglayici-Sirket-Kurallarina-Iliskin-Dokumanlar-Hakkinda-Kamuoyu-Duyurusu
- İYS: https://ticaret.gov.tr/ic-ticaret/ticari-elektronik-iletiler/ileti-yonetim-sistemi-iys
- iyzico CF başlatma (sonraki entegrasyon için): https://docs.iyzico.com/odeme-metotlari/odeme-formu/cf-entegrasyonu/cf-baslatma
- iyzico sonuç sorgulama (sonraki entegrasyon için): https://docs.iyzico.com/en/payment-methods/direct-charge/checkoutform/cf-implementation/cf-retrieve

## Kontrol kanıtları

- Son tam test: 210/210 geçti (work/webshop-full-tests.txt). Ek 7 Web Mağaza testi: müşteri izolasyonu, CSRF, canlı host kapısı, fiyat, stok yarışı/rollback, tekrar işlem, sözleşme değişmezliği, test ödeme, cayma, şifre değişimi, gerçek personel oturumu ve tutar gizleme, sevk geçişleri, ödeme süresi dolumu.
- Cloudflare dry-run build geçti (work/webshop-build.txt). Yeni kod dist/worker.js içinde doğrulandı; yayın yapılmadı.
- ../lunapot-store-preview/work/commerce-browser-checks.json: ana sayfa, kategori rotası, kayıt, farklı fatura adresi/güncelleme, özet, sipariş, ödeme simülasyonu, belge indirme, cayma kaydı; 5 sayfa × 4 genişlik, hata yok.
- ../lunapot-store-preview/work/checkout-mobile-checks.json: 390/320 px adres ve sipariş onayı, masaüstü onayı, otomatik hero ve duraklatma, hata yok.
- work/webshop-browser-checks.json: gerçek yerel yönetici girişi, sipariş hazırlama, kargo/takip, müşteri/talep/katalog/hazırlık, 768/390/320 px, Worker CSP altında mağaza ve yasal sayfa, hata yok.
- Mağaza, hesap, sipariş özeti ve dashboard ekran görüntüleri görsel incelendi.

## Yerel ortamı yeniden açmak

work/wrangler-webshop.json yalnızca yerel test yapılandırması ve kurulum anahtarı taşır; Git'e alınmaz. Ayrı veritabanı .wrangler/webshop-local dizininde. Mevcut .wrangler/state veya .wrangler/deneme silinmedi.

Node ile node_modules/wrangler/bin/wrangler.js dev --config work/wrangler-webshop.json --persist-to .wrangler/webshop-local --port 8796 --ip 127.0.0.1

Önizleme için ../lunapot-store-preview/server.cjs 8795 portunda çalışır; yalnızca /api/store/* taleplerini 8796'ya aynı kaynak denetimiyle aktarır. work dosyaları sunulmaz.
