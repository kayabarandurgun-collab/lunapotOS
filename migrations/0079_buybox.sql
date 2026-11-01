-- BUYBOX ROBOTU: Hepsiburada ve Trendyol fiyatını rakibe göre yöneten modül.
--
-- Bu göç YALNIZ EKLEYİCİDİR. Hiçbir mevcut tablo değişmez. Muhasebe kaydı DEĞİLDİR: defter, stok,
-- kasa ya da satış bu tablolardan okunmaz.
--
-- Kimlik bilgileri ec_provider_connections'a yazılmaz: orası rapor/senkron içindir, 26.09'da bilinçli
-- olarak kapatıldı ve mağazası farklı olabilir. Bu tablo yalnız fiyat robotunun bağlantısını tutar;
-- burada kimlik olması pazaryeri senkronunu AÇMAZ.
CREATE TABLE ec_buybox_connection(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 platform TEXT NOT NULL CHECK(platform IN('hb','ty')),
 magaza TEXT NOT NULL,
 seller_id TEXT NOT NULL,
 encrypted_credentials TEXT NOT NULL,
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 configured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_run_at TEXT,
 last_ok_at TEXT,
 last_error TEXT,
 sample_fields TEXT,
 alert_day TEXT,
 turda_at INTEGER,
 UNIQUE(platform,magaza)
);
-- Yeni ilan 'kapali' başlar: robot okumaz bile. 'izle' okur ve "ne yapardım" yazar, fiyat göndermez.
-- 'aktif' fiyat gönderir ve taban + çekilme olmadan kaydedilemez.
CREATE TABLE ec_buybox_rules(
 connection_id INTEGER NOT NULL REFERENCES ec_buybox_connection(id),
 sku TEXT NOT NULL,
 merchant_sku TEXT NOT NULL DEFAULT '',
 label TEXT NOT NULL DEFAULT '',
 url TEXT NOT NULL DEFAULT '',
 mode TEXT NOT NULL DEFAULT 'kapali' CHECK(mode IN('kapali','izle','aktif')),
 taban_cents INTEGER CHECK(taban_cents IS NULL OR taban_cents>0),
 cekilme_cents INTEGER CHECK(cekilme_cents IS NULL OR cekilme_cents>0),
 guvenlik_cents INTEGER CHECK(guvenlik_cents IS NULL OR guvenlik_cents>0),
 yukari_esit INTEGER NOT NULL DEFAULT 0 CHECK(yukari_esit IN(0,1)),
 maliyet_cents INTEGER,
 kargo_cents INTEGER,
 komisyon_bp INTEGER,
 zarar_cents INTEGER,
 zarar_onay INTEGER NOT NULL DEFAULT 0 CHECK(zarar_onay IN(0,1)),
 price_cents INTEGER,
 list_cents INTEGER,
 stock INTEGER,
 rank INTEGER,
 rival_cents INTEGER,
 oneri_cents INTEGER,
 last_reason TEXT,
 kilit TEXT,
 beklenen_cents INTEGER,
 beklenen_at INTEGER,
 changes_today INTEGER NOT NULL DEFAULT 0,
 changes_day TEXT,
 pending_upload_id TEXT,
 pending_since INTEGER,
 pending_cents INTEGER,
 last_error TEXT,
 checked_at TEXT,
 PRIMARY KEY(connection_id,sku),
 CHECK(mode!='aktif' OR (taban_cents IS NOT NULL AND cekilme_cents IS NOT NULL AND cekilme_cents>taban_cents))
);
CREATE INDEX idx_ec_buybox_rules_mode ON ec_buybox_rules(mode,connection_id);
CREATE TABLE ec_buybox_events(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 connection_id INTEGER NOT NULL,
 sku TEXT NOT NULL,
 at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 rank INTEGER,
 rival_cents INTEGER,
 old_cents INTEGER,
 new_cents INTEGER,
 reason TEXT NOT NULL,
 upload_id TEXT,
 status TEXT NOT NULL DEFAULT 'gonderildi' CHECK(status IN('gonderildi','tamam','hata'))
);
CREATE INDEX idx_ec_buybox_events_sku ON ec_buybox_events(connection_id,sku,id);
