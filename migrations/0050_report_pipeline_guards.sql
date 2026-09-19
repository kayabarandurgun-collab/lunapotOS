-- Rapor hattı korumaları (Codex sorun/çözüm raporu R01, R05, R06, R24 — 19 Eylül 2026).
--
-- Hepsi YENİ tablo/tetik; eski satırlara dokunulmaz, veri taşınmaz. Eski worker bu tabloları hiç
-- kullanmaz: yeni tablolar boş kaldıkça davranış birebir aynıdır. Önce bu geçiş, sonra kod yayınlanır.
-- Wrangler SQL ayrıştırıcısı tetik içindeki CASE…END'i bozduğu için koşullar iif() ile yazılır.

-- 1) YAZMA ÖNCESİ DOĞRULAMA (R01, R06). D1'de etkileşimli işlem yok; yalnız db.batch([...]) bütündür.
-- Partinin başına "okuduğum durum hâlâ bu mu?" sorusunu soran bir INSERT … SELECT … WHERE <eskidi>
-- konur: durum değişmişse tek satır eklenmeye çalışılır, tetik bütün partiyi geri alır (hiçbir yazma
-- kalmaz); değişmemişse hiç satır eklenmez. Tablo hiçbir zaman satır tutmaz.
CREATE TABLE ec_report_write_guard(code TEXT NOT NULL);
CREATE TRIGGER ec_report_write_guard_abort BEFORE INSERT ON ec_report_write_guard BEGIN
 SELECT RAISE(ABORT,'REPORT_STALE_WRITE');
END;

-- 2) TASLAK TAZELEME İZİ (R06). Rapora bağlı TASLAK siparişte (stok hareketi yok) rapor tutarı/KDV'si
-- değişirse satır eşitlenir; eski ve yeni satırlar burada değiştirilemez biçimde saklanır.
-- seq: aynı paketin kaçıncı tazelemesi; aynı durumdan iki paralel tazeleme ikinci satırı yazamaz.
CREATE TABLE ec_report_draft_refreshes(
 id TEXT PRIMARY KEY,
 package_id TEXT NOT NULL REFERENCES ec_order_packages(id),
 seq INTEGER NOT NULL CHECK(seq>0),
 old_hash TEXT,
 new_hash TEXT NOT NULL,
 old_lines_json TEXT NOT NULL,
 new_lines_json TEXT NOT NULL,
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(package_id,seq)
);
CREATE TRIGGER ec_report_draft_refresh_no_update BEFORE UPDATE ON ec_report_draft_refreshes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_draft_refresh_no_delete BEFORE DELETE ON ec_report_draft_refreshes BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- 3) GEÇİCİ SAYIM TELAFİSİ GÖNDERİMLE BİRLİKTE (R05).
-- Ürün siparişten SONRA rafta geçici sayıldıysa, satış kaydedilince raf eksik görünmesin diye sayım
-- satılan adet kadar artırılır. Bu artış önceden rezervasyondan ÖNCE yazılıyordu: sipariş yalnız
-- hazırlanıp iptal edilirse ya da ayırma başarısız olursa stok fazladan artmış kalıyordu.
-- Şimdi rapor aktarımı yalnız NİYETİ yazar (stok değişmez). Artış, paket 'reserved' → 'shipped'
-- geçtiği AN aynı işlemin içinde yazılır: gönderim yoksa telafi yoktur, gönderim geri alınırsa
-- telafi de geri alınır, gönderim bir kez olduğu için telafi de bir kez olur.
CREATE TABLE ec_report_count_offsets(
 id TEXT PRIMARY KEY,
 package_id TEXT NOT NULL REFERENCES ec_order_packages(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 count_movement_id TEXT NOT NULL REFERENCES ec_stock_movements(id),
 quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
 value_cents INTEGER NOT NULL CHECK(value_cents>=0),
 reference TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 occurred_on TEXT NOT NULL,
 applied_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(package_id,product_id)
);
CREATE INDEX ec_report_count_offsets_open ON ec_report_count_offsets(package_id) WHERE applied_at IS NULL;
-- Yalnız uygulanma işareti bir kez konabilir; niyetin kendisi değişmez, silinmez.
CREATE TRIGGER ec_report_count_offset_lock BEFORE UPDATE ON ec_report_count_offsets
 WHEN OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL OR NEW.package_id!=OLD.package_id OR NEW.product_id!=OLD.product_id
  OR NEW.quantity_milli!=OLD.quantity_milli OR NEW.value_cents!=OLD.value_cents OR NEW.reference!=OLD.reference OR NEW.occurred_on!=OLD.occurred_on BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_LEDGER');
END;
CREATE TRIGGER ec_report_count_offset_no_delete BEFORE DELETE ON ec_report_count_offsets BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Gönderim anı: bekleyen telafiler sayım hareketi olarak yazılır (aynı referans ikinci kez yazılmaz).
CREATE TRIGGER ec_report_count_offset_on_ship AFTER UPDATE OF status ON ec_order_packages
 WHEN OLD.status='reserved' AND NEW.status='shipped' BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
  SELECT 'sayim-telafi-'||o.id,o.product_id,o.quantity_milli,o.value_cents,'count',o.reference,o.notes,o.occurred_on
  FROM ec_report_count_offsets o WHERE o.package_id=NEW.id AND o.applied_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM ec_stock_movements m WHERE m.kind='count' AND m.reference=o.reference AND m.product_id=o.product_id);
 UPDATE ec_report_count_offsets SET applied_at=CURRENT_TIMESTAMP WHERE package_id=NEW.id AND applied_at IS NULL;
