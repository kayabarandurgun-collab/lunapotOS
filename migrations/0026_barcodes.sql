-- Barkod baglantilari. YALNIZCA uretim (lp) calisma alani.
-- Bu tablo bir ARAMA tablosudur: stok tutmaz, hareket uretmez.
-- Stok hareketleri eskisi gibi lp_material_movements uzerinden yurur;
-- ikinci bir stok dogrusu OLUSTURULMAZ.
--
-- Kod METIN olarak saklanir: bastaki sifirlar korunur, hicbir yerde sayiya cevrilmez.
-- Ayni barkod iki farkli karta baglanamaz (UNIQUE(code)).
-- Urun barkodu ile uretim parti/lot kodu ayri seylerdir; bu tabloda parti kodu tutulmaz.
CREATE TABLE lp_barcodes(
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('material','product')),
 material_id TEXT REFERENCES materials(id) ON DELETE RESTRICT,
 product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
 brand TEXT NOT NULL DEFAULT '',
 -- Bir okutmanin kart biriminden kac milli ettigi. NULL ise 1 okutma = 1 birim.
 pack_quantity_milli INTEGER CHECK(pack_quantity_milli IS NULL OR (typeof(pack_quantity_milli)='integer' AND pack_quantity_milli>0)),
 pack_label TEXT NOT NULL DEFAULT '',
 -- 'gs1' yalnizca kontrol hanesi dogrulanmis kodlar icindir.
 -- 'internal' bizim urettigimiz koddur ve GS1 barkodu DEGILDIR.
 source TEXT NOT NULL DEFAULT 'other' CHECK(source IN ('gs1','other','internal')),
 note TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((material_id IS NULL)<>(product_id IS NULL)),
 CHECK((target_kind='material')=(material_id IS NOT NULL)),
 -- Ic kod bu on ekle baslar; GS1 numara alanina girmez.
 CHECK((source='internal')=(code LIKE 'LP-%')),
 CHECK(length(code) BETWEEN 1 AND 48)
);
CREATE INDEX lp_barcode_material ON lp_barcodes(material_id);
CREATE INDEX lp_barcode_product ON lp_barcodes(product_id);

-- Ayni kart icin ayni ambalaj tanimi iki kez girilmesin diye degil; farkli ambalajlar
-- (1 kg poset, 20 kg teneke) BILEREK ayri barkodlardir. Kisit yalnizca kod tekilligidir.
CREATE TRIGGER lp_barcode_validate BEFORE INSERT ON lp_barcodes BEGIN
 SELECT iif(NEW.source='gs1' AND NEW.code NOT GLOB '[0-9]*',RAISE(ABORT,'BARCODE_NOT_GS1'),NULL);
 SELECT iif(NEW.source!='internal' AND NEW.code LIKE 'LP-%',RAISE(ABORT,'BARCODE_INTERNAL_PREFIX'),NULL);
END;
CREATE TRIGGER lp_barcode_code_frozen BEFORE UPDATE ON lp_barcodes BEGIN
 SELECT iif(NEW.code!=OLD.code OR NEW.target_kind!=OLD.target_kind
   OR COALESCE(NEW.material_id,'')!=COALESCE(OLD.material_id,'')
   OR COALESCE(NEW.product_id,'')!=COALESCE(OLD.product_id,''),RAISE(ABORT,'BARCODE_RELINK'),NULL);
END;
