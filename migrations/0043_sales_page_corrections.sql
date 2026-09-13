-- Satış belgesi sayfa kaydı düzeltmesi.
--
-- Neden ayrı tablo: ec_sales_document_pages satırı mühürlü bir defter kaydıdır.
-- ec_sales_doc_page_no_delete silmeyi, ec_sales_doc_page_frozen ise invoice_no/order_no
-- değişikliğini IMMUTABLE_LEDGER ile durdurur; UNIQUE(document_id,page_no) ve
-- (document_id,invoice_no) yüzünden aynı sayfa için düzeltilmiş ikinci bir satır da yazılamaz.
-- Bu yüzden düzeltme, yanlış satırın üstünü çizmeden YANINA yazılır: yanlış kayıt yerinde
-- kalır (ne yazıldığı görünür), doğru değer bu tabloda durur ve okuma tarafı doğruyu gösterir.
-- Muhasebede karşılığı: kaydı silmek değil, iptal edip yeniden beyan etmek.
CREATE TABLE ec_sales_document_page_corrections(
 id TEXT PRIMARY KEY,
 page_id TEXT NOT NULL UNIQUE REFERENCES ec_sales_document_pages(id),
 document_id TEXT NOT NULL REFERENCES ec_sales_documents(id),
 page_no INTEGER NOT NULL CHECK(page_no>0),
 -- Düzeltme anında defterde ne yazdığı. Sonradan "aslında ne yazmıştı" tartışması olmasın diye saklanır.
 wrong_invoice_no TEXT NOT NULL DEFAULT '',
 wrong_order_no TEXT NOT NULL DEFAULT '',
 invoice_no TEXT NOT NULL DEFAULT '',
 ettn TEXT NOT NULL DEFAULT '',
 order_no TEXT NOT NULL DEFAULT '',
 gross_cents INTEGER CHECK(gross_cents IS NULL OR gross_cents>=0),
 -- Düzeltmenin gerekçesi zorunlu: gerekçesiz düzeltme, düzeltme değil üstünü örtmektir.
 reason TEXT NOT NULL CHECK(length(trim(reason))>=10),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_id,page_no)
);
CREATE INDEX ec_sales_doc_page_corr_doc ON ec_sales_document_page_corrections(document_id);

-- Düzeltmenin kendisi de mühürlüdür: silinemez, değiştirilemez.
-- Yanlış bir düzeltme yapılırsa yeni bir sayfa kaydı değil, bu tablodaki hatanın
-- açıkça raporlanması gerekir; sessizce tekrar yazılamaz.
CREATE TRIGGER ec_sales_doc_corr_no_delete BEFORE DELETE ON ec_sales_document_page_corrections
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sales_doc_corr_frozen BEFORE UPDATE ON ec_sales_document_page_corrections
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Düzeltme yalnız gerçekten var olan ve gerçekten farklı olan bir satır için yazılabilir.
CREATE TRIGGER ec_sales_doc_corr_must_differ BEFORE INSERT ON ec_sales_document_page_corrections
 WHEN (SELECT invoice_no FROM ec_sales_document_pages WHERE id=NEW.page_id)=NEW.invoice_no
  AND (SELECT order_no FROM ec_sales_document_pages WHERE id=NEW.page_id)=NEW.order_no
 BEGIN SELECT RAISE(ABORT,'CORRECTION_NO_CHANGE'); END;
