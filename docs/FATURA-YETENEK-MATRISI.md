# Fatura yetenek matrisi

**Hazırlayan:** Claude Code oturumu · **Tarih:** 10 Eylül 2026
**Amaç:** Fatura çekme/kesme yeteneklerinin gerçekte nerede durduğunu kanıtla göstermek.

Üç kavram bu belgede ayrı tutulur:

| Etiket | Anlamı |
|---|---|
| **Kod var** | Depoda ilgili istek/ayrıştırma kodu bulunuyor. Çalıştığı anlamına gelmez. |
| **Sentetik test** | Yerel sahte veri veya sentetik SQLite ile test edildi. |
| **Sağlayıcı ortamında doğrulandı** | Sağlayıcının test veya canlı ortamında gerçek yanıtla doğrulandı. |

**Bu turda hiçbir satır "sağlayıcı ortamında doğrulandı" değildir.** Gerçek aktivasyon kullanıcıyla yapılacak sonraki aşamada.

---

## 1. Depodaki mevcut kod

| Yetenek | Dosya | Durum | Not |
|---|---|---|---|
| Trendyol finans kayıtları (settlements, otherfinancials) | `src/integrations.js` | Kod var · sentetik test | Salt okunur önizleme. `configured:false` çünkü sunucuda anahtar yok. Yapılandırılmadan çağrı **409** döner (test edildi) |
| Trendyol sipariş çekme | `src/connections-api.js` | Kod var | `apigw.trendyol.com/integration/order/sellers/…` |
| Hepsiburada sipariş / finans / komisyon | `src/connections-api.js` | Kod var · **kapalı** | `available:false`. `oms-external`, `mpfinance-external`, `listing-external` uçları kodda tanımlı |
| EDM | — | **Yok** | Kodda EDM için tanımlı tek bir uç bile yok; yalnızca `available:false` listesinde adı geçiyor |
| UBL fatura XML içe aktarma | `public/invoice-import.js` | Kod var · sentetik test | Tarayıcıda `DOMParser` ile UBL `Invoice` ayrıştırma; 2 MB sınırı, `DOCTYPE`/`ENTITY` reddi |
| **Fatura kesme / gönderme** | — | **Yok** | Hiçbir yerde giden fatura oluşturma veya gönderme kodu yok. Yerel "satış faturası taslağı" resmî belge değildir |

---

## 2. Resmî kaynaklardan doğrulananlar

### Trendyol — müşteri fatura bağlantısı gönderme

