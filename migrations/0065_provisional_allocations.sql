-- FA05: ileriye dönük, tedarikçi + ürün + miktar tahsisi. Geçmiş deftere UPDATE/backfill YOK.
-- Kesin eski bağlar yalnız append-only metadata tablosuna; belirsiz olanlar engellenir.
-- Fatura tahsisi, borç azaltımı, teslim tahsisi ve açık maliyet aynı kaynaktan beslenir.
CREATE TABLE ec_provisional_allocations(
 id TEXT PRIMARY KEY,
 provisional_line_id TEXT NOT NULL REFERENCES ec_provisional_receipt_lines(id),
 invoice_line_id TEXT NOT NULL REFERENCES ec_purchase_lines(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 released_cents INTEGER NOT NULL CHECK(typeof(released_cents)='integer' AND released_cents>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(provisional_line_id,invoice_line_id));
CREATE INDEX ec_provisional_allocation_invoice ON ec_provisional_allocations(invoice_line_id);
CREATE TABLE ec_provisional_receipt_allocations(
 receipt_id TEXT NOT NULL REFERENCES ec_goods_receipts(id),
 allocation_id TEXT NOT NULL REFERENCES ec_provisional_allocations(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 PRIMARY KEY(receipt_id,allocation_id));
CREATE INDEX ec_provisional_received_allocation ON ec_provisional_receipt_allocations(allocation_id);

-- Yalnız kanıtlı eski bağlar: iki yönde tekil referans + ürün + gün + miktar + değer.
-- Özgün satırlara/defterlere UPDATE yok. Bağ yeni ve değişmez metadata kaydıdır.
CREATE TABLE ec_provisional_movement_links(
 provisional_line_id TEXT PRIMARY KEY REFERENCES ec_provisional_receipt_lines(id),
 movement_id TEXT NOT NULL UNIQUE REFERENCES ec_stock_movements(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE VIEW ec_provisional_link_candidates AS
 SELECT l.id provisional_line_id,m.id movement_id
 FROM ec_provisional_receipt_lines l JOIN ec_provisional_receipts r ON r.id=l.receipt_id
 JOIN ec_stock_movements m ON m.product_id=l.product_id AND m.kind='count'
  AND m.reference='GECICI-SAYIM-'||r.reference AND m.occurred_on=r.occurred_on
  AND m.quantity_milli=l.quantity_milli
  AND m.value_cents=CAST(ROUND(l.quantity_milli*l.unit_cost_cents/1000.0) AS INTEGER);
CREATE VIEW ec_provisional_link_proofs AS
 SELECT c.* FROM ec_provisional_link_candidates c
 JOIN ec_provisional_receipt_lines l ON l.id=c.provisional_line_id
 JOIN ec_provisional_receipts r ON r.id=l.receipt_id
 WHERE l.movement_id IS NULL AND r.invoice_id IS NULL
  AND (SELECT COUNT(*) FROM ec_provisional_link_candidates x WHERE x.provisional_line_id=c.provisional_line_id)=1
  AND (SELECT COUNT(*) FROM ec_provisional_link_candidates x WHERE x.movement_id=c.movement_id)=1
  AND NOT EXISTS(SELECT 1 FROM ec_provisional_receipt_lines x WHERE x.movement_id=c.movement_id)
  AND NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.reversal_of=r.entry_id)
  AND NOT EXISTS(SELECT 1 FROM ec_stock_movements x WHERE substr(x.reference,1,length('provisional-close:'||c.movement_id||':'))='provisional-close:'||c.movement_id||':');
CREATE TRIGGER ec_provisional_link_validate BEFORE INSERT ON ec_provisional_movement_links BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_link_proofs p WHERE p.provisional_line_id=NEW.provisional_line_id AND p.movement_id=NEW.movement_id),RAISE(ABORT,'PROVISIONAL_LINK_MISMATCH'),NULL);
END;
CREATE TRIGGER ec_provisional_link_no_update BEFORE UPDATE ON ec_provisional_movement_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_link_no_delete BEFORE DELETE ON ec_provisional_movement_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
INSERT INTO ec_provisional_movement_links(provisional_line_id,movement_id)
 SELECT provisional_line_id,movement_id FROM ec_provisional_link_proofs ORDER BY provisional_line_id;

CREATE VIEW ec_provisional_line_balances AS
 SELECT b.*,quantity_milli-invoiced_milli remaining_to_invoice_milli,
 invoiced_milli-received_milli remaining_to_receive_milli,
 gross_cents-released_cents remaining_cents,
 iif(movement_id IS NOT NULL AND valid_link=1 AND invoice_id IS NULL AND reversed=0 AND legacy_closed_milli<=received_milli,1,0) eligible
 FROM (SELECT l.id,l.receipt_id,l.product_id,l.quantity_milli,l.unit_cost_cents,l.vat_bps,COALESCE(l.movement_id,k.movement_id) movement_id,r.supplier_id,r.occurred_on,r.created_at,r.rowid receipt_order,r.reference,r.entry_id,r.invoice_id,
   CAST(ROUND(ROUND(l.quantity_milli*l.unit_cost_cents/1000.0)*(10000+l.vat_bps)/10000.0) AS INTEGER) gross_cents,
   COALESCE((SELECT SUM(a.quantity_milli) FROM ec_provisional_allocations a WHERE a.provisional_line_id=l.id),0) invoiced_milli,
   COALESCE((SELECT SUM(a.released_cents) FROM ec_provisional_allocations a WHERE a.provisional_line_id=l.id),0) released_cents,
   COALESCE((SELECT SUM(g.quantity_milli) FROM ec_provisional_receipt_allocations g JOIN ec_provisional_allocations a ON a.id=g.allocation_id WHERE a.provisional_line_id=l.id),0) received_milli,
   EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.reversal_of=r.entry_id) reversed,
   EXISTS(SELECT 1 FROM ec_provisional_link_candidates c WHERE c.provisional_line_id=l.id AND c.movement_id=COALESCE(l.movement_id,k.movement_id)) valid_link,
   COALESCE((SELECT -SUM(m.quantity_milli) FROM ec_stock_movements m WHERE m.kind='purchase' AND substr(m.reference,1,length('provisional-close:'||COALESCE(l.movement_id,k.movement_id)||':'))='provisional-close:'||COALESCE(l.movement_id,k.movement_id)||':'),0) legacy_closed_milli
 FROM ec_provisional_receipt_lines l JOIN ec_provisional_receipts r ON r.id=l.receipt_id
 LEFT JOIN ec_provisional_movement_links k ON k.provisional_line_id=l.id) b;

-- Eski bağ doğrulanamıyorsa aynı tedarikçi/ürünü sessizce yeni mal sayma.
CREATE TRIGGER ec_provisional_legacy_post_guard BEFORE UPDATE OF status ON ec_purchase_invoices WHEN OLD.status='draft' AND NEW.status='posted' BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_line_balances p JOIN ec_purchase_lines l ON l.product_id=p.product_id
  WHERE l.invoice_id=NEW.id AND l.line_type='product' AND p.supplier_id=NEW.supplier_id AND p.eligible=0 AND p.occurred_on<=NEW.invoice_date
   AND (p.invoice_id IS NULL OR p.invoice_id=NEW.id)),RAISE(ABORT,'PROVISIONAL_LEGACY_UNLINKED'),NULL);