END;
-- Stok ayırma denetimi: 0045'teki tetik birebir, tek fark şu: BU paketin gönderimde yazılacak
-- telafisi ayırma kapasitesine sayılır. Sayım satıştan sonraki rafı gösterdiğinde (mal sayımdan önce
-- gitmiş) raf siparişten küçük olabilir; telafi gönderimde geldiği için ayırma buna bakar.
-- Telafi niyeti yalnız raporda kargoya verilmiş paket için yazılır; eski worker hiç yazmaz (fark 0).
DROP TRIGGER ec_order_reserve_validate;
CREATE TRIGGER ec_order_reserve_validate BEFORE UPDATE OF status ON ec_order_packages WHEN NEW.status='reserved' AND OLD.status!='reserved' BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id) OR EXISTS(SELECT 1 FROM ec_order_lines l WHERE l.package_id=NEW.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM ec_order_line_components c WHERE c.line_id=l.id)!=10000),RAISE(ABORT,'ORDER_UNMAPPED'),NULL);
 SELECT iif((SELECT COUNT(*) FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=NEW.id)>20,RAISE(ABORT,'ORDER_COMPONENT_LIMIT'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id AND net_revenue_cents IS NULL),RAISE(ABORT,'ORDER_MISSING_AMOUNT'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_products p ON p.id=c.product_id WHERE l.package_id=NEW.id AND c.stock_unit!=p.stock_unit),RAISE(ABORT,'ORDER_UNIT_CHANGED'),NULL);
 SELECT iif(COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0)=0 AND EXISTS(SELECT c.product_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_stock_balances b ON b.product_id=c.product_id WHERE l.package_id=NEW.id GROUP BY c.product_id HAVING SUM(c.quantity_milli)+COALESCE((SELECT SUM(r.quantity_milli) FROM ec_order_reservations r WHERE r.product_id=c.product_id AND r.released_on IS NULL),0)>b.quantity_milli+COALESCE((SELECT SUM(o.quantity_milli) FROM ec_report_count_offsets o WHERE o.package_id=NEW.id AND o.product_id=c.product_id AND o.applied_at IS NULL),0)),RAISE(ABORT,'ORDER_INSUFFICIENT_STOCK'),NULL);
END;

-- 4) OTOMATİK BAKIM DENEMELERİ (R24). Hata veren rapor dosyası silinmez, "işlendi" sayılmaz; kaç kez
-- denendiği, son hatası ve bir sonraki deneme zamanı burada görünür. Bakım her turda önce hiç hata
-- vermemiş dosyaları alır, hatalıları bekleme süresi dolunca yeniden dener: ilk 10 dosyanın sürekli
-- hata vermesi 11. sağlıklı dosyayı engellemez.
CREATE TABLE ec_report_file_attempts(
 file_id TEXT PRIMARY KEY REFERENCES ec_report_files(id),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error TEXT,
 last_attempt_at TEXT,
 next_attempt_at TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ec_report_file_attempts_next ON ec_report_file_attempts(next_attempt_at);