Kaynak: [developers.trendyol.com · sendInvoiceLink](https://developers.trendyol.com/reference/sendinvoicelink) (erişim 10 Eylül 2026)

- Uç: `POST https://apigw.trendyol.com/integration/sellers/{sellerId}/seller-invoice-links`
- **Test ortamı var:** `https://stageapigw.trendyol.com/integration/sellers/{sellerId}/seller-invoice-links`
- Alanlar: `invoiceLink`, `shipmentPackageId`, `invoiceDateTime`, `invoiceNumber`
- Mikro ihracat paketlerinde `invoiceNumber` ve `invoiceDateTime` zorunlu; diğerlerinde isteğe bağlı
- Trendyol müşteriye satıcının verdiği **bağlantıyı** e-postayla gönderir
- Bağlantının yasal olarak **8 yıl** erişilebilir kalması gerekir

**Sonuç:** Trendyol faturayı kesmez. Faturayı biz üretip erişilebilir bir adreste tutmak zorundayız. Yani bu uç tek başına "fatura kesme" değildir; e-fatura üretimi ayrıca gerekir.

### GİB — doğrudan entegrasyon yöntemi

Kaynak: [e-Fatura Uygulaması Entegrasyon Kılavuzu v1.10, Haziran 2018](https://www.edmbilisim.com.tr/uploads/EditorDosya/e-faturauygulamasientegrasyonkilavuzu-v1_10.pdf) (erişim 10 Eylül 2026; metin `pypdf` ile çıkarıldı)

Kılavuzun doğruladıkları:

- Mimari: **Merkez**, **Posta Kutusu**, **Gönderici Birim**. İletişim HTTPS + SOAP, MTOM
- Belgeler UBL-TR; imzalanan/onaylanan XML **ZIP**lenip **ZARF** (`StandardBusinessDocument`) içinde gönderilir
- **Sistem Yanıtı** (zarf durumu) ve **Uygulama Yanıtı** (ticari senaryoda KABUL/RED) ayrı kavramlar
- Ticari senaryoda uygulama yanıtı faturayı aldıktan sonra **8 gün** içinde dönülmeli; bir fatura için birden çok uygulama yanıtı gelirse **ilki** kabul edilmeli
- Kayıtlı kullanıcı listesi: `merkez.efatura.gov.tr/EFaturaMerkez/userList.jsp` (canlı), `merkeztest.efatura.gov.tr/…` (test)
- Ön koşullar: **BİS raporu**, **Test Tanım Formu**, sabit sunucu/istemci **IP adresleri**, güvenilir **SSL sertifikası**, GİB e-fatura Test Planı'nın geçilmesi
- Canlı ortam IP adresleri test ortamı IP adresleriyle **aynı olamaz**

**Bu kılavuzda somut web servis metod adları yok** — onlar "Ek-3 Yazılım Standartları ve Nesne Yapısı" ve WSDL eklerinde. O ekler bu turda elde edilmedi; metod adı **tahmin edilmedi**.

**Sonuç:** Doğrudan GİB entegrasyonu Cloudflare Workers üzerinde çalışan bu panel için uygun değil. Sabit IP kaydı, mali mühür/e-imza ile XML imzalama ve resmî test süreci gerekiyor; bunların hiçbiri Worker ortamında karşılanamaz.

### EDM — özel entegratör

- EDM'in kendi web servis geliştirici dokümanı **herkese açık değil**. Aramada çıkan sayfalar üçüncü taraf e-ticaret platformlarının kendi entegrasyon anlatımları.
- Doğrulanan tek şey: EDM web servis **kullanıcı adı/şifresi ve test servis adresleri sözleşme sonrası** veriliyor; Portal ve Servis'e aynı anda erişim için kullanıcıya **"CONNECTOR"** yetkisi tanımlanması gerekiyor.
- Kaynak: [EDM Bilişim entegrasyon anlatımları](https://www.edmbilisim.com.tr/blog/ozel-entegrator.html) ve platform yardım sayfaları (erişim 10 Eylül 2026)

**Erişemediğim şey:** EDM'in gerçek WSDL'i, metod adları, taslak oluşturma/durum sorgulama/iptal uçları. Oturum ve sözleşme gerektiriyor. **Bu uçlar tahmin edilmedi ve koda yazılmadı.**

### Hepsiburada

Kodda uçlar var ama bu turda resmî dokümanla karşılaştırılmadı; `available:false` durumu korundu.

---

## 3. Eksik ön koşullar

| Ön koşul | Kimde | Not |
|---|---|---|
| EDM sözleşmesi + web servis kullanıcı/şifre + test adresi | Kullanıcı | Sözleşme olmadan doküman ve uç yok |
| EDM "CONNECTOR" yetkisi | Kullanıcı → EDM | Portal + Servis erişimi için |
| Mali mühür / e-imza | Kullanıcı | XML imzalama; Worker ortamında yapılamaz, entegratör tarafında çözülür |
| Trendyol satıcı anahtarları | Kullanıcı | `TRENDYOL_SELLER_ID`, `TRENDYOL_API_KEY`, `TRENDYOL_API_SECRET` |
| Faturanın 8 yıl erişilebilir barındırılması | Karar gerekli | Trendyol fatura bağlantısı için yasal koşul |
| Hepsiburada satıcı anahtarları | Kullanıcı | Uçlar kodda hazır, doğrulama yapılmadı |

---

## 4. Bu oturumun kendi araçları

Plan "kendi becerilerini gerçekten incele" dediği için ayrıca belirtiyorum:

| Araç | Var mı | Bu iş için anlamı |
|---|---|---|
| `WebSearch` / `WebFetch` | Var | Resmî dokümanları araştırmak için kullanıldı; oturum gerektiren sayfalara erişilemez |
| PDF metin çıkarma (`pypdf`) | Var | GİB kılavuzu bununla okundu |
| Tarayıcı sürüşü (uygulama içi ve Chrome) | Var | Yerel arayüz doğrulaması için kullanılıyor |
| `anthropic-skills:pdf`, `:docx`, `:xlsx` becerileri | Katalogda var | **Bunlar benim yerel dosya üretmem içindir.** Panelin çalışma anında belge üretmesini sağlamazlar; panel kendi üretim kodunu içermek zorundadır |
| Cloudflare Workers kimliği (`wrangler`) | Var | Yalnızca alan adı hesabı |

Bu oturumda **başka bir ajanın** skill kataloğu kendi kataloğum sayılmadı; olmayan bir beceri adı kullanılmadı.

---

## 5. Bu turda ne yapıldı, ne yapılmadı

**Yapılan:** mevcut kodun envanteri; Trendyol fatura bağlantısı ucunun ve test ortamının resmî kaynaktan doğrulanması; GİB doğrudan entegrasyon ön koşullarının kılavuzdan çıkarılması; EDM erişim engelinin tespiti.

**Yapılmayan (bilerek):** gerçek fatura çekme, kesme veya gönderme; herhangi bir sağlayıcıya canlı istek; anahtar tanımlama; tahmine dayalı uç yazımı.

**Sonraki aşama için öneri:** Fatura kesme yolu EDM üzerinden gitmeli. Kullanıcı sözleşme ve CONNECTOR yetkisini tamamladığında EDM'in kendi dokümanı okunup adaptör kapalı özellik olarak yazılabilir. Trendyol tarafında ilk somut adım `sendInvoiceLink`'in **stage** ortamında denenmesidir; bunun için önce faturanın kendisinin üretilip erişilebilir barındırılması çözülmelidir.
