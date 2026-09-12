-- Kaynak kontrolü ile stok yazımı arasındaki YARIŞI kapatır.
--
-- Önceki koruma yetersizdi: rezervasyon/gönderim UPDATE'i `report_link_hash IS ?` koşuluna
-- bağlıydı, ama bu sütun SİPARİŞİN KENDİ saklı özetidir ve rapor yeniden yüklendiğinde
-- değişmez. Yani koşul her zaman tutuyordu; kontrol ile yazma arasında gelen iptal/adet
-- değişikliği sevki durdurmuyordu.
--
-- Doğru yer veritabanının kendisi: bağlı rapor kaydının İÇERİĞİ değiştiği anda sipariş
-- "kaynak değişti" olarak işaretlenir. Mevcut ec_order_transition tetikleyicisi bu işaretle
-- 'reserved'/'shipped' geçişini ABORT eder. Gönderim toplu işlemi tek transaction olduğu için
-- satış kayıtları ve stok çıkışları da birlikte geri alınır; uygulama 409 döner.
--
-- Yalnız data_json değişimi sayılır. Bağlantı kurma (erp_package_id), bileşen doldurma
-- (components_json) ve güncellik sınırı ilerletme (source_time) içerik değişikliği DEĞİLDİR
-- ve bu tetikleyicileri çalıştırmaz.
CREATE TRIGGER ec_report_record_invalidates_order
AFTER UPDATE OF data_json ON ec_report_records
WHEN NEW.erp_package_id IS NOT NULL AND NEW.data_json IS NOT OLD.data_json
BEGIN
 UPDATE ec_order_packages SET source_changed=1
 WHERE id=NEW.erp_package_id AND status IN ('draft','reserved');
END;

-- Bağlı pakete SONRADAN yeni kalem satırı gelmesi de içerik değişikliğidir.
-- Koşul: paketin kayıtlı bir içerik özeti olmalı. Özeti olmayan (eski/geçiş) bağlantılar
-- zaten uygulama katmanında koşulsuz incelemeye alınır; burada işaretlemek ilk bağlantı
-- kurulumunu yanlışlıkla bozardı.
CREATE TRIGGER ec_report_record_new_line_invalidates_order
AFTER INSERT ON ec_report_records
WHEN NEW.erp_package_id IS NOT NULL
 AND (SELECT report_link_hash FROM ec_order_packages WHERE id=NEW.erp_package_id) IS NOT NULL
BEGIN
 UPDATE ec_order_packages SET source_changed=1
 WHERE id=NEW.erp_package_id AND status IN ('draft','reserved');
END;

-- Rapora BAĞLI OLMA durumu pakette tutulur.
--
-- Neden sütun: koruma her rezervasyon/gönderimde çalışır. Bağlılığı rapor kayıtlarını
-- sorgulayarak öğrenmek, rapora hiç bağlı olmayan (elle açılan) her sipariş için de fazladan
-- bir sorgu demekti ve 20 bileşenli sevk D1'in sorgu bütçesini aşıyordu. Bayrak sayesinde
-- bağlı olmayan sipariş SIFIR ek sorguyla geçer; bağlı olan yine tek sorgu kullanır.
--
-- 1 = bu paket en az bir pazaryeri rapor kaydına bağlı. Bağlantı kurulduğunda tetikleyiciyle
-- yazılır ve geri alınmaz: bağlantı kaydı silinemez olduğu için bayrağın düşmesi gerekmez.
ALTER TABLE ec_order_packages ADD COLUMN report_linked INTEGER NOT NULL DEFAULT 0 CHECK(report_linked IN (0,1));

CREATE TRIGGER ec_report_record_marks_link AFTER UPDATE OF erp_package_id ON ec_report_records
WHEN NEW.erp_package_id IS NOT NULL
BEGIN UPDATE ec_order_packages SET report_linked=1 WHERE id=NEW.erp_package_id AND report_linked=0; END;

CREATE TRIGGER ec_report_record_marks_link_insert AFTER INSERT ON ec_report_records
WHEN NEW.erp_package_id IS NOT NULL
BEGIN UPDATE ec_order_packages SET report_linked=1 WHERE id=NEW.erp_package_id AND report_linked=0; END;

-- Geçiş: migration öncesinde kurulmuş bağlantılar da işaretlenir.
UPDATE ec_order_packages SET report_linked=1
WHERE id IN (SELECT erp_package_id FROM ec_report_records WHERE erp_package_id IS NOT NULL);
