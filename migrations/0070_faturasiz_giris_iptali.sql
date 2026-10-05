-- FATURASIZ MAL GİRİŞİNİN İPTALİ.
--
-- Kullanıcı aynı teslimatı iki kez "faturasız mal girişi" olarak girdi ('000003' ve
-- '6093012405584', 30.09.2026, 3.496,80 TL, üç ürün). Mal şu an stokta İKİ KEZ, tedarikçiye
-- borç 3.496,80 TL FAZLA. İki çıkış yolu da kapalıydı: kayıt silinemiyor (0065'teki
-- IMMUTABLE_LEDGER tetikleri) ve cari ekranından ters kaydedilemiyor (0069).
--
-- TERS KAYIT NEDEN DOĞRU DEĞİL (0069'un gerekçesi aynen geçerli): ters kayıt yalnız cari
-- satırını siler, STOK HAREKETİ yerinde kalır. 0065'teki eligible hesabı reversed=1 olan satırı
-- bir daha uygun saymaz; iki legacy koruması yalnız eligible=0'a baktığı için o tedarikçi + ürün
-- ikilisinde BÜTÜN gelecek faturalar PROVISIONAL_LEGACY_UNLINKED ile kilitlenir.
--
-- DOĞRU ÇÖZÜM: girişin stok ve cari etkisini birebir geri alan YENİ kayıtlar.
--  (1) Her satır için sayım hareketinin TAM AYNASI eksi bir hareket:
--      kind='purchase', reference='GECICI-IPTAL-<irsaliye>', occurred_on=girişin tarihi.
--      'count' KULLANILMAZ: eksi değerli sayım ec_count_loss (0002_accounting.sql:33) ile
--      UYDURMA bir kayıp gideri yazıyor (ölçüldü: 720 TL'lik sahte gider). 'purchase' ile
--      ec_expenses boş kalıyor; provisionalClose da (provisional-inventory.js:3-6) bu biçimi kullanır.
--  (2) Cariye KDV dahil tutarın tamamı kadar ARTI hareket, source_key='gecici-iptal:<giriş>'.
--      reversal_of YAZILMAZ; bu yüzden 0069'un ters kayıt kapısı hiç çalışmaz ve gevşetilmez.
--      Borcu kapatan belge kapaması aşağıdaki ec_provisional_cancel_close tetiğiyle aynı
--      işlemde doğar: panel onu yazmayı unutamaz.
--
-- "İPTAL EDİLDİ" BİLGİSİNİN ÇAPASI AYRI BİR BAŞLIK TABLOSU DEĞİL, STOK AYNASININ KENDİSİDİR.
-- Ölçümle seçildi: çapa başlıkta ya da cari kaydında olsaydı yarım yazma tehlikeli olurdu
-- (borç silinir, mal rafta kalır, satır hâlâ eligible=1, fatura gelince mal iki kez sayılır).
-- Ayna çapa olunca her yarım durum muhafazakârdır: ayna yazıldığı an satır aynı işlemde
-- uygunluktan düşer. Kilit iki yönlüdür: aynası eksik satır varken cari kaydı yazılamaz
-- (PROVISIONAL_CANCEL_INCOMPLETE). İptal nedeni cari hareketinin açıklamasında durur ve o satır
-- 0005_ledger.sql:57,59 ile değişmezdir.
--
-- ec_stock_apply'a DOKUNULMAZ: yürürlükteki gövde 0065:191-203'tür (0049:37-52 yürürlükten
-- kalkmıştır). İptal hareketi quantity_milli<0 olduğu için o tetiğin NEW.quantity_milli>0
-- koşulu onu zaten atlar; maliyet kapanışı üretmez.
--
-- GERİYE DÖNÜK UYUMLU: uygulandığı anda hiç iptal kaydı olmadığı için görünüm, iki legacy
-- koruması ve ters kayıt koruması eski davranışın birebir aynısını üretir. README.md:62'deki
-- "önce db:remote, sonra deploy" sırası bu yüzden güvenlidir.
--
-- CANLIDAKİ MÜKERRER KAYIT BURADA ONARILMAZ: hangi girişin yanlış olduğuna migration karar
-- vermez, kullanıcı panelden seçer. Migration yalnız yolu açar.
-- Tetik gövdelerinde CASE/END yoktur (README.md:72), yalnız iif kullanılır.

-- Satırın stok hareketi: yeni kayıtlarda satırın kendi kolonunda, 0065'in onardığı eski
-- kayıtlarda bağ tablosunda durur. BÜTÜN kapılar bu görünümden okur; biri unutulursa eski
-- bağlı giriş SIFIR stok hareketiyle "iptal" edilebilir ve mal iki kez sayılırdı.
CREATE VIEW ec_provisional_line_movements AS
 SELECT l.id line_id,l.receipt_id,l.product_id,l.quantity_milli,l.unit_cost_cents,
  COALESCE(l.movement_id,k.movement_id) movement_id
 FROM ec_provisional_receipt_lines l
 LEFT JOIN ec_provisional_movement_links k ON k.provisional_line_id=l.id;

-- 0065'teki görünüme cancelled kolonu eklenir ve eligible'a cancelled=0 şartı girer. Böylece
-- ec_invoice_provisional_allocate (0065:148) ve ec_provisional_allocation_validate (0065:107)
-- iptal edilen satırı HİÇ görmez: ne otomatik ne elle tahsis yazılabilir, dolayısıyla
-- ec_provisional_closure_plan o sayım için satır üretmez ve stok ikinci kez düşmez.
DROP VIEW ec_provisional_line_balances;
CREATE VIEW ec_provisional_line_balances AS
 SELECT b.*,quantity_milli-invoiced_milli remaining_to_invoice_milli,
 invoiced_milli-received_milli remaining_to_receive_milli,
 gross_cents-released_cents remaining_cents,
 iif(movement_id IS NOT NULL AND valid_link=1 AND invoice_id IS NULL AND reversed=0 AND cancelled=0 AND legacy_closed_milli<=received_milli,1,0) eligible
 FROM (SELECT l.id,l.receipt_id,l.product_id,l.quantity_milli,l.unit_cost_cents,l.vat_bps,COALESCE(l.movement_id,k.movement_id) movement_id,r.supplier_id,r.occurred_on,r.created_at,r.rowid receipt_order,r.reference,r.entry_id,r.invoice_id,
   CAST(ROUND(ROUND(l.quantity_milli*l.unit_cost_cents/1000.0)*(10000+l.vat_bps)/10000.0) AS INTEGER) gross_cents,
   COALESCE((SELECT SUM(a.quantity_milli) FROM ec_provisional_allocations a WHERE a.provisional_line_id=l.id),0) invoiced_milli,
   COALESCE((SELECT SUM(a.released_cents) FROM ec_provisional_allocations a WHERE a.provisional_line_id=l.id),0) released_cents,
   COALESCE((SELECT SUM(g.quantity_milli) FROM ec_provisional_receipt_allocations g JOIN ec_provisional_allocations a ON a.id=g.allocation_id WHERE a.provisional_line_id=l.id),0) received_milli,
   EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.reversal_of=r.entry_id) reversed,
   EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind='purchase' AND x.reference='GECICI-IPTAL-'||r.reference AND x.product_id=l.product_id) cancelled,
   EXISTS(SELECT 1 FROM ec_provisional_link_candidates c WHERE c.provisional_line_id=l.id AND c.movement_id=COALESCE(l.movement_id,k.movement_id)) valid_link,
   COALESCE((SELECT -SUM(m.quantity_milli) FROM ec_stock_movements m WHERE m.kind='purchase' AND substr(m.reference,1,length('provisional-close:'||COALESCE(l.movement_id,k.movement_id)||':'))='provisional-close:'||COALESCE(l.movement_id,k.movement_id)||':'),0) legacy_closed_milli
 FROM ec_provisional_receipt_lines l JOIN ec_provisional_receipts r ON r.id=l.receipt_id
 LEFT JOIN ec_provisional_movement_links k ON k.provisional_line_id=l.id) b;

