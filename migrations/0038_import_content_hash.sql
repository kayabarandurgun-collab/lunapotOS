-- Aynı kaynak kimliğiyle FARKLI içerik gelirse sessizce atlanmamalı; incelemeye ayrılmalı.
--
-- `content_hash`, belgenin kanonik içerik özetidir (tarih, para birimi, toplamlar ve sıralı satırlar).
-- Aynı kimlik + aynı içerik  -> atlanır (mükerrer yükleme, örtüşen dosya).
-- Aynı kimlik + farklı içerik -> inceleme (düzeltilmiş belge ya da hatalı okuma olabilir);
--                                tutar veya işlenmiş belge sessizce ÜZERİNE YAZILMAZ.
--
-- Rapor→stok köprüsünde ise bağlantı kurulduğu andaki paket içeriğinin özetini tutar:
-- rapor sonradan güncellenirse (iptal, adet değişimi) eski taslak fark edilir ve engellenir.
-- Sütun eklemek geriye dönük güvenlidir; eski satırlarda NULL kalır ve karşılaştırma yapılmaz.
ALTER TABLE ec_import_items ADD COLUMN content_hash TEXT;
ALTER TABLE lp_import_items ADD COLUMN content_hash TEXT;
