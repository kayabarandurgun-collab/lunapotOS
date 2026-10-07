-- SATIŞ DIŞI GELİR (tazminat).
--
-- Kargo kaybolan bir paketi tazmin ettiğinde para işletmeye girer ama panelde yazacak yer yoktu:
-- gelir yazan tek tablo ec_sale_entries ve o stoktan ürün düşüyor (satış değil, ürün ikinci kez
-- rafın dışına çıkardı). ec_expenses de gelir tutamıyor: amount_cents CHECK(>=0) ve kategori
-- listesi şema kısıtında sabit (0002:32).
--
-- NEDEN AYRI TABLO, NEDEN "EKSİ GİDER" DEĞİL. money-planning-api.js:178 işletme sonucunun
-- durumunu `overhead.length`e bakarak veriyor: gider dizisi boşsa "Bu dönemde genel gider kaydı
-- yok, görülen katkı net kâr sayılmaz" uyarısı çıkıyor. Gelir o diziye eksi tutarla girseydi
-- dizinin uzunluğu 1 olur, uyarı SESSİZCE kaybolur ve hiç gider girilmemiş bir ay "kayıtlı"
-- görünürdü. Gelir ayrı durur, sonuca ayrıca eklenir; uyarı bozulmaz.
--
-- KDV: tazminat bir mal/hizmet teslimi değildir, kural olarak KDV'siz kesilir. Yine de oran
-- saklanabilsin diye vat_bps var; NULL = KDV yok. Mali müşavire doğrulatılmalı.
--
-- occurred_on = hakkın doğduğu gün (kargo kaybı kabul etti). received = para gerçekten geldi mi;
-- gider defterindeki `paid` ile aynı ayrım. Tahsilat kasaya Cariler ve nakit ekranından ayrıca
-- girilir; bu kayıt kasaya para yazmaz.
CREATE TABLE ec_other_income(
 id TEXT PRIMARY KEY,
 reference TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL DEFAULT 'compensation' CHECK(kind IN ('compensation','other')),
 label TEXT NOT NULL DEFAULT '',
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 vat_bps INTEGER CHECK(vat_bps IS NULL OR (vat_bps>=0 AND vat_bps<=10000)),
 occurred_on TEXT NOT NULL,
 received INTEGER NOT NULL DEFAULT 0 CHECK(received IN (0,1)),
 package_id TEXT REFERENCES ec_order_packages(id),
 notes TEXT NOT NULL DEFAULT '',
 archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- Dönem toplamı bu iki sütundan okunuyor; arşivlenmiş kayıt sonuca girmez.
CREATE INDEX ec_other_income_live ON ec_other_income(occurred_on) WHERE archived_at IS NULL;
