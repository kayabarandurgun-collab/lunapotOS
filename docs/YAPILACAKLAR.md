# Yapılacaklar

Son güncelleme: 2026-09-24

## Şu an yapılıyor (ajanlar çalışıyor)

- [ ] Otomatik senkron (cron) + panelde "yazmadan dene" düğmesi
- [ ] Kart zorunluluğu sonrası test güncellemeleri
- [ ] **Genel gider düzenle/sil** + **stok kartı sil/arşivle**
- [ ] **Ürün ailesi arşivleme**

## Sırada (dosya çakışması bitince başlar)

- [ ] **Cari düzenle/sil/birleştir** ve **kasa/banka hesabı düzenle/sil** (`src/ledger-api.js` boşalınca)
- [ ] **Satış kayıtları sayfasına sayfalama** (`public/accounting-ui.js` boşalınca) — canlıda ölçüldü: 1255 satır, 20.137 DOM öğesi, 2509 düğme tek seferde basılıyor, sayfalama yok
- [ ] **Seçkin ödemesinin kasası** — 11.760,00 TL, `ODEME-b039f268c6411d215e66838a`. Artık "var olan ödemeye bağla" ile düzeltilebilir; yayın sonrası yapılacak
- [ ] **Hakediş kasaya girmiyor** — "Raporlardan hakediş" yalnız gösteriyor, kayıt oluşturmuyor. Ana Kasa −105.331,20 TL çünkü yalnız çıkışlar yazılıyor

## Canlı denetim sonucu — düzeltilebilirlik tablosu

| Sayfa | Satırda yapılabilen | Durum |
|---|---|---|
| Ürünler ve setler | Düzenle · Arşivle | tam |
| Genel giderler | hiçbir şey ("İşlem" sütunu yok) | yapılıyor |
| Cariler | yalnız "Hesabı incele" | sırada |
| Stok kartları | yalnız "Bağlantıları gör" | yapılıyor |
| Kasa/banka hesapları | yalnız ekleme | sırada |
| Ürün aileleri | hiçbir şey | yapılıyor |
| Alış faturaları | "İncele →" | **kasıtlı** — defter kaydı, ters kayıtla düzeltilir |
| Stok hareketleri | — | **kasıtlı** — defter |

## Trendyol entegrasyonu — bugün tamamlandı

- [x] Dört engel düzeltildi: `redirect:'error'` (Cloudflare kabul etmiyor), `supplierId:0` (her sipariş yabancı sanılıyordu), yanıt sayfa boyutu 50'de takılıydı, satır durumu saklanmıyordu
- [x] "Yazmadan dene" (önizleme) modu
- [x] Teslim onayı — sipariş numarasıyla eşleşiyor, belirsizse dokunmuyor
- [x] Mükerrer paket önleme — sistemde olan sipariş için ikinci paket açılmıyor
- [x] **Gerçek senkron çalıştırıldı**: 592 sipariş kaydı, 58 paket teslim işaretlendi, 539 sipariş tanındı, 19 yeni taslak, 506 finans kaydı
- [x] Sonuç: teslim edilmiş paket 348 → 406, kârı hesaplanan 342 → 408, **toplam kâr 15.508 → 17.676 TL**, komisyonu bilinen 333 → 408

## Bugün canlıya alınan diğer işler

- [x] Telegram bildirimi (rapor işlenince özet, hatada ayrı kanal) — iki kanal da gerçek mesajla doğrulandı
- [x] Açık borç listesinde tek ödeme etiketi
- [x] Faturasız mal girişinde silme düğmesi hizası
- [x] Alış faturaları sayfasındaki 99px taşma (flex-shrink)
- [x] Ürün bağlantısı modalı: pay toplamı canlı gösteriliyor, %100 değilken kaydet kapalı, yeni satıra pay otomatik dağıtılıyor, ürün adı tam görünüyor
- [x] Ödemede kasa zorunlu (nakit, havale, kart) + var olan ödemeye kasa bağlama

## Eski açık işler

- [ ] **Ay sonu — Seçkin TS1 / Plug Mix**: 2 adet Plug Mix iadesi + yeni TS1 faturası. Alış faturaları → YSK2026000000402 → "Tedarikçiye iade" 2 adet. SONRA `urun-duzeltme:plugmix-ts1-2026-09-23` referanslı stok hareketleri ters kayıtla geri alınmalı, yoksa 2 adet çift sayılır.
- [ ] **HB kargo tarifesi**: 400–599,99 bandı 139,19 → 130,39; 1000 TL+ bandı 268,79 → 230,99 (126 teslim paketten ölçüldü). Onay verilmedi.
- [ ] **Bütün tarifeler 31.12.2026'da bitiyor** — sonrasında fiyat hesaplanamaz. Aralık'ta hatırlat.
- [ ] **Ürün ölçüleri sahte**: 27 HB ürününün hepsi 10x10x10 cm / 1 kg.
- [ ] **Genel giderler girilmedi** (canlıda 1 kayıt / 152,45 TL). Girilene kadar "kâr" brüt katkıdır.
- [ ] **Hepsiburada API'si hiç denenmedi**, kimlik bilgisi alınmadı.
- [ ] **Komisyon farkı 514,96 TL** (278 siparişte, hepsi aynı yönde). %47'si paketten çıkarılan satırlar, %31'i indirim farkı. Birkaç hafta sonra aynı siparişlere tekrar bak.
- [ ] **Güvenlik G10/G11** bilerek açık.
