-- Bir belge, BİRDEN ÇOK faturayı içerebilir; her faturanın sayfası ayrı ilişkilendirilir.
--
-- Neden gerekli: tedarikçi "tüm zamanlar" dökümünü tek PDF olarak veriyor (21 Karakuş faturası
-- tek dosyada), pazaryeri satış faturaları da birleşik dosyalarda geliyor. Belge kaydındaki
-- invoice_id alanı BİRE BİR: bir belge tek faturaya bağlanabiliyor. Bu yüzden birleşik dosyada
-- ilk faturadan sonrası bağlanamıyor ve "kaynak belge: X / sayfa N" yalnızca not alanında
-- metin olarak kalıyordu. Not alanı belge arşivi değildir: tıklanamaz, doğrulanamaz, taşınamaz.
--
-- Bu tablo dosyayı çoğaltmadan sayfa düzeyinde bağlar. Özgün dosya tek kopya olarak durur.

CREATE TABLE ec_purchase_document_pages(
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES ec_purchase_documents(id),
 page_no INTEGER NOT NULL CHECK(page_no>0),
 invoice_id TEXT NOT NULL REFERENCES ec_purchase_invoices(id),
 doc_no TEXT NOT NULL DEFAULT '',
 doc_uuid TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- Aynı sayfa iki faturaya, aynı fatura iki sayfaya bağlanamaz.
 UNIQUE(document_id,page_no),
 UNIQUE(invoice_id)
);
CREATE INDEX ec_purchase_document_pages_doc ON ec_purchase_document_pages(document_id,page_no);
-- Sayfa bağlantısı kanıttır: kurulduktan sonra taşınmaz ve silinmez. Yanlışsa belge yeniden
-- ilişkilendirilmez; fatura kaydı düzeltilir.
CREATE TRIGGER ec_purchase_doc_page_no_update BEFORE UPDATE ON ec_purchase_document_pages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_purchase_doc_page_no_delete BEFORE DELETE ON ec_purchase_document_pages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Yüklemesi bitmemiş belgeye sayfa bağlanmaz.
CREATE TRIGGER ec_purchase_doc_page_sealed BEFORE INSERT ON ec_purchase_document_pages
 WHEN (SELECT status FROM ec_purchase_documents WHERE id=NEW.document_id)='receiving'
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_RECEIVING'); END;
-- Belgede okunmuş sayfa sayısı biliniyorsa, o sayıdan büyük sayfa bağlanamaz.
CREATE TRIGGER ec_purchase_doc_page_range BEFORE INSERT ON ec_purchase_document_pages
 WHEN (SELECT page_count FROM ec_purchase_documents WHERE id=NEW.document_id) IS NOT NULL
  AND NEW.page_no>(SELECT page_count FROM ec_purchase_documents WHERE id=NEW.document_id)
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_PAGE_RANGE'); END;

CREATE TABLE lp_purchase_document_pages(
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES lp_purchase_documents(id),
 page_no INTEGER NOT NULL CHECK(page_no>0),
 invoice_id TEXT NOT NULL REFERENCES lp_purchase_invoices(id),
 doc_no TEXT NOT NULL DEFAULT '',
 doc_uuid TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_id,page_no),
 UNIQUE(invoice_id)
);
CREATE INDEX lp_purchase_document_pages_doc ON lp_purchase_document_pages(document_id,page_no);
CREATE TRIGGER lp_purchase_doc_page_no_update BEFORE UPDATE ON lp_purchase_document_pages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_purchase_doc_page_no_delete BEFORE DELETE ON lp_purchase_document_pages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_purchase_doc_page_sealed BEFORE INSERT ON lp_purchase_document_pages
 WHEN (SELECT status FROM lp_purchase_documents WHERE id=NEW.document_id)='receiving'
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_RECEIVING'); END;
CREATE TRIGGER lp_purchase_doc_page_range BEFORE INSERT ON lp_purchase_document_pages
 WHEN (SELECT page_count FROM lp_purchase_documents WHERE id=NEW.document_id) IS NOT NULL
  AND NEW.page_no>(SELECT page_count FROM lp_purchase_documents WHERE id=NEW.document_id)
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_PAGE_RANGE'); END;


