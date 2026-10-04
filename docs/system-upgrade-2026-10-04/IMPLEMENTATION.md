# Lunapot — işletme çalışma alanı uygulaması (4 Ekim 2026)

Kullanıcının iki görsel referansı ve tüm sistemsel iyileştirme onayıyla uygulandı. Gerçek depo sayımı fiziksel ürünler üzerinden yürür; set sayımı yapılmaz. Pazaryeri alıcılarından otomatik müşteri carisi açılmaz.

## Kullanım
- **Belge yükle:** PDF, UBL XML, JPG/PNG veya XLSX/CSV seç. İçerik tanınır; fatura/raporun mevcut kontrol ve kayıt akışına aynı dosya aktarılır. Belirsiz tablo türünü seçersin. Kaydedilmiş eksik belgeler Günlük işler bölümünden devam eder.
- **Günlük işler:** Kontrol bekleyen belge, rapor, fatura, teslimat ve siparişler; personele atama, tarih, not, erteleme. Kendi işlerini de ekleyebilirsin. Kaynak sorun çözülmeden sahte tamamlandı kaydı konmaz.
- **Cariler ve nakit → Cari dosyası:** İletişim kişileri, adresler, vergi dairesi, banka bilgileri, etiketler, ödeme/teslim koşulları, sorumlu kişi; fatura/ödeme/ürün geçmişi, hatırlatmalar, PDF ve fotoğraf ekleri. Temel unvan/vergi numarası mevcut cari düzenleme formundan değiştirilir.
- **Depomdaki ürünler → Sayım ve tedarik:** Rafındaki ürünleri say. Ayrılan ürünler depodadır; kargodakiler dışarıdadır. Kaydet, başka cihazdan devam et, farkları incele ve uygula. Sayılmayan ürünler sıfırlanmaz. Arada stok değişirse tekrar sayım istenir. Artış maliyeti bilinmiyorsa değer uydurulmaz.
- **Ürün dosyası:** Fiziksel stok, ayrılan/kargodaki miktar, hareketler, alış geçmişi, bağlantılı ilan/set ve tedarik hazırlığı. Set kapasitesi ortak bileşenlere göre alternatif kapasitedir; birbirine eklenmez.
- **Ödeme takvimi:** Beklenen vadeler ile gerçekleşmiş kasa/banka hareketleri ayrıdır. Tarihi bilinmeyen kayıtlar ayrı durur. Yalnız doğrulanmış banka eşleşmesi banka onaylı sayılır.
- **İşletme sonucu:** Sonuçlanan pazaryeri paketlerinin ortak hesap motorundaki katkısından kayıtlı genel giderler düşülür. Eksik/tahmini veri belirtilir. Bu bir vergi sonrası şirket net kârı değildir.

## Tasarım
Yakın siyah, yazılı menü; beyaz çalışma alanı; adaçayı, mavi, lavanta ve bal tonlarında veri kartları. Mobil alt menü: Özet / Yükle / Depo / İşler / Menü. Ana işlemler doğrudan erişilir; diğer kayıtlar grupludur. Para/kimlik bilgileri personel yetkilerine göre korunur. Eski genel header stilinin içerik başlıklarına taşarak mobil üst üste binmeye yol açması kökten düzeltildi. Kontroller ortak boyut/yarıçap/yazı ölçeğindedir.

## Güvenilirlik
0066 cari dosyası, 0067 depo akışları, 0068 görev/audit tabloları ekler. Önceki muhasebe kayıtları yeniden yazılmaz. Çoklu sayımın tamamı aynı işlemde uygulanır; eski stok görüntüsü, birim değişikliği, yeni rezervasyon ve tekrarlanan uygulama korunur. Cari/görev eşzamanlı düzenlemeleri sürüm denetimiyle çatışır; dosya parçaları doğrulanıp mühürlenir. Ekibin yetki sınırı sunucuda da uygulanır. Küçük iş yedeği yeni metaverileri kapsar; ham ek dosyalar tam D1 yedeğinde korunur.

Bağımsız inceleme üç gerçek hatayı ortaya çıkardı ve değişmeyen testlerle düzeltmeleri doğruladı: sayım kaybında küsurat yuvarlaması, ürün birimi değiştiğinde eski birime göre tekrar sayım, takvimde ilgisiz eski ödeme kayıtlarının sınırı doldurması. İkinci bağımsız inceleme cari/görev yetkisi, çalışma alanı ayrımı, eşzamanlılık ve işlem geri dönüşünü doğruladı.

