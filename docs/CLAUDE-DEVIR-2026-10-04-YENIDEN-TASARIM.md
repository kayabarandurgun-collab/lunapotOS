# Lunapot — yeniden tasarım ve hesaplama incelemesi

Tarih: 4 Ekim 2026. Repo: C:/Users/baran/Desktop/site/lunapot-panel. Başlangıç HEAD: 6400642.

## Kullanıcının talebi
Önceki v173 değişikliği kullanıcı tarafından yetersiz bulundu. İstenen renk düzeltmesi değil: işlerin bulunabildiği, masaüstü ve telefonda kullanılabilir, tutarlı bir arayüz; ayrıca hesaplama ve işleyişte gerçek hata incelemesi. Canlıya alma daha önce açıkça yetkilendirildi. Müşteri carileri otomatik açılmayacak. Depoda set sayımı istenmeyecek; fiziksel bileşen stokları ve satılan biçimin kârı ayrı kavramlar.

## Tasarım kararı ve kaynaklar
Beyaz gezinme, soğuk açık zemin, koyu para özeti ve tek kobalt işlem rengi. Tek kaynak tasarım ölçüleri; özellik stillerinin kendi başlarına ortak renkleri değiştirmesi kaldırıldı. Şablon ya da görsel taklidi yerine gerçek mevcut verilere bağlanan çalışma ekranları.

İncelenen birincil kaynaklar:
- https://linear.app/now/how-we-redesigned-the-linear-ui
- https://linear.app/now/behind-the-latest-design-refresh
- https://orbit.polar.sh/
- https://github.com/polarsource/polar

Figma eklentisi bulunup bağlantısı önerildi; bağlantı teyit edilmedi. Figma belgesi kullanıldığı iddia edilmez.

## Ortak mimari ve arayüz
- workspace-design.css yeniden yazıldı ve beş uygulama HTML dosyasında en son yüklenen ortak temel oldu. commerce-workflows ve insights-design içindeki çakışan yerel renk tanımları kaldırıldı. Üretim, cari ve personel stilleri ortak değişkenlere bağlandı.
- Masaüstünde alan seçimi sol menüye yerleşti. Telefonda Menü üzerinden açılır. Yeni işlem ve arama üst çubuktan erişilebilir; izinli işlemler aynı daily-actions kaynağından gelir.
- Ana ekran: kısa dört işlem şeridi, tek tarih/kapsam satırı, koyu nakit sonucu, gerçek dönem grafiği. İade ve hesaplama açıklamaları tek açılır kapsam bölümünde; eksik/tahmini durumu görünür kalır. Satış biçimi sıralaması isteğe bağlıdır. Grafik hesap verisiyle çizilir, dekoratif veri yoktur.
- Cari: sabit bölüm listesi, içerik çalışma yüzeyi; telefonda yatay sekmeler. Yinelenen cari ekleme düğmesi ve sürekli tekrar eden açıklama kaldırıldı. Satırın arşiv/sil/düzenle işlemleri Diğer altında. Hiçbir cari veya parasal kayıt oluşturulmadı.
- Uygulama girişi: dekoratif çizimlerin yerine gerçek işlere ve çalışma alanlarına açık girişler.

## İş ekranlarının yeniden kuruluşu
- Depo: marka kutuları yerine tek envanter listesi, telefon ekranında fiziksel depo miktarı öncelikli. Maliyet ve satış payı ayrıntıda; faturasız giriş ve sayım iki ayrı işlem. Marka gruplamasının miktar sıralamasını bozması da düzeltildi.
- Alış: yeni belge ile geçmiş ayrı; PDF/XML/elle giriş yolları, belge inceleme çalışma masası, yükle/kontrol/tamamla aşamaları.
- Raporlar: yükleme alanı, son dosyalar, inceleme ve sonuç sekmeleri; dosyanın gerçek hatası ve tekrar deneme görünür.
- Siparişler: durum, arama ve ilk paket önde; ek filtreler açılır; telefonda kanal seçimi dar alana uyar.
- Satış ve kâr: tek tarih ve arama çubuğu, açılır filtreler, ilk ekranda parasal özet. Set/bileşen ayrımı ve toplam mutabakatı korunur.
- Üretim/hammadde: gerçekleşen kayıtlar, miktarlar ve işlem yolları; yinelenen liste araçları kaldırıldı.
- Ekip: çalışan, hesap/cihaz, kurtarma ve erişim geçmişi ayrı; çalışan düzenleme ve geri dönüş odağı korundu.
- Web mağaza yönetimi: gerçek test kayıtlarından iş listesi; bilinmeyen sayılar sıfır yapılmaz, test/gerçek ayrımı belirgin.