-- KİLİTLENME ÖNLEMİ. İki legacy koruması yalnız eligible=0'a bakıyordu; iptal edilen satır
-- eligible=0 olduğu için o tedarikçinin BÜTÜN faturaları PROVISIONAL_LEGACY_UNLINKED ile
-- kilitlenirdi. İptal edilen satır "bağı doğrulanmamış eski giriş" DEĞİLDİR: muaf tutulur.
DROP TRIGGER ec_provisional_legacy_post_guard;
CREATE TRIGGER ec_provisional_legacy_post_guard BEFORE UPDATE OF status ON ec_purchase_invoices WHEN OLD.status='draft' AND NEW.status='posted' BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_line_balances p JOIN ec_purchase_lines l ON l.product_id=p.product_id
  WHERE l.invoice_id=NEW.id AND l.line_type='product' AND p.supplier_id=NEW.supplier_id AND p.eligible=0 AND p.cancelled=0 AND p.occurred_on<=NEW.invoice_date
   AND (p.invoice_id IS NULL OR p.invoice_id=NEW.id)),RAISE(ABORT,'PROVISIONAL_LEGACY_UNLINKED'),NULL);
END;
DROP TRIGGER ec_provisional_legacy_receipt_guard;
CREATE TRIGGER ec_provisional_legacy_receipt_guard BEFORE INSERT ON ec_goods_receipts BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
  JOIN ec_provisional_line_balances p ON p.supplier_id=i.supplier_id AND p.product_id=l.product_id
  WHERE l.id=NEW.line_id AND p.eligible=0 AND p.cancelled=0 AND p.occurred_on<=NEW.occurred_on AND (p.invoice_id IS NULL OR p.invoice_id=i.id)),RAISE(ABORT,'PROVISIONAL_LEGACY_UNLINKED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
  JOIN ec_provisional_line_balances p ON p.supplier_id=i.supplier_id AND p.product_id=l.product_id
  WHERE l.id=NEW.line_id AND p.eligible=1 AND p.remaining_to_invoice_milli>0 AND p.occurred_on<=NEW.occurred_on
   AND NEW.quantity_milli>COALESCE((SELECT SUM(a.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM ec_provisional_receipt_allocations r WHERE r.allocation_id=a.id),0))
    FROM ec_provisional_allocations a WHERE a.invoice_line_id=l.id),0)),RAISE(ABORT,'PROVISIONAL_PENDING_LINK'),NULL);