## Doğrulama
- Genel test: 1.256 toplam; 1.229 geçti, 0 hata. 27 isteğe bağlı tarayıcı testi varsayılan komutta kapalıdır; ilgili tarayıcı akışları ayrıca açılarak çalıştırıldı.
- Yeni yazma akışlarının son gerçek tarayıcı testi: 7/7 geçti (cari, ek dosya, sayım, dosya aktarımı, görev ve kaynak işlemleri). Yalnız sentetik yerel veritabanı kullanıldı.
- Genel görsel tarama: 81 adres × masaüstü/telefon = 162 ekran; 0 yükleme/taşma/JavaScript hatası. Ayrı bütünleşik kontrol 320/390/1440 genişliklerini kapsar. Örnek ekranlar görsel olarak ayrıca incelendi.
- Dolu 0065 şemasından 0066–0068 geçişi: eski tabloların içeriği değişmedi; Wrangler ayırıcısı, yabancı anahtarlar ve SQLite bütünlüğü doğrulandı.
- Son derleme başarılı. Uygulama harici servis çağrıları sentetik testlerde engellendi.
- Kanıtlar bu klasördeki final-unit-tests.log, final-write-browser-tests.log, final-read-browser-tests.log, all-pages.log, final-build.log ve ekran görüntülerinde.

## Bilinen kapsam ve harici gereksinimler
- Toplu kayıtlı sayım e-ticaret deposundadır. Üretim/hammadde sayımı mevcut kendi ekranlarında devam eder; EC/LP cari ve ürün dosyaları ayrıdır.
- Tedarik önerisi son 30 günlük net sevk, minimum stok ve girilen tedarik/paket süresine dayanır; otomatik satın alma siparişi açmaz.
- İşletme sonucu mevcut TY/HB sonuçlanan paket kapsamındadır; web mağaza/diğer kanal/LP satışlarını eksiksiz şirket finansal tablosu gibi sunmaz. Genel giderlerin doğruluğu girilen kayıtlara bağlıdır.
- Takvim bugünkü açık borçlardan plan çıkarır; geçmiş gün sonu bakiyesini yeniden kurmaz. En çok 366 günlük aralık, 25.000 ilgili kaynak sınırında açık hata; sessiz eksik toplam yoktur.
- E-belge/OCR/banka sağlayıcı hesapları ve bağlantı anahtarları bu çalışma kapsamında uydurulmadı. Var olan bağlantılar korunur. Gerçek banka akışı veya e-belge servisi için mevcut sağlayıcının yapılandırması gerekir.
- Ek dosyalar PDF/PNG/JPEG, 5 MiB/dosya, 100 dosya/50 MiB/cari. Yarım yüklemeler devam ettirilebilir; silme/temizleme arayüzü yoktur.
- Dossier hatırlatmaları cari kartında saklanır ve gösterilir; harici bildirim servisi kurulmadı.
- Sayfa yenilenmeden henüz sunucuya yüklenmemiş dosya yalnız açık ekranın belleğindedir; sayfayı kapatırsan yeniden seçersin.
- Canlıda sentetik işlem yapılmaz; yayın sonrası doğrulama salt okumadır.

## Geliştirici devam bilgileri
Asıl depo: C:/Users/baran/Desktop/site/lunapot-panel. Documents/Codex/.../outputs kopyası eski; oradan çalışma. Başlangıç HEAD9282b24, canlıv174. Bu çalışma öncesi kullanıcıya ait .node-version ve scripts/migrate-remote.mjs düzenlemeleri aynen korundu. Eski .Codex/.claude ve diğer sahipsiz dosyalara dokunulmadı.
Modül sözleşmeleri: cari.md, warehouse.md, money.md, workflows.md. Bağımsız rapor: review.md. İlk plan: PLAN.md.
Yayın bilgisi ve canlı doğrulama sonucu ayrı RELEASE.md dosyasına işlenecek. Önceki GitHub main push otomatik onay engeli aşılmadı; bu tur uzak Git dalına gönderim yapılmıyor.
