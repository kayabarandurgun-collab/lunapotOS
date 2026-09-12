-- Rapora bağlı siparişin kaynak kontrolü ARTIK STOK EYLEMİNDE yapılır, önizlemede değil.
--
-- `report_link_hash`, bağlantı kurulduğu anda paketin kanonik içerik özetidir (sürümlü: "v2:").
-- Kapsamı: kalem kimliği, ÜRÜN KİMLİĞİ (barkod + satıcı stok kodu), adet, tutar ve durum.
-- Adet ve tutar aynı kalsa bile ürün değiştiyse özet değişir.
--
-- NULL = bu sipariş bir rapora bağlı değildir (elle veya sağlayıcı akışından gelen sipariş);
-- bu durumda kontrol uygulanmaz. NULL "karşılaştırma başarılı" anlamına GELMEZ.
--
-- Rezervasyon ve gönderim güncellemeleri bu sütuna koşullanır: okunan değer yazma anında
-- değişmişse satır güncellenmez ve işlem 409 ile durur.
ALTER TABLE ec_order_packages ADD COLUMN report_link_hash TEXT;
CREATE INDEX ec_order_packages_report_link ON ec_order_packages(report_link_hash) WHERE report_link_hash IS NOT NULL;