END;

-- STOK KAPISI. 'GECICI-IPTAL-' ile başlayan her hareket, bir faturasız giriş satırının stok
-- hareketinin TAM AYNASI olmak zorundadır. Uydurma, yarım, yanlış türde ya da yanlış tarihli
-- hareket yazılamaz; iptale kapalı durumların hepsi burada reddedilir.
CREATE TRIGGER ec_provisional_cancel_movement_validate BEFORE INSERT ON ec_stock_movements
 WHEN substr(NEW.reference,1,13)='GECICI-IPTAL-' BEGIN
 -- Zaten iptal edilmiş: UNIQUE(kind,reference,product_id) da yakalar ama sebep okunur olsun.
 SELECT iif(EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind=NEW.kind AND x.reference=NEW.reference
   AND x.product_id=NEW.product_id),RAISE(ABORT,'PROVISIONAL_CANCEL_TWICE'),NULL);
 -- Ayna birebir: aynı ürün, miktarın ve değerin tam negatifi, girişin kendi tarihi.
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_receipts r
   JOIN ec_provisional_line_movements l ON l.receipt_id=r.id
   JOIN ec_stock_movements m ON m.id=l.movement_id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference AND NEW.kind='purchase'
    AND l.product_id=NEW.product_id AND NEW.quantity_milli=-m.quantity_milli
    AND NEW.value_cents=-m.value_cents AND NEW.occurred_on=r.occurred_on
    AND r.entry_id IS NOT NULL AND r.invoice_id IS NULL),RAISE(ABORT,'PROVISIONAL_CANCEL_MISMATCH'),NULL);
 -- Tahsisi olan giriş: tahsis değişmezdir (0065:99-102), iptal borcu silerken tahsis yerinde
 -- kalır ve ec_provisional_closure_plan hâlâ kapanış üretir; aynı mal bir kez daha düşerdi.
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_receipt_lines l ON l.receipt_id=r.id
   JOIN ec_provisional_allocations a ON a.provisional_line_id=l.id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_INVOICED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_party_entries e ON e.reversal_of=r.entry_id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_REVERSED'),NULL);
 -- Borca ödeme yapılmışsa iptal değil tedarikçi alacağı gerekir: başka bir iş olayıdır.
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_payment_allocations a ON a.negative_entry_id=r.entry_id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference AND a.reference!='gecici-iptal:'||r.id
    AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),RAISE(ABORT,'PROVISIONAL_CANCEL_PAID'),NULL);
 -- Sayım bir açık satış maliyetini kapatmışsa o kapanış geri alınamaz (0047:40-41).
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_line_movements l ON l.receipt_id=r.id
   JOIN ec_cost_settlements s ON s.source_id=l.movement_id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_COST'),NULL);
 -- Raf sayımı telafisi (0050) bu sayıma bağlıysa iptal hayalet mal doğurur: niyet de, yazılmış
 -- telafi hareketi de ayrı ayrı sorulur (eski sürüm niyet yazmadan hareket yazabiliyordu).
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_line_movements l ON l.receipt_id=r.id
   JOIN ec_report_count_offsets o ON o.count_movement_id=l.movement_id
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_OFFSET'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_stock_movements c ON c.kind='count'
   AND substr(c.reference,1,length('GECICI-SAYIM-'||r.reference||'-SAT-'))='GECICI-SAYIM-'||r.reference||'-SAT-'
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_OFFSET'),NULL);
 -- Sayım bir fatura teslimiyle zaten kapanmışsa (eski kayıt) iptal ikinci kez düşerdi.
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_line_movements l ON l.receipt_id=r.id
   JOIN ec_stock_movements c ON c.kind='purchase'
    AND substr(c.reference,1,length('provisional-close:'||l.movement_id||':'))='provisional-close:'||l.movement_id||':'
   WHERE NEW.reference='GECICI-IPTAL-'||r.reference),RAISE(ABORT,'PROVISIONAL_CANCEL_CLOSED'),NULL);
 -- Olmayan malı un-receive edemeyiz. allow_negative_stock bu kapıyı AÇMAZ: iptal, malın hiç
 -- gelmediğini söyler; mal gittiyse eksik nerede diye sorulması gerekir.
 SELECT iif((SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli<0,RAISE(ABORT,'PROVISIONAL_CANCEL_STOCK'),NULL);
END;

-- CARİ KAPISI. İptalin cari kaydı, girişin borcunun tam negatifi olmak ve girişin BÜTÜN
-- satırlarının malı geri çekilmiş olmak zorundadır. Sayı karşılaştırması kullanılır: hareketi
-- hiç çözülemeyen eski satır (movement_id NULL, bağ da yok) ikinci sayıya giremez, bu yüzden
-- boş join geçemez ve o giriş HİÇ iptal edilemez.
CREATE TRIGGER ec_provisional_cancel_entry_validate BEFORE INSERT ON ec_party_entries
 WHEN substr(NEW.source_key,1,13)='gecici-iptal:' BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_party_entries o ON o.id=r.entry_id
   WHERE r.id=substr(NEW.source_key,14) AND r.invoice_id IS NULL AND NEW.party_id=r.supplier_id
    AND NEW.amount_cents=-o.amount_cents AND NEW.occurred_on=r.occurred_on AND NEW.source='manual'
    AND NEW.reversal_of IS NULL),RAISE(ABORT,'PROVISIONAL_CANCEL_ENTRY_MISMATCH'),NULL);
 SELECT iif((SELECT COUNT(*) FROM ec_provisional_receipt_lines l WHERE l.receipt_id=substr(NEW.source_key,14))
   !=(SELECT COUNT(*) FROM ec_provisional_receipts r
       JOIN ec_provisional_line_movements l ON l.receipt_id=r.id
       JOIN ec_stock_movements m ON m.id=l.movement_id
       JOIN ec_stock_movements x ON x.kind='purchase' AND x.reference='GECICI-IPTAL-'||r.reference
        AND x.product_id=l.product_id AND x.quantity_milli=-m.quantity_milli AND x.value_cents=-m.value_cents
      WHERE r.id=substr(NEW.source_key,14)),RAISE(ABORT,'PROVISIONAL_CANCEL_INCOMPLETE'),NULL);