## Kanıtlanıp düzeltilen hesap ve işlem sorunları
Aşağıdaki rakamlar yerel sentetik karşı örneklerdir; canlıda bu büyüklükte hata bulunduğu iddiası değildir.

| Konu | Önce → Sonra |
|---|---|
| Farklı alış KDV'li set maliyeti | 240 TL → 230 TL; 480 TL satışta kalan 240 → 250 TL |
| Paket kesintisi kuruş dağılımı | 2 kuruş üç satırda 3 oluyordu → toplam 2 kalır |
| Kısmen bilinen paket gideri | 7 + 5 = 12 → 7 + 3 = 10 kuruş |
| Stopaj payı | −1,−1,−1,+1 → −1,−1,0,0 kuruş |
| Başabaş önerisi | 50 kuruşta −1 zarar → 51 kuruşta 0 |
| Tahminin dayanağı | Onaysız kesinti geçmişi gerçek örnek sayılmıyor |
| Eşzamanlı sipariş aktarımı | 2 istenmeyen paket → 1; aynı kaynak tekrarı aynı kimliği döndürür |
| Fatura belge/sayfa eşleştirmesi | Farklı belgelerin sayfa 1'leri karışmıyor; yarışta sahte iki başarı yok |
| Fatura kimliği | Başarısız yükleme mevcut ETTN'yi silemiyor; sayfa tekrarı güvenli |
| Güncel kesintiyi koruma | Eski 80 TL hesap yeni 30 TL'yi ezemiyor; yanlış denetim satırı oluşmuyor |

Yeni finans regresyonları 14/14, yeni operasyon regresyonları 15/15. Bunlar tüm muhasebenin kusursuz olduğuna dair sertifika değildir; gösterilmiş kusurların kapatılmasıdır.

## Modül raporları
Teknik ayrıntılar aşağıdaki inceleme dosyalarında. Ajan raporları ara test anlarını da içerir; son birleşik sonuç için bu ana rapor esas alınmalı:
- UX-2026-10-03-REBUILD-financial.md
- UX-2026-10-03-REBUILD-operations.md
- UX-2026-10-03-REBUILD-stock-purchase.md
- UX-2026-10-03-REBUILD-reports-orders.md
- UX-2026-10-04-REBUILD-secondary.md

## Doğrulama / yayın
Tam birim/entegrasyon paketi: **1166 toplam, 1144 geçti, 22 ortam koşullu atlandı, 0 hata**. Bu atlananların tarayıcı kapsamı ayrıca etkinleştirilerek doğrulanır. Yayın derlemesi başarılı. Genel gezinme taraması: 69 rota × 2 genişlik = 138 ekran, 45 HTTP kontrolü; taşma/JS/HTTP hatası bulunmadı. Bu tarama bütün formların uçtan uca sınandığı anlamına gelmez.

Son birleşik tarayıcı doğrulaması: **229/229 başarılı, 0 atlama, 0 hata**. 18 dosyalık koşu yeni backend başlatıldıktan sonra yapıldı; rapor/sipariş, stok/fatura, satış biçimleri, ekip, üretim, mağaza, çevrimdışı kabuk, klavye, odağın geri dönmesi, geç yanıtlar, izinler ve boş/eksik/hatalı durumları kapsar. Son 22 ilk ekran görüntüsü ayrıca yenilendi; taşma veya JavaScript hatası yok.

Uygulama yerel commit: **db4c397**, 60 kaynak/test dosyası. Sürüm canlıda ve aşağıdaki kontrollerle doğrulandı. Sentetik ilk ekran görüntüleri docs/ux-rebuild-2026-10-04/final altında. Canlıya deneme siparişi, fatura veya ödeme yazılmadı.

## Önceden kalan sınırlar
- v173 ile 0065 migration zaten canlıya uygulandı; bu uygulanmış dosya değiştirilmemeli.
- GitHub main push önceki turda otomatik onay denetimince engellendi. Bu turda kısıt aşılmayacak; doğrudan Cloudflare yayın izni main push izni olarak yorumlanmıyor.
- Web mağaza gerçek tahsilat ve satışa açılmadı.
- Yeni HB/EDM 66 fatura handoff dosyası önceki canlı sürüm bilgisini taşıyor; kod değiştirilmemiş ayrı bir kullanıcı işi. Bu faturalar üzerinde işlem yapılmadı.

