-- CARİ ÖDEME: "hangi bankadan" sormadan ödeme girme, çek vadesi ve "ay sonunda ödeyeceğim".
--
-- Ödemenin nasıl yapıldığı (nakit / kart / havale / çek) ve serbest notu ("Garanti Bonus kart",
-- "Ziraat çeki 123456") cari hareketin YANINDA saklanır; kasa/banka hesabı seçmek zorunlu değildir.
-- Çek borcu kapatır ama para hesaptan henüz çıkmamıştır: vadesiyle ayrı listelenebilsin diye
-- yöntem ve vade burada tutulur.
--
-- Planlanan ödeme tarihi ("bunu ay sonunda ödeyeceğim") cari hareketin due_on alanına YAZILAMAZ:
-- defter değişmezdir (party_entries üzerinde UPDATE yasaktır). Bu yüzden plan ayrı ve yalnızca
-- EKLENEBİLİR bir tabloda tutulur; en son eklenen satır geçerli plandır, eskisi geçmişte kalır.
--
-- Yalnızca YENİ tablo, indeks ve tetikleyici eklenir. Var olan tablo, tetikleyici ve veriye
-- dokunulmaz; şu an yayında olan sürüm bu tabloları hiç kullanmadığı için aynen çalışmaya devam eder.
-- Tetikleyici gövdelerinde CASE…END yoktur (wrangler dosyayı END; üzerinden böler): iif() kullanılır.

-- FATURA → CARİ BORCU. 0005'teki ec_invoice_party/lp_invoice_party tetikleyicisi aynı işi yapar ama
-- canlıda çalışmıyor: 38 muhasebeleşmiş alış faturası varken ec_party_entries bomboştur. Bu yüzden
-- tetikleyici aynı adla, aynı anahtarla ('invoice:<fatura>') ve tedarikçi adını anan açıklamayla
-- YENİDEN kurulur; ayrıca zaten satır varsa hiç yazmaz. Uygulama tarafı (src/accounting.js
-- invoiceDebtStatement) birebir aynı satırı aynı koşulla yazar: hangisi önce çalışırsa çalışsın
-- sonuç tektir ve testle canlı aynı davranır. Silme yoktur; düzeltme ters kayıtla yapılır.
-- Geçiş penceresinde (migrasyon uygulandı, yeni sürüm henüz yayınlanmadı) kaçan borç olursa
-- "Eksik fatura borçlarını tamamla" işlemi onu sonradan yazar.
DROP TRIGGER IF EXISTS ec_invoice_party;
CREATE TRIGGER ec_invoice_party AFTER UPDATE OF status ON ec_purchase_invoices WHEN NEW.status='posted' BEGIN
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||NEW.id,NEW.supplier_id,-SUM(l.net_cents+l.tax_cents),NEW.invoice_date,NEW.invoice_no,
  'Alış faturası · '||(SELECT name FROM ec_suppliers WHERE id=NEW.supplier_id)||' · '||NEW.invoice_no,'invoice:'||NEW.id,'invoice'
 FROM ec_purchase_lines l WHERE l.invoice_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.source_key='invoice:'||NEW.id)
 HAVING SUM(l.net_cents+l.tax_cents)>0;
END;

CREATE TABLE ec_party_payment_methods(
 entry_id TEXT PRIMARY KEY REFERENCES ec_party_entries(id),
 method TEXT NOT NULL CHECK(method IN ('nakit','kart','havale','cek')),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=200),
 due_on TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_party_payment_method_due ON ec_party_payment_methods(method,due_on);
