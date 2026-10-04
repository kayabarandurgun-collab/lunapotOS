-- Faturasız mal girişi cari ekranından TERS KAYDEDİLEMEZ.
--
-- Sebep: giriş hem cari borcu hem de stok hareketini yazar (ledger-api.js:366-375).
-- /api/ledger/reverse yalnız cari satırını terslerdi; stok hareketi yerinde kalır ve
-- 0065'teki eligible hesabı reversed=1 olduğu için o satırı bir daha asla "uygun"
-- saymaz. Korumalar yalnız eligible=0'a baktığından, o tedarikçi + ürün ikilisinde
-- BÜTÜN gelecek alış faturaları PROVISIONAL_LEGACY_UNLINKED ile reddedilir ve
-- panelden çıkış yolu kalmaz (proofs görünümü ters kayıtları dışlıyor, başlık da
-- ec_provisional_header_no_update ile değiştirilemiyor).
--
-- Korumayı GEVŞETMEK yanlış olurdu: stok hareketi gerçekten ortada duruyor, fatura
-- işlenirse mal iki kez sayılır. Doğru çözüm tuzağın KURULMASINI engellemek.
-- Mevcut ec_provisional_entry_reverse_guard yalnız 'gecici-fatura:%' kapamalarını ve
-- tahsisi olan girişleri yakalıyordu; girişin kendisi ('gecici:%') açıkta kalmıştı.
--
-- Canlıda bu duruma düşmüş kayıt YOK (04.10.2026 ölçümü: 6 faturasız giriş,
-- ters kaydedilmiş 0), bu yüzden geçmişi onaran bir adım gerekmiyor.

DROP TRIGGER ec_provisional_entry_reverse_guard;
CREATE TRIGGER ec_provisional_entry_reverse_guard BEFORE INSERT ON ec_party_entries WHEN NEW.reversal_of IS NOT NULL BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.reversal_of AND e.source_key LIKE 'gecici-fatura:%')
  OR EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_receipt_lines p ON p.receipt_id=r.id
   JOIN ec_provisional_allocations a ON a.provisional_line_id=p.id WHERE r.entry_id=NEW.reversal_of),RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r WHERE r.entry_id=NEW.reversal_of),RAISE(ABORT,'PROVISIONAL_RECEIPT_REVERSE_BLOCKED'),NULL);
END;
