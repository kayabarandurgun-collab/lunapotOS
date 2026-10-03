-- TEK SEFERLİK TEMİZLİK: okunamayan bir taramanın yetim kaydı siliniyor.
--
-- NE OLDU: 30.09.2026'da "krkş.pdf" yüklendi. Harf taşımayan (yazısı çizim olarak gömülü) bir
-- belgeydi; görüntüden okuma denendi, fatura numarası güvenilir okunamadı ve belge hiçbir faturaya
-- işlenmedi. 03.10.2026'da aynı faturanın GİB'den gelen, harf taşıyan PDF'i yüklendi ve sorunsuz
-- muhasebeleşti (KRK2026000000927). Eski kayıt ortalıkta "yarım kalmış iş" gibi kaldı.
--
-- NEDEN MIGRATION: alış belgeleri BİLEREK silinemez yapılmıştır (ec_purchase_doc_no_delete,
-- ec_purchase_doc_chunk_no_delete — "IMMUTABLE_LEDGER"). Belge, faturanın kanıtıdır. Bu kural
-- KALDIRILMIYOR: aşağıda yalnız bu tek kayıt için geçici olarak düşürülüp AYNEN geri yazılıyor.
-- Böylece işlem versiyonlu, kayıtlı ve geri izlenebilir olur; canlıya elle SQL yazılmaz.
--
-- GÜVENLİK: silme yalnız BU kimliğe ve YALNIZ faturaya bağlı değilse uygulanır. Belge bu arada
-- bir faturaya bağlanmışsa (invoice_id dolu) hiçbir satır silinmez ve kanıt zinciri korunur.
-- Sayfa bağı da aranır: sayfası bir faturaya bağlanmış belge kanıttır, dokunulmaz.
DROP TRIGGER ec_purchase_doc_chunk_no_delete;
DROP TRIGGER ec_purchase_doc_no_delete;

DELETE FROM ec_purchase_document_chunks WHERE document_id='2ee69a35-a1bb-4b9c-a9fc-2edd06d60b44'
  AND EXISTS(SELECT 1 FROM ec_purchase_documents d WHERE d.id='2ee69a35-a1bb-4b9c-a9fc-2edd06d60b44'
    AND d.invoice_id IS NULL AND d.filename='krkş.pdf'
    AND NOT EXISTS(SELECT 1 FROM ec_purchase_document_pages p WHERE p.document_id=d.id));

DELETE FROM ec_purchase_documents WHERE id='2ee69a35-a1bb-4b9c-a9fc-2edd06d60b44'
  AND invoice_id IS NULL AND filename='krkş.pdf'
  AND NOT EXISTS(SELECT 1 FROM ec_purchase_document_pages p WHERE p.document_id='2ee69a35-a1bb-4b9c-a9fc-2edd06d60b44');

-- Koruma AYNEN geri: bundan sonra hiçbir alış belgesi silinemez (canlıdaki tanımın birebir kopyası).
CREATE TRIGGER ec_purchase_doc_chunk_no_delete BEFORE DELETE ON ec_purchase_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_purchase_doc_no_delete BEFORE DELETE ON ec_purchase_documents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

INSERT INTO ec_activity(id,description) VALUES(
  '0062-krks-silindi',
  'Okunamayan taramanın yetim kaydı silindi (krkş.pdf); aynı fatura KRK2026000000927 ile düzgün belgeden muhasebeleşti.');