END;
CREATE TRIGGER ec_provisional_legacy_receipt_guard BEFORE INSERT ON ec_goods_receipts BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
  JOIN ec_provisional_line_balances p ON p.supplier_id=i.supplier_id AND p.product_id=l.product_id
  WHERE l.id=NEW.line_id AND p.eligible=0 AND p.occurred_on<=NEW.occurred_on AND (p.invoice_id IS NULL OR p.invoice_id=i.id)),RAISE(ABORT,'PROVISIONAL_LEGACY_UNLINKED'),NULL);
 -- Eski posted faturaya veya post sonrası girişe geriye dönük tahsis uydurulmaz.
 -- PR03: fiziksel teslimden SONRAKİ giriş bu teslimin adayı değildir.
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
  JOIN ec_provisional_line_balances p ON p.supplier_id=i.supplier_id AND p.product_id=l.product_id
  WHERE l.id=NEW.line_id AND p.eligible=1 AND p.remaining_to_invoice_milli>0 AND p.occurred_on<=NEW.occurred_on
   AND NEW.quantity_milli>COALESCE((SELECT SUM(a.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM ec_provisional_receipt_allocations r WHERE r.allocation_id=a.id),0))
    FROM ec_provisional_allocations a WHERE a.invoice_line_id=l.id),0)),RAISE(ABORT,'PROVISIONAL_PENDING_LINK'),NULL);
