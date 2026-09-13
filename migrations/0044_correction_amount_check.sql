-- 0043'teki denetim yalnız fatura ve sipariş numarasına bakıyordu; yalnız TUTARI yanlış olan
-- bir satır "değişiklik yok" sayılıp düzeltilemiyordu. Gerçek bir kayıtta bu, hatalı tutarın
-- defterde kalması demek. Denetim tutarı ve ETTN'i de kapsayacak şekilde yenilenir.
DROP TRIGGER ec_sales_doc_corr_must_differ;
CREATE TRIGGER ec_sales_doc_corr_must_differ BEFORE INSERT ON ec_sales_document_page_corrections
 WHEN (SELECT invoice_no FROM ec_sales_document_pages WHERE id=NEW.page_id)=NEW.invoice_no
  AND (SELECT order_no FROM ec_sales_document_pages WHERE id=NEW.page_id)=NEW.order_no
  AND (SELECT ettn FROM ec_sales_document_pages WHERE id=NEW.page_id)=NEW.ettn
  AND (SELECT gross_cents FROM ec_sales_document_pages WHERE id=NEW.page_id) IS NEW.gross_cents
 BEGIN SELECT RAISE(ABORT,'CORRECTION_NO_CHANGE'); END;