CREATE TRIGGER ec_party_payment_method_validate BEFORE INSERT ON ec_party_payment_methods BEGIN
 SELECT iif(NEW.method='cek' AND COALESCE(NEW.due_on,'')='',RAISE(ABORT,'CHEQUE_DUE_REQUIRED'),NULL);
 SELECT iif(NEW.due_on IS NOT NULL AND NEW.due_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',RAISE(ABORT,'INVALID_DUE_DATE'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.entry_id AND e.amount_cents>0),RAISE(ABORT,'PAYMENT_ENTRY_REQUIRED'),NULL);
END;
CREATE TRIGGER ec_party_payment_methods_immutable_update BEFORE UPDATE ON ec_party_payment_methods BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_party_payment_methods_immutable_delete BEFORE DELETE ON ec_party_payment_methods BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TABLE ec_party_entry_plans(
 id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL REFERENCES ec_party_entries(id),
 planned_on TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=200),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_party_entry_plan_entry ON ec_party_entry_plans(entry_id,created_at);
CREATE TRIGGER ec_party_entry_plan_validate BEFORE INSERT ON ec_party_entry_plans BEGIN
 SELECT iif(NEW.planned_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',RAISE(ABORT,'INVALID_PLAN_DATE'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.entry_id AND e.amount_cents<0),RAISE(ABORT,'DEBT_ENTRY_REQUIRED'),NULL);
END;
CREATE TRIGGER ec_party_entry_plans_immutable_update BEFORE UPDATE ON ec_party_entry_plans BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_party_entry_plans_immutable_delete BEFORE DELETE ON ec_party_entry_plans BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Fatura borcunun ne kadarının kapandığı her ekranda sorulur; kapama satırları borç hareketinden aranır.
CREATE INDEX IF NOT EXISTS ec_payment_allocations_negative ON ec_payment_allocations(negative_entry_id);
CREATE INDEX IF NOT EXISTS ec_payment_allocations_positive ON ec_payment_allocations(positive_entry_id);

DROP TRIGGER IF EXISTS lp_invoice_party;
CREATE TRIGGER lp_invoice_party AFTER UPDATE OF status ON lp_purchase_invoices WHEN NEW.status='posted' BEGIN
 INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||NEW.id,NEW.supplier_id,-SUM(l.net_cents+l.tax_cents),NEW.invoice_date,NEW.invoice_no,
  'Alış faturası · '||(SELECT name FROM lp_suppliers WHERE id=NEW.supplier_id)||' · '||NEW.invoice_no,'invoice:'||NEW.id,'invoice'
 FROM lp_purchase_lines l WHERE l.invoice_id=NEW.id
  AND NOT EXISTS(SELECT 1 FROM lp_party_entries e WHERE e.source_key='invoice:'||NEW.id)
 HAVING SUM(l.net_cents+l.tax_cents)>0;
END;

CREATE TABLE lp_party_payment_methods(
 entry_id TEXT PRIMARY KEY REFERENCES lp_party_entries(id),
 method TEXT NOT NULL CHECK(method IN ('nakit','kart','havale','cek')),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=200),
 due_on TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX lp_party_payment_method_due ON lp_party_payment_methods(method,due_on);
CREATE TRIGGER lp_party_payment_method_validate BEFORE INSERT ON lp_party_payment_methods BEGIN
 SELECT iif(NEW.method='cek' AND COALESCE(NEW.due_on,'')='',RAISE(ABORT,'CHEQUE_DUE_REQUIRED'),NULL);
 SELECT iif(NEW.due_on IS NOT NULL AND NEW.due_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',RAISE(ABORT,'INVALID_DUE_DATE'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM lp_party_entries e WHERE e.id=NEW.entry_id AND e.amount_cents>0),RAISE(ABORT,'PAYMENT_ENTRY_REQUIRED'),NULL);
END;
CREATE TRIGGER lp_party_payment_methods_immutable_update BEFORE UPDATE ON lp_party_payment_methods BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_party_payment_methods_immutable_delete BEFORE DELETE ON lp_party_payment_methods BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TABLE lp_party_entry_plans(
 id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL REFERENCES lp_party_entries(id),
 planned_on TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=200),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX lp_party_entry_plan_entry ON lp_party_entry_plans(entry_id,created_at);
CREATE TRIGGER lp_party_entry_plan_validate BEFORE INSERT ON lp_party_entry_plans BEGIN
 SELECT iif(NEW.planned_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]',RAISE(ABORT,'INVALID_PLAN_DATE'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM lp_party_entries e WHERE e.id=NEW.entry_id AND e.amount_cents<0),RAISE(ABORT,'DEBT_ENTRY_REQUIRED'),NULL);
END;
CREATE TRIGGER lp_party_entry_plans_immutable_update BEFORE UPDATE ON lp_party_entry_plans BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_party_entry_plans_immutable_delete BEFORE DELETE ON lp_party_entry_plans BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE INDEX IF NOT EXISTS lp_payment_allocations_negative ON lp_payment_allocations(negative_entry_id);
CREATE INDEX IF NOT EXISTS lp_payment_allocations_positive ON lp_payment_allocations(positive_entry_id);