END;

-- PR02: geçişten önceki NULL satırlar korunur; geciken eski yazıcı yeni bağsız satır oluşturamaz.
CREATE TRIGGER ec_provisional_line_validate BEFORE INSERT ON ec_provisional_receipt_lines BEGIN
 SELECT iif(NEW.movement_id IS NULL,RAISE(ABORT,'PROVISIONAL_LINK_REQUIRED'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_stock_movements m JOIN ec_provisional_receipts r ON r.id=NEW.receipt_id
  WHERE m.id=NEW.movement_id AND m.product_id=NEW.product_id AND m.quantity_milli=NEW.quantity_milli AND m.kind='count'
  AND m.value_cents=CAST(ROUND(NEW.quantity_milli*NEW.unit_cost_cents/1000.0) AS INTEGER)
  AND m.reference='GECICI-SAYIM-'||r.reference AND m.occurred_on=r.occurred_on),RAISE(ABORT,'PROVISIONAL_LINK_MISMATCH'),NULL);
END;
CREATE TRIGGER ec_provisional_line_no_update BEFORE UPDATE ON ec_provisional_receipt_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_line_no_delete BEFORE DELETE ON ec_provisional_receipt_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Eski tek-fatura başlığı korunur, artık güncellenmez. Çoklu/kısmi durum tahsislerden okunur.
CREATE TRIGGER ec_provisional_header_no_update BEFORE UPDATE ON ec_provisional_receipts BEGIN SELECT RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'); END;
CREATE TRIGGER ec_provisional_header_no_delete BEFORE DELETE ON ec_provisional_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_allocation_no_update BEFORE UPDATE ON ec_provisional_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_allocation_no_delete BEFORE DELETE ON ec_provisional_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_received_no_update BEFORE UPDATE ON ec_provisional_receipt_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_provisional_received_no_delete BEFORE DELETE ON ec_provisional_receipt_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_provisional_allocation_validate BEFORE INSERT ON ec_provisional_allocations BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_line_balances p JOIN ec_purchase_lines l ON l.id=NEW.invoice_line_id
  JOIN ec_purchase_invoices i ON i.id=l.invoice_id
  WHERE p.id=NEW.provisional_line_id AND p.eligible=1 AND l.line_type='product' AND l.product_id=p.product_id
   AND i.supplier_id=p.supplier_id AND i.status='posted' AND p.occurred_on<=i.invoice_date
   AND NEW.quantity_milli<=p.remaining_to_invoice_milli
   AND NEW.released_cents=CAST(ROUND(p.gross_cents*(p.invoiced_milli+NEW.quantity_milli)/(p.quantity_milli*1.0)) AS INTEGER)-p.released_cents),RAISE(ABORT,'PROVISIONAL_ALLOCATION_MISMATCH'),NULL);
 SELECT iif(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_provisional_allocations WHERE invoice_line_id=NEW.invoice_line_id),0)
  >(SELECT quantity_milli FROM ec_purchase_lines WHERE id=NEW.invoice_line_id),RAISE(ABORT,'PROVISIONAL_OVER_ALLOCATION'),NULL);
