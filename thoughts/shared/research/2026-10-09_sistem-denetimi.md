# Sistem denetimi — 2026-10-09

Yöntem: yerel önizleme (gerçek kod, sahte veri) üzerinde her ekran gezildi, düğmeler basıldı, matematik sayfadaki rakamlarla elle doğrulandı; canlı panelde (muhasebe.lunapot.com) yalnız salt okunur bakıldı, hiçbir kayıt değiştirilmedi. Kapsam: E-ticaret 24 ekran, Üretim 21 ekran, Atölye, Ekip/erişim, mağaza, mobil 375px.

## Sonuç tek cümle

Matematik her yerde tutuyor; hata olarak bulduğum şeyler **etiket ve sunum** sorunları. Asıl riskler veri tarafında: ödeme takvimi vadesiz borçları saymıyor, genel gider hiç girilmemiş, bir ürün eksi stokta.

## Düzeltilecekler (kod)

| # | Ne | Nerede | Etki |
|---|---|---|---|
| 1 | Komisyon etiketi "KDV hariç satışa" diyor, hesap KDV dahil fiyat üzerinden (30,24 = %14 × 216) | `public/fiyat-hesap-ui.js:15` | Yanlış açıklama; hesap doğru |
| 2 | Sipariş detayı: kargodaki paketin dökümü KDV hariç (₺60), teslim edilenin KDV dahil (₺72). Aynı ekranda iki taban | sipariş detayı "Paran nereye gidiyor" | "Her yerde KDV dahil" kuralına aykırı |
| 3 | Satış kayıtları tablosunda sütunlar katkıya toplanmıyor; her satırda 6 TL "diğer gider" gizli | `public/accounting-ui.js:244` | Okuyan toplamı tutturamıyor |
| 4 | `/favicon.ico` ve `/apple-touch-icon.png` yok → her sayfada 404 | `public/` | Konsol gürültüsü; canlıda da var |
| 5 | Ödeme takvimi vadesiz faturaları dönem toplamına almıyor (canlıda Seçkin 3.840 + Tropikal 6.750 görünmüyor) | ödeme takvimi özet kartı | Kullanıcı "bu ay 62k" sanır, gerçek 73k+ |
| 6 | Mağaza adresi ziyaretçiye ham JSON dönüyor | `/magaza/` | Düşük (mağaza kapalı) |
| 7 | Mobilde durum çipleri yatay kayıyor ama ipucu yok | `.ol-chip` şeridi | Düşük |

## Sorular (kod hatası değil, açıklama gerek)

- Genel durum "Kargoda 43 paket", Siparişler "Kargoda 51" — 8 fark; iki ekran aynı kelimeyi farklı kapsamla kullanıyor olabilir.
- Siparişlerde kâr 34 + zarar 8 = 42, toplam 43 — bir sipariş sonuç filtresine girmiyor, etiketi yok.
- Fiyat planı "cebine kalan" ambalaj+diğer gideri düşüyor (53,16), sipariş ekranı düşmüyor (64,56). Aynı kavram, iki tanım.
- Genel durum "Hazırlanan 3 paket ₺65,24" — paket başı ~22 TL, kargodakilerin ortalaması 60 TL.
- Teklif ekranı boş durumda "Yeniden dene" düğmesi gösteriyor; hata yokken neden?

## Canlı veri bulguları (dokunulmadı)

| | |
|---|---|
| Eksi stok | **Gartengold Organik Torf 20 L** (GG-TORF-20L, Karakuş): kayıtlı −3, kargoda 2. Önce "depodan çıkanı düzelt" sorusu. |
| Genel gider | **Hiç tanımlı değil.** Kira/personel/reklam yok → "İşletme sonucu" hep "bilgi eksik", panel net kârı bilmiyor. Bir kez sabit gider tanımla, "Eksik ayları oluştur" de. |
| Kargo maliyeti | 74.251 TL, komisyondan (55.838) büyük; cironun **%24**'ü. TY marjı %10, HB %14,8. |
| Zarar eden paket | 939'un 135'i (%14), toplam −4.442. TY'de 83, HB'de 52. |
| Üretim alanı | Canlıda **boş** (0 ürün, 0 reçete). 21 ekran kullanılmıyor. |
| Kesinti faturaları | Hiç dağıtılmamış; kesintiler rapordan geliyor, belgeli değil. |
| Cloudflare | Her sayfaya analitik beacon + Google Tag Manager enjekte ediliyor, CSP engelliyor. Cloudflare panelinden kapatılmalı ya da CSP'ye eklenmeli. |

## Doğrulanan matematik

- Genel durum (canlı): 308.285,76 − 129.478,80 − 143.787,59 = 35.019,37; TY 22.417,58 + HB 12.601,79 = aynı; 804 kârlı + 135 zararlı = aynı; tüm zamanlar 41.851,50.
- Cari (canlı): borcum 76.825,20 = Tropikal 69.445,20 + Seçkin 7.380,00.
- Siparişler (canlı): 0+3+51+1094+11 = 1159.
- Fiyat planı: 216 → 53,16; başabaş 154,19; hedef 100 → 270,47. Sipariş kesintisiyle tutarlı.
- Reçete: 742,56/10 = 74,26; %30 marj → 106,08; KDV'li 127,30.
- Hammadde deposu 11.803,80; depo bakiyeleri kayıtlı − ayrılan = kullanılabilir.

## Güvenlik ve davranış

- "Sil" düğmeleri modal açıyor, kullanılmış kartı reddediyor; yanlış tıklama riski yok.
- Service worker canlıda aktif; önizlemedeki kayıt hatası ortama özgü.
- Mobilde hiçbir ekran yana kaymıyor.
- Yetki sistemi: tutar görmeyen personel örneği, rol ön ayarları, cihaz unutma çalışıyor.

## Tam gezinti kaydı

Ham notlar oturum scratchpad'inde; bu dosya onların süzülmüş hâli.
