-- SATIŞ KDV ORANI TEK YERDEN: pazaryerinin bildirdiği oran KULLANILMAZ.
--
-- NEDEN: kullanıcı bütün faturalarını %20 ile kesiyor (torf, toprak, gübre, sprey — ayrımsız).
-- Hepsiburada raporu bazı ilanlarda %10 bildiriyordu ve sipariş satırının KDV'si doğrudan oradan
-- alınıyordu. Ölçüldü (03.10.2026): 18 satır %10 ile kayıtlıydı (14.606,85 TL brüt). Kaynak rapor
-- olduğu sürece HB %10 dedikçe aynı hata her yüklemede tekrar ederdi.
--
-- Oran KODA GÖMÜLMEZ: KDV oranları kanunla değişiyor (2023'te değişti). Ayar olarak tutulur,
-- varsayılanı %20'dir; kullanıcı hiçbir şey yapmaz, oran değişirse kod yayınlamadan ayarlanır.
--
-- GEÇMİŞ BURADA DÜZELTİLMEZ. Denendi ve veritabanı reddetti: ec_order_line_lock tetikleyicisi
-- gönderilmiş/teslim edilmiş siparişin satırında tutar ve KDV değişmesine izin vermiyor
-- (ORDER_LOCKED). Bu, satış defterinin değiştirilemezlik güvencesidir ve bilerek konmuştur;
-- bir veri düzeltmesi için sessizce delinmez. Geçmişteki 18 satır ayrı bir kararla ele alınır.
ALTER TABLE workspace_settings ADD COLUMN sales_vat_bps INTEGER NOT NULL DEFAULT 2000
  CHECK(sales_vat_bps BETWEEN 0 AND 10000);

INSERT INTO ec_activity(id,description) VALUES(
  '0063-kdv-yirmi',
  'Satış KDV oranı ayara alındı (varsayılan %20); pazaryerinin bildirdiği oran artık kullanılmıyor.');