END;
CREATE TRIGGER ec_provisional_received_validate BEFORE INSERT ON ec_provisional_receipt_allocations BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_allocations a JOIN ec_goods_receipts g ON g.line_id=a.invoice_line_id
  WHERE a.id=NEW.allocation_id AND g.id=NEW.receipt_id),RAISE(ABORT,'PROVISIONAL_RECEIPT_MISMATCH'),NULL);
 SELECT iif(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_provisional_receipt_allocations WHERE allocation_id=NEW.allocation_id),0)
  >(SELECT quantity_milli FROM ec_provisional_allocations WHERE id=NEW.allocation_id),RAISE(ABORT,'PROVISIONAL_OVER_ALLOCATION'),NULL);
 SELECT iif(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_provisional_receipt_allocations WHERE receipt_id=NEW.receipt_id),0)
  >(SELECT quantity_milli FROM ec_goods_receipts WHERE id=NEW.receipt_id),RAISE(ABORT,'PROVISIONAL_OVER_ALLOCATION'),NULL);
END;

-- Borç tahsisi ve mal tahsisi değişmezdir; bunların cari kapamaları elle terslenemez.
CREATE TRIGGER ec_provisional_entry_reverse_guard BEFORE INSERT ON ec_party_entries WHEN NEW.reversal_of IS NOT NULL BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.reversal_of AND e.source_key LIKE 'gecici-fatura:%')
  OR EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_receipt_lines p ON p.receipt_id=r.id
   JOIN ec_provisional_allocations a ON a.provisional_line_id=p.id WHERE r.entry_id=NEW.reversal_of),RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'),NULL);
END;
CREATE TRIGGER ec_provisional_payment_reverse_guard BEFORE INSERT ON ec_allocation_reversals BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE a.id=NEW.allocation_id AND a.reference LIKE 'gecici-fatura:%'),RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'),NULL);
END;

