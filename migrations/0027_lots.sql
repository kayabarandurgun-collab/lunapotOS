-- Uretim parti (lot) kaydi ve koli etiketleri. YALNIZCA uretim (lp) calisma alani.
--
-- Parti kodu URUN BARKODU DEGILDIR: barkod urunun kimligidir, parti o urunun belirli
-- bir uretimidir. Ikisi ayri tablolarda durur ve birbirinin yerine gecmez.
--
-- Bu tablolar stok TUTMAZ. Parti bir uretim isine baglanabilir; miktar ve maliyet
-- eskisi gibi lp_production_jobs / lp_material_movements uzerinden yurur.
CREATE TABLE lp_lots(
 id TEXT PRIMARY KEY,
 lot_code TEXT NOT NULL UNIQUE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 -- Parti bir uretim isinden dogduysa oraya baglanir; elle acilan parti icin bos kalir.
 job_id TEXT REFERENCES lp_production_jobs(id),
 produced_on TEXT NOT NULL,
 best_before TEXT,
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 unit TEXT NOT NULL,
 -- Bir koliye kac adet girdigi. Koli etiketi bunu yazar.
 pack_size_milli INTEGER CHECK(pack_size_milli IS NULL OR (typeof(pack_size_milli)='integer' AND pack_size_milli>0)),
 note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','blocked')),
 status_note TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(best_before IS NULL OR best_before>=produced_on),
 CHECK(status!='blocked' OR status_note!='')
);
CREATE INDEX lp_lot_product ON lp_lots(product_id,produced_on);
CREATE INDEX lp_lot_job ON lp_lots(job_id);

-- Parti kodu ve urun bagi sonradan degistirilemez: basilmis etiket geriye donuk anlam degistirmesin.
CREATE TRIGGER lp_lot_identity_frozen BEFORE UPDATE ON lp_lots BEGIN
 SELECT iif(NEW.id!=OLD.id OR NEW.lot_code!=OLD.lot_code OR NEW.product_id!=OLD.product_id
   OR COALESCE(NEW.job_id,'')!=COALESCE(OLD.job_id,'') OR NEW.produced_on!=OLD.produced_on
   OR NEW.created_at!=OLD.created_at,RAISE(ABORT,'LOT_IMMUTABLE'),NULL);
END;

-- Basilan koli etiketleri. Her koli kendi sira numarasini tasir ve AYNI parti icinde
-- ayni sira numarasi iki kez uretilemez; boylece iki koli ayni kimligi tasimaz.
CREATE TABLE lp_carton_labels(
 id TEXT PRIMARY KEY,
 lot_id TEXT NOT NULL REFERENCES lp_lots(id),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
 total_cartons INTEGER NOT NULL CHECK(typeof(total_cartons)='integer' AND total_cartons>0),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 -- Etiketin uzerine basilan barkod. Urun barkodu ya da ic koddur; parti kodu degildir.
 barcode TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 printed_by TEXT NOT NULL DEFAULT '',
 printed_by_name TEXT NOT NULL DEFAULT '',
 printed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(sequence<=total_cartons),
 UNIQUE(lot_id,sequence)
);
CREATE INDEX lp_carton_lot ON lp_carton_labels(lot_id);

-- Basilmis etiket kaydi degistirilemez ve silinemez: hangi kolinin ne tasidigi geriye donuk degismez.
CREATE TRIGGER lp_carton_no_update BEFORE UPDATE ON lp_carton_labels BEGIN SELECT RAISE(ABORT,'CARTON_IMMUTABLE'); END;
CREATE TRIGGER lp_carton_no_delete BEFORE DELETE ON lp_carton_labels BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Kapali ya da bloke partiye yeni koli etiketi basilamaz.
CREATE TRIGGER lp_carton_validate BEFORE INSERT ON lp_carton_labels BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM lp_lots WHERE id=NEW.lot_id AND status='open'),RAISE(ABORT,'LOT_NOT_OPEN'),NULL);
END;