END;

-- Borcun kapaması tetikle yazılır: panel onu yazmayı unutamaz, 0065'in 'gecici-fatura:'
-- kredisiyle aynı desen. Ödeme olmadığı denetlendiği için tutar borcun tamamına eşittir ve
-- ec_allocate_validate'in OVER_ALLOCATION kontrolü tam oturur.
CREATE TRIGGER ec_provisional_cancel_close AFTER INSERT ON ec_party_entries
 WHEN substr(NEW.source_key,1,13)='gecici-iptal:' BEGIN
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference)
 SELECT NEW.source_key,NEW.id,r.entry_id,NEW.amount_cents,NEW.source_key
 FROM ec_provisional_receipts r WHERE r.id=substr(NEW.source_key,14);
END;

-- RAF SAYIMI TELAFİSİNİN SON DURAĞI. Telafi niyeti execute() dışında doğrudan .run() ile
-- yazılıyor (report-stock-link-api.js:452); panelin tek yazıcı olduğuna güvenilmez. İptal
-- edilmiş sayıma telafi yazılırsa stoğa HAYALET mal girerdi. Asıl süzgeç JS tarafındadır
-- (report-stock-link-api.js:444); orası iptal edileni hiç seçmez, bu tetik yalnız güvenliktir.
CREATE TRIGGER ec_report_count_offset_cancel_guard BEFORE INSERT ON ec_report_count_offsets BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_stock_movements m JOIN ec_stock_movements x ON x.kind='purchase'
   AND x.product_id=m.product_id AND x.reference='GECICI-IPTAL-'||substr(m.reference,14)
   WHERE m.id=NEW.count_movement_id AND substr(m.reference,1,13)='GECICI-SAYIM-'),RAISE(ABORT,'PROVISIONAL_CANCELLED_COUNT'),NULL);