-- SATIŞ belgeleri: pazaryerinin kestiği faturaların özgün dosyaları.
--
-- Alış belgesinden ayrı bir tablodur çünkü karşı taraf tedarikçi değil müşteridir ve kayıt
-- bir alış faturasına değil SİPARİŞ PAKETİNE bağlanır. Alış tablosuna sokmak, satışı borç
-- tarafında gösterirdi.
--
-- Büyük birleşik dosyalar sınırı aşarsa bölünerek yüklenir; bölüm dosyası özgün dosyanın
-- adını ve o bölümün kapsadığı ÖZGÜN sayfa aralığını taşır, böylece sayfa numarası kaybolmaz.
-- Yalnızca e-ticaret alanında vardır (pazaryeri satışı üretim alanında yoktur).
CREATE TABLE ec_sales_documents(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('pdf','xml')),
 provider TEXT NOT NULL CHECK(provider IN ('trendyol','hepsiburada','other')),
 filename TEXT NOT NULL,
 mime TEXT NOT NULL DEFAULT '',
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
 sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64),
 chunk_count INTEGER NOT NULL CHECK(chunk_count>0),
 page_count INTEGER,
 text_layer INTEGER NOT NULL DEFAULT 0 CHECK(text_layer IN (0,1)),
 -- Bölünmüş yüklemede özgün dosyanın kimliği ve bu bölümün kapsadığı özgün sayfa aralığı.
 origin_filename TEXT NOT NULL DEFAULT '',
 origin_sha256 TEXT NOT NULL DEFAULT '',
 origin_first_page INTEGER,
 origin_last_page INTEGER,
 warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
 status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','stored')),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((origin_first_page IS NULL)=(origin_last_page IS NULL)),
 CHECK(origin_last_page IS NULL OR origin_last_page>=origin_first_page)
);
CREATE INDEX ec_sales_documents_origin ON ec_sales_documents(origin_sha256) WHERE origin_sha256!='';
CREATE TABLE ec_sales_document_chunks(document_id TEXT NOT NULL REFERENCES ec_sales_documents(id), idx INTEGER NOT NULL CHECK(idx>=0), data_b64 TEXT NOT NULL, PRIMARY KEY(document_id,idx));
CREATE TRIGGER ec_sales_doc_chunk_receiving BEFORE INSERT ON ec_sales_document_chunks WHEN (SELECT status FROM ec_sales_documents WHERE id=NEW.document_id) IS NOT 'receiving' BEGIN SELECT RAISE(ABORT,'DOCUMENT_SEALED'); END;
CREATE TRIGGER ec_sales_doc_chunk_no_update BEFORE UPDATE ON ec_sales_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sales_doc_chunk_no_delete BEFORE DELETE ON ec_sales_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sales_doc_no_delete BEFORE DELETE ON ec_sales_documents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sales_doc_frozen BEFORE UPDATE ON ec_sales_documents WHEN
 NEW.id!=OLD.id OR NEW.sha256!=OLD.sha256 OR NEW.kind!=OLD.kind OR NEW.size_bytes!=OLD.size_bytes
 OR NEW.chunk_count!=OLD.chunk_count OR NEW.filename!=OLD.filename OR NEW.created_at!=OLD.created_at
 OR NEW.origin_sha256!=OLD.origin_sha256 OR NEW.origin_first_page IS NOT OLD.origin_first_page
 OR NEW.origin_last_page IS NOT OLD.origin_last_page
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_IMMUTABLE'); END;

-- Satış belgesindeki her sayfa bir faturadır. Sipariş paketi henüz sistemde olmayabilir:
-- package_id boş kalabilir, belge yine de arşivlenir ve sonradan bağlanabilir.
CREATE TABLE ec_sales_document_pages(
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES ec_sales_documents(id),
 page_no INTEGER NOT NULL CHECK(page_no>0),
 -- Özgün (bölünmemiş) dosyadaki sayfa numarası. Bölünmeyen dosyalarda page_no ile aynıdır.
 origin_page_no INTEGER NOT NULL CHECK(origin_page_no>0),
 invoice_no TEXT NOT NULL DEFAULT '',
 ettn TEXT NOT NULL DEFAULT '',
 order_no TEXT NOT NULL DEFAULT '',
 package_id TEXT REFERENCES ec_order_packages(id),
 gross_cents INTEGER CHECK(gross_cents IS NULL OR gross_cents>=0),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_id,page_no)
);
CREATE INDEX ec_sales_document_pages_order ON ec_sales_document_pages(order_no) WHERE order_no!='';
CREATE INDEX ec_sales_document_pages_package ON ec_sales_document_pages(package_id) WHERE package_id IS NOT NULL;
-- Aynı fatura numarası aynı belgede iki sayfada olamaz; farklı belgelerdeki KOPYA dosyalar
-- ayrı satış sayılmaz, bu yüzden kısıt belge içinde tutulur.
CREATE UNIQUE INDEX ec_sales_document_pages_invoice ON ec_sales_document_pages(document_id,invoice_no) WHERE invoice_no!='';
CREATE TRIGGER ec_sales_doc_page_no_delete BEFORE DELETE ON ec_sales_document_pages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Sayfanın kendisi ve okunan fatura kimliği donuktur; yalnızca sipariş bağlantısı SONRADAN
-- bir kez kurulabilir (sipariş sisteme daha geç girebilir).
CREATE TRIGGER ec_sales_doc_page_frozen BEFORE UPDATE ON ec_sales_document_pages WHEN
 NEW.id!=OLD.id OR NEW.document_id!=OLD.document_id OR NEW.page_no!=OLD.page_no
 OR NEW.origin_page_no!=OLD.origin_page_no OR NEW.invoice_no!=OLD.invoice_no OR NEW.ettn!=OLD.ettn
 OR NEW.order_no!=OLD.order_no OR NEW.gross_cents IS NOT OLD.gross_cents
 OR (OLD.package_id IS NOT NULL AND NEW.package_id IS NOT OLD.package_id)
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_IMMUTABLE'); END;
CREATE TRIGGER ec_sales_doc_page_sealed BEFORE INSERT ON ec_sales_document_pages
 WHEN (SELECT status FROM ec_sales_documents WHERE id=NEW.document_id)='receiving'
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_RECEIVING'); END;
CREATE TRIGGER ec_sales_doc_page_range BEFORE INSERT ON ec_sales_document_pages
 WHEN (SELECT page_count FROM ec_sales_documents WHERE id=NEW.document_id) IS NOT NULL
  AND NEW.page_no>(SELECT page_count FROM ec_sales_documents WHERE id=NEW.document_id)
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_PAGE_RANGE'); END;
