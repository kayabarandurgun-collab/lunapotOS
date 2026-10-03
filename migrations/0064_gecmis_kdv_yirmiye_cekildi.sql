-- GEÇMİŞTEKİ %10 KDV'Lİ 18 SATIŞ SATIRI %20'YE ÇEKİLİR.
--
-- KARAR SAHİBİNİN: "faturaları %20 ile kesiyorum, KDV oranımız net %20" (03.10.2026). Rakamın
-- düşeceği kendisine sayıyla söylendi ve onaylandı: brüt 14.606,85 TL DEĞİŞMEZ, KDV hariç ciro
-- 13.278,97 → 12.172,38 düşer, yani o siparişlerin kârı ~1.107 TL azalır. Düzeltme rakamı
-- iyileştirmiyor, GERÇEĞE yaklaştırıyor.
--
-- NEDEN KİLİT AÇILIYOR: ec_order_line_lock, gönderilmiş/teslim edilmiş siparişin satırında tutar
-- ve KDV değişmesini yasaklar (ORDER_LOCKED) — satış defterinin değiştirilemezlik güvencesidir.
-- 18 satırın 17'si teslim edilmiş. Kural KALDIRILMIYOR: yalnız bu düzeltme için düşürülüp
-- canlıdaki tanımıyla BİREBİR geri yazılıyor. İşlem versiyonlu ve geri izlenebilir olsun diye
-- migration'dan yapılıyor; canlıya elle SQL yazılmıyor.
--
-- ÖLÇÜLDÜ: 18 satırın 17'si tek bileşenli, tek satışlı ve İADESİZ; 1'i taslak (henüz satışı yok).
-- Hiçbirinde iade yok, bu yüzden ters kayıt uyarlaması gerekmiyor.

-- 1) ÖNCE satış geliri. Satır hâlâ vat_bps=1000 ile işaretli olduğu için hangi satışların
--    düzeltileceği buradan ayırt edilir. Yalnız tek bileşenli, iadesiz ve geliri satırın netiyle
--    birebir aynı olan satışlar; başka bir şey dokunmuşsa el sürülmez.
UPDATE ec_sale_entries SET revenue_cents=(
   SELECT CAST(ROUND(l.gross_cents*10000.0/12000) AS INTEGER)
   FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id
   WHERE c.sale_id=ec_sale_entries.id)
 WHERE kind='sale' AND id IN (
   SELECT c.sale_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id
   WHERE l.vat_bps=1000 AND c.sale_id IS NOT NULL AND l.gross_cents IS NOT NULL
     AND (SELECT COUNT(*) FROM ec_order_line_components x WHERE x.line_id=l.id)=1
     AND NOT EXISTS(SELECT 1 FROM ec_sale_entries r WHERE r.parent_id=c.sale_id)
     AND (SELECT s.revenue_cents FROM ec_sale_entries s WHERE s.id=c.sale_id)=l.net_revenue_cents);

-- 2) Kilit yalnız bu iş için düşer.
DROP TRIGGER ec_order_line_lock;

UPDATE ec_order_lines SET net_revenue_cents=CAST(ROUND(gross_cents*10000.0/12000) AS INTEGER), vat_bps=2000
 WHERE vat_bps=1000 AND gross_cents IS NOT NULL;

-- 3) Kilit BİREBİR geri: canlıdaki sqlite_master tanımının kopyası. Bundan sonra gönderilmiş
--    siparişin satırı yine değiştirilemez.
CREATE TRIGGER ec_order_line_lock BEFORE UPDATE ON ec_order_lines WHEN (SELECT status FROM ec_order_packages WHERE id=OLD.package_id)!='draft' AND (NEW.product_id IS NOT OLD.product_id OR NEW.quantity_milli!=OLD.quantity_milli OR NEW.gross_cents IS NOT OLD.gross_cents OR NEW.vat_bps IS NOT OLD.vat_bps OR NEW.net_revenue_cents IS NOT OLD.net_revenue_cents OR NEW.package_id!=OLD.package_id OR NEW.external_id!=OLD.external_id OR NEW.sku!=OLD.sku OR NEW.name!=OLD.name OR OLD.sale_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'ORDER_LOCKED'); END;

INSERT INTO ec_activity(id,description) VALUES(
  '0064-gecmis-kdv',
  'Geçmişteki %10 KDV ile kayıtlı 18 satış satırı %20''ye çekildi; brüt değişmedi, KDV hariç ciro 13.278,97 TL''den 12.172,38 TL''ye indi.');