END;

-- İPTAL GERİ ALINAMAZ. Mal stoktan çıkmış durumda borcun geri gelmesi, ya da borç kapalıyken
-- malın geri gelmesi iki taraflı tutarsızlık olurdu. 0069'un kapısı aynen korunur, yanına
-- iptal kaydının ve kapamasının kilidi eklenir.
DROP TRIGGER ec_provisional_entry_reverse_guard;
CREATE TRIGGER ec_provisional_entry_reverse_guard BEFORE INSERT ON ec_party_entries WHEN NEW.reversal_of IS NOT NULL BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.reversal_of AND e.source_key LIKE 'gecici-fatura:%')
  OR EXISTS(SELECT 1 FROM ec_provisional_receipts r JOIN ec_provisional_receipt_lines p ON p.receipt_id=r.id
   JOIN ec_provisional_allocations a ON a.provisional_line_id=p.id WHERE r.entry_id=NEW.reversal_of),RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.reversal_of AND e.source_key LIKE 'gecici-iptal:%'),RAISE(ABORT,'PROVISIONAL_CANCEL_LOCKED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_provisional_receipts r WHERE r.entry_id=NEW.reversal_of),RAISE(ABORT,'PROVISIONAL_RECEIPT_REVERSE_BLOCKED'),NULL);
END;
DROP TRIGGER ec_provisional_payment_reverse_guard;
CREATE TRIGGER ec_provisional_payment_reverse_guard BEFORE INSERT ON ec_allocation_reversals BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE a.id=NEW.allocation_id AND a.reference LIKE 'gecici-fatura:%'),RAISE(ABORT,'PROVISIONAL_ALLOCATION_REQUIRED'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE a.id=NEW.allocation_id AND a.reference LIKE 'gecici-iptal:%'),RAISE(ABORT,'PROVISIONAL_CANCEL_LOCKED'),NULL);
END;
