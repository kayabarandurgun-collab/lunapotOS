# Düzeltilmiş stok tablosu — 2026-10-05

Canlı panelden okundu (salt okuma). **Panel** = şu an ekranda görünen. **Hayalet** = raf sayımı
telafisinden gelen fazlalık. **Gerçek** = rafta olması gereken.

Doğrulama: Perlit 10 L için gerçek 28 çıkıyor, elle saydın **26-27**. Orkide Toprağı için gerçek
151, sen **~140** dedin. İki üründe de tutuyor.

**Toplam hayalet: 398 adet · 15 ürün etkilenmiş**

## Hayalet stoku olan ürünler

| Ürün | Panel | Hayalet | **Gerçek** |
|---|---:|---:|---:|
| Tropikal Orkide Toprağı 3 L | 264 | 113 | **151** |
| Tropikal Orkide Bitki Besini 225 ml | 229 | 108 | **121** |
| Tropikal Yaprak Temizleyici 250 ml | 157 | 102 | **55** |
| Tropikal Genel Bitki Besini 225 ml | 71 | 24 | **47** |
| Tropikal Perlit Karışımlı Bitki Toprağı 10 L | 43 | 15 | **28** |
| Tropikal Genel Bitki Besini 1000 ml | 22 | 10 | **12** |
| Tropikal Yaprak Parlatıcı 750 ml | 11 | 6 | **5** |
| Tropikal Kaktüs ve Sukulent Bitki Besini 225 ml | −10 | 4 | **−14** |
| Tropikal Yeşil Yapraklı Bitki Besini 225 ml | 12 | 4 | **8** |
| Tropikal Çiçek Açan Bitki Besini 225 ml | 14 | 4 | **10** |
| Klasmann TS1 Torf 210 L | 1 | 2 | **−1** |
| Tropikal Orkide Bitki Besini 1000 ml | 10 | 2 | **8** |
| Tropikal Çiçek Açan Bitki Besini 1000 ml | 22 | 2 | **20** |
| Tropikal Perlit Karışımlı Bitki Toprağı 5 L | 9 | 1 | **8** |
| Tropikal Orkide Bitki Besini 500 ml | 13 | 1 | **12** |

Hepsi Tropikal (+ 1 Klasmann), çünkü faturasız giriş orada yapılıyor.

## Girişi eksik olan ürünler (gerçek stok eksi)

Bunlarda satılan mal var ama girişi hiç kaydedilmemiş. Faturasız giriş yapılması gerekiyor:

| Ürün | Gerçek stok | Eksik giriş |
|---|---:|---:|
| **Tropikal Kaktüs ve Sukulent Bitki Besini 225 ml** | −14 | **en az 14 adet** |
| Klasmann TS1 Torf 210 L | −1 | 1 adet (bugünün 2. satışı düşünce 2 olabilir) |
| Gartengold Genel Kullanım Organik Torf 10 L | −1 | 1 adet |

Kaktüs Besini'nin hızlı erimesinin sebebi: bir Trendyol ilanı **5'li paket**
("Kaktüs Sukulent Besini 5 Adet 225 Ml", ₺229) ve eşleştirme doğru — her satışta 5 adet düşüyor.

## Hayaletsiz ürünler (panel doğru)

Gartengold ailesi, Klasmann Potgrond H/P, Plug Mix, Pina Small ve diğer Tropikal kalemlerinde
hayalet yok; panel rakamı doğru.

## Seçkin borcu — senin beklentinle birebir aynı

| Belge | Tarih | Adet | Tutar |
|---|---|---:|---:|
| 000002 | 30.09 | 1 | ₺1.680 |
| 0000879 | 05.10 | 2 | ₺3.840 |
| **Toplam** | | **3** | **₺5.520** |

Cari bakiye −₺5.520, ödenen 0. Ay başı ödemeyi yaptığında kaydedilecek.

## Hatanın sebebi

Panelin iki parçası aynı kaydı farklı anlıyor:

1. `src/ledger-api.js:380` — "Faturasız mal girişi"ne yazdığın **irsaliye miktarını**
   `sayım` (count) olarak kaydediyor.
2. `src/report-stock-link-api.js:429` — o kaydı **raf sayımı** sanıyor. Kendi yorumu:
   *"o sayım satıştan SONRAKİ rafı gösterir. Satış şimdi stoktan düşülürse raf eksik görünür."*
   Bu yüzden arada satılan miktarı geri ekliyor.

Gelen miktar + satılan miktar = fazla stok. Telafi hareketleri
`GECICI-SAYIM-<belge>-SAT-<paket>` referansıyla tanınıyor.

**Not:** telafi hareketi değer de taşıyor, yani hayalet adet aynı zamanda hayalet stok değeri
demek — maliyet ve kâr da etkilenmiş olabilir. Tasarım çalışmasında ölçülüyor.