-- Pencere aralıklarının kesişimi: aynı üründeki fatura satırları ve FIFO irsaliye kalanları.
-- Tek UPDATE işlemi içinde hesaplanır; iki eşzamanlı fatura aynı miktarı sahiplenemez.
CREATE TRIGGER ec_invoice_provisional_allocate AFTER UPDATE OF status ON ec_purchase_invoices WHEN OLD.status='draft' AND NEW.status='posted' BEGIN
 -- Cari borç aynı tetikte hazırdır; ec_invoice_party ile çalışma sırasından bağımsız ve tektir.
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||NEW.id,NEW.supplier_id,-SUM(l.net_cents+l.tax_cents),NEW.invoice_date,NEW.invoice_no,
  'Alış faturası · '||(SELECT name FROM ec_suppliers WHERE id=NEW.supplier_id)||' · '||NEW.invoice_no,'invoice:'||NEW.id,'invoice'
 FROM ec_purchase_lines l WHERE l.invoice_id=NEW.id AND NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.source_key='invoice:'||NEW.id)
 HAVING SUM(l.net_cents+l.tax_cents)>0;
 INSERT INTO ec_provisional_allocations(id,provisional_line_id,invoice_line_id,quantity_milli,released_cents)
 SELECT p.id||':'||l.id,p.id,l.id,MIN(p.hi,l.hi)-MAX(p.lo,l.lo),
  CAST(ROUND(p.gross_cents*(p.invoiced_milli+MIN(p.hi,l.hi)-p.lo)/(p.quantity_milli*1.0)) AS INTEGER)
  -CAST(ROUND(p.gross_cents*(p.invoiced_milli+MAX(p.lo,l.lo)-p.lo)/(p.quantity_milli*1.0)) AS INTEGER)
 FROM (SELECT v.*,SUM(remaining_to_invoice_milli) OVER(PARTITION BY product_id ORDER BY occurred_on,receipt_order,id) hi,
   COALESCE(SUM(remaining_to_invoice_milli) OVER(PARTITION BY product_id ORDER BY occurred_on,receipt_order,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) lo
   FROM ec_provisional_line_balances v WHERE eligible=1 AND remaining_to_invoice_milli>0 AND supplier_id=NEW.supplier_id AND occurred_on<=NEW.invoice_date) p
 JOIN (SELECT id,product_id,SUM(quantity_milli) OVER(PARTITION BY product_id ORDER BY rowid) hi,
   COALESCE(SUM(quantity_milli) OVER(PARTITION BY product_id ORDER BY rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) lo
   FROM ec_purchase_lines WHERE invoice_id=NEW.id AND line_type='product') l ON l.product_id=p.product_id
 WHERE MIN(p.hi,l.hi)>MAX(p.lo,l.lo) ORDER BY p.product_id,p.lo,l.lo;
 -- Kısmi borç azaltımı yeni artı kayıtla yazılır; özgün borç ve geçmiş ödemeler değiştirilmez.
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'gecici-fatura:'||NEW.id||':'||p.receipt_id,NEW.supplier_id,SUM(a.released_cents),NEW.invoice_date,NEW.invoice_no,
  'Faturasız giriş faturalandı · '||r.reference,'gecici-fatura:'||NEW.id||':'||p.receipt_id,'manual'
 FROM ec_provisional_allocations a JOIN ec_purchase_lines l ON l.id=a.invoice_line_id
 JOIN ec_provisional_receipt_lines p ON p.id=a.provisional_line_id JOIN ec_provisional_receipts r ON r.id=p.receipt_id
 WHERE l.invoice_id=NEW.id GROUP BY p.receipt_id HAVING SUM(a.released_cents)>0;
 -- Önce özgün açık borcu kapat. Daha önce ödenmiş payın kredisi yeni faturaya aktarılır.
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference)
 SELECT e.id||':eski',e.id,r.entry_id,
  MIN(e.amount_cents,-old.amount_cents-COALESCE((SELECT SUM(a.amount_cents) FROM ec_payment_allocations a WHERE a.negative_entry_id=r.entry_id AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),0)),
  e.id||':eski'
 FROM ec_provisional_receipts r JOIN ec_party_entries old ON old.id=r.entry_id
 JOIN ec_party_entries e ON e.id='gecici-fatura:'||NEW.id||':'||r.id
 WHERE -old.amount_cents>COALESCE((SELECT SUM(a.amount_cents) FROM ec_payment_allocations a WHERE a.negative_entry_id=r.entry_id AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),0);
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference)
 SELECT id||':fatura',id,'invoice:'||NEW.id,MIN(remaining,MAX(0,invoice_remaining-prior)),id||':fatura'
 FROM (SELECT e.id,e.remaining,d.amount_cents*-1-COALESCE((SELECT SUM(a.amount_cents) FROM ec_payment_allocations a WHERE a.negative_entry_id=d.id AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),0) invoice_remaining,
   COALESCE(SUM(e.remaining) OVER(ORDER BY e.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior
  FROM (SELECT e.id,e.amount_cents-COALESCE((SELECT SUM(amount_cents) FROM ec_payment_allocations a WHERE a.positive_entry_id=e.id),0) remaining
    FROM ec_party_entries e WHERE substr(e.source_key,1,length('gecici-fatura:'||NEW.id||':'))='gecici-fatura:'||NEW.id||':') e
  JOIN ec_party_entries d ON d.id='invoice:'||NEW.id WHERE e.remaining>0)
 WHERE MIN(remaining,MAX(0,invoice_remaining-prior))>0;
END;

-- Teslimin hangi önceden gelmiş miktarı taşıdığı, stok hareketinden ÖNCE sabitlenir.
DROP TRIGGER ec_receipt_stock;
CREATE TRIGGER ec_receipt_stock AFTER INSERT ON ec_goods_receipts BEGIN
 INSERT INTO ec_provisional_receipt_allocations(receipt_id,allocation_id,quantity_milli)
 SELECT NEW.id,id,MIN(rem,MAX(0,NEW.quantity_milli-prior)) FROM (
  SELECT x.*,COALESCE(SUM(rem) OVER(ORDER BY rid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior FROM (
   SELECT a.id,a.rowid rid,a.quantity_milli-COALESCE((SELECT SUM(quantity_milli) FROM ec_provisional_receipt_allocations p WHERE p.allocation_id=a.id),0) rem
   FROM ec_provisional_allocations a WHERE a.invoice_line_id=NEW.line_id) x WHERE rem>0)
 WHERE MIN(rem,MAX(0,NEW.quantity_milli-prior))>0;
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
 SELECT NEW.id,product_id,NEW.quantity_milli,NEW.value_cents,'purchase',NEW.id,NEW.reference,NEW.occurred_on FROM ec_purchase_lines WHERE id=NEW.line_id;
END;

DROP TRIGGER ec_stock_apply;
CREATE TRIGGER ec_stock_apply AFTER INSERT ON ec_stock_movements BEGIN
 UPDATE ec_stock_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE product_id=NEW.product_id;
 INSERT INTO ec_cost_settlements(id,sale_id,product_id,quantity_milli,value_cents,source_id,occurred_on)
 SELECT NEW.id||':'||x.sale_id,x.sale_id,x.product_id,x.take,CAST(NEW.value_cents*1.0*x.take/NEW.quantity_milli AS INTEGER),NEW.id,NEW.occurred_on
 FROM (SELECT o.sale_id,o.product_id,MIN(o.open_milli-o.settled_milli,MAX(0,NEW.quantity_milli
   -COALESCE((SELECT SUM(quantity_milli) FROM ec_provisional_receipt_allocations WHERE receipt_id=NEW.id),0)
   -COALESCE((SELECT SUM(p.open_milli-p.settled_milli) FROM ec_open_costs p WHERE p.product_id=o.product_id AND p.open_milli>p.settled_milli AND (p.occurred_on<o.occurred_on OR (p.occurred_on=o.occurred_on AND p.rowid<o.rowid))),0))) take
 FROM ec_open_costs o WHERE o.product_id=NEW.product_id AND o.open_milli>o.settled_milli) x
 WHERE NEW.quantity_milli>0 AND NEW.kind IN ('purchase','opening','count') AND NEW.value_cents>=0 AND x.take>0;
END;

-- Kapanışın kaynağı ve miktarı aynı teslim tahsisidir; eski sürümün geniş sayım kapanışı reddedilir.
CREATE VIEW ec_provisional_closure_plan AS
 SELECT x.*,CAST(ROUND(source_value_cents*(prior+quantity_milli)/(source_quantity_milli*1.0)) AS INTEGER)
  -CAST(ROUND(source_value_cents*prior/(source_quantity_milli*1.0)) AS INTEGER) value_cents
 FROM (SELECT b.*,COALESCE(SUM(quantity_milli) OVER(PARTITION BY movement_id ORDER BY delivery_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior
 FROM (SELECT g.id receipt_id,g.rowid delivery_order,l.invoice_id,g.reference receipt_reference,p.product_id,p.movement_id,
 'provisional-close:'||p.movement_id||':'||l.invoice_id||':FA65-'||g.id reference,
 SUM(ra.quantity_milli) quantity_milli,m.value_cents source_value_cents,m.quantity_milli source_quantity_milli,
 g.occurred_on,m.occurred_on source_date,m.rowid source_order
 FROM ec_provisional_receipt_allocations ra JOIN ec_provisional_allocations a ON a.id=ra.allocation_id
 JOIN ec_provisional_line_balances p ON p.id=a.provisional_line_id JOIN ec_stock_movements m ON m.id=p.movement_id
 JOIN ec_goods_receipts g ON g.id=ra.receipt_id JOIN ec_purchase_lines l ON l.id=g.line_id
 GROUP BY g.id,p.movement_id) b) x;
CREATE TRIGGER ec_provisional_closure_validate BEFORE INSERT ON ec_stock_movements WHEN substr(NEW.reference,1,18)='provisional-close:' BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_closure_plan p WHERE p.reference=NEW.reference AND p.product_id=NEW.product_id
  AND NEW.kind='purchase' AND NEW.quantity_milli=-p.quantity_milli AND NEW.value_cents BETWEEN -p.value_cents AND 0),RAISE(ABORT,'PROVISIONAL_CLOSURE_MISMATCH'),NULL);
END;
CREATE TRIGGER ec_provisional_receipt_reverse_guard BEFORE INSERT ON ec_receipt_reversals BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipt_allocations WHERE receipt_id=NEW.receipt_id),RAISE(ABORT,'RECEIPT_REVERSAL_COST'),NULL);
END;