## Veri etkisi ve sınırlar
- Bu sürümde yeni migration yok; 0065 korunuyor. Tarihsel hareketler yeniden yazılmadı.
- Yeni hesaplar okunduğunda geçmiş rapor/tahmin görünümü değişebilir. Eksik alış KDV'si ve onaysız kesinti örnekleri tahmin kapsamını azaltabilir; bilinmeyen tutar 0 yapılmaz.
- Eski mükerrer sipariş/fatura kimliği/yanlış kesintilerin canlıda oluşup oluşmadığı bu çalışmada ölçülmedi ve geriye dönük otomatik tamir yapılmadı.
- Kesinti aktarım koruması mevcut parti başına atomiktir; büyük aktarımın önceki başarılı partileri korunur, tekrar güvenlidir.
- Test tarayıcısı gerçek Worker kodunu sentetik SQLite verisiyle çalıştırdı. Mobil kontrol masaüstü Chrome'un küçük ekran görünümüdür; fiziksel iOS/Android cihaz testi değildir.
- Canlı giriş yapılmış kullanıcı hesabıyla tam iş akışı testi yapılmadı. Canlı yayın doğrulaması sürüm, varlıklar ve oturum koruması üzerinden yapılır.

## Tekrar doğrulama kanıtları
- docs/ux-rebuild-2026-10-04/full-test-final.log — 1144 geçen test / 22 koşullu
- docs/ux-rebuild-2026-10-04/browser-final-verified.log — 229 geçen tarayıcı kontrolü
- docs/ux-rebuild-2026-10-04/build-final.log — son derleme
- docs/ux-rebuild-2026-10-04/all-pages/audit.json — 138 ekran genel rota taraması
- docs/ux-rebuild-2026-10-04/final/layout.json — son 22 ekran
- Ara koşularda görülen eski yerleşim beklentileri yeni etkileşim yollarıyla güncellendi; parasal/yetki assertionları azaltılmadı. Sipariş sıralama alanının mobilde 36px olması gerçek kaynak düzeltmesiyle 44px yapıldı.
- Rapor dosyası araması mevcut API'nin son 100 dosyasıyla sınırlı; arama ekranı bunu belirtir. Bu sürüm sınırsız tarihsel rapor araması eklemez.

## Canlı yayın — doğrulandı
- Alan: https://muhasebe.lunapot.com/eticaret/#overview
- Yerel saat: 4 Ekim 2026 00:35–00:36 (Europe/Istanbul).
- Önbellek: lunapot-shell-v174-workbench.
- Uygulama commit: db4c397.
- Cloudflare sürümü: 38de9600-4d84-45cf-bdc4-3f80b0a2836b, trafiğin %100'ü.
- Yayın kaydı: 1d3e2222-a8d1-4d7c-b3a2-b3ada676faa2.
- Gerçek DB bağlantısı yayın öncesi sürüm metadatasından ae7a9444-838e-4d0f-b547-ce01c23f0328 olarak doğrulandı. CLI özetindeki sıfırlı preview ID gerçek sürüm DB bağlantısı değildir. RELEASE_MAINTENANCE=0.
- 18 salt okunur canlı kontrol başarılı: beş uygulama yolu 200, anonim oturum durumu doğru, korumalı kâr API'si 401; 11 temel UI/önbellek dosyasının SHA-256 özeti yereldeki doğrulanmış dosyayla aynı.
- Bir önceki geri dönüş sürümü: a8fd7992-690e-4ae2-a1ea-46942b979f5e (v173, aynı 0065 şeması). Eski 0065 öncesi Worker'a gelişigüzel dönülmemeli.
- Yeni SQL migration, stok/satış/cari kaydı, test faturası veya ödeme canlıya yazılmadı. Normal mevcut zamanlanmış işler çalışmaya devam eder.

## Claude'a aktarırken
- Tek dosya: docs/CLAUDE-DEVIR-2026-10-04-TAM-RAPOR.txt. Ana raporu ve beş teknik modül raporunu içerir.
- Doğru çalışma deposu C:/Users/baran/Desktop/site/lunapot-panel. Documents/Codex altındaki eski kopyadan devam etmeyin.
- GitHub main push önceki otomatik onay denetiminde ortak ana dalı ve olası otomatik yayını değiştirdiği için engellendi; bu engel aşılmadı ve bu turda push denenmedi. Değişiklikler yerel commitlerde ve Cloudflare'da. Claude bulutta çalışacaksa uzak deponun aynı kodu içerdiğini varsaymamalı.
- .node-version, scripts/migrate-remote.mjs ve diğer önceden mevcut kullanıcı dosyaları bu değişikliğe dahil edilmedi.
- Yerel sentetik önizleme kapatıldıktan sonra gerekirse node scripts/design-preview.mjs --port=18731 ile tekrar başlatılabilir. Canlı anahtar kullanmaz.
- Figma bağlantısı tamamlanmadığından Figma belgesi düzenlenmedi. Araştırma kaynakları ve yerel tasarım uygulaması yukarıdadır.
