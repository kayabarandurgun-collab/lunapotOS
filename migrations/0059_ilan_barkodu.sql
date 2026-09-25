-- İLAN BARKODU SİPARİŞ SATIRINDA SAKLANIR.
--
-- Neden: ilanın stok kodu ilana özgü OLMAYABİLİYOR. Canlıda 29 Trendyol ilanının stok kodu harfi
-- harfine "merchantSku" (satıcı panelinde alan adı değer olarak girilmiş) ve o ilanlar birbirinden
-- farklı ürünler. O koda açılacak tek bir bağlantı 29 ayrı ürünü aynı stok kartına bağlardı.
-- Barkod ilana özgü ve doğru geliyor, ama şimdiye kadar yalnız ham kaynak kaydında duruyordu;
-- satırda olmadığı için kalıcı bağlantı barkodla kurulamıyordu.
--
-- Satıcı ilan kodunu düzeltemediğinde tek güvenli anahtar budur.
ALTER TABLE ec_order_lines ADD COLUMN barcode TEXT NOT NULL DEFAULT '';

-- GEÇMİŞ SATIRLARIN BARKODU HAM KAYITTAN DOLDURULUR. Kaynak kaydı paketin tamamını JSON olarak
-- saklıyor; satır barkodu orada duruyor. Yalnız barkodu boş olan satırlar ve yalnız satır kodu
-- (external_id) kesin eşleştiğinde yazılır: uydurma yok, eşleşmeyen satır boş kalır.
--
-- YALNIZ TASLAK PAKETLER. Ayrılmış/gönderilmiş paketin satırı kilitlidir (ec_order_line_lock) ve
-- zaten eşleştirilmiştir; barkoda ihtiyacı yoktur. Eşleşme bekleyen paketlerin hepsi taslaktır.
UPDATE ec_order_lines SET barcode = COALESCE((
  SELECT json_extract(satir.value, '$.barcode')
  FROM ec_provider_records pr, json_each(json_extract(pr.payload_json, '$.lines')) AS satir
  JOIN ec_order_packages p ON p.id = ec_order_lines.package_id
  WHERE pr.kind = 'orders'
    AND pr.provider = p.channel
    AND pr.external_id = p.external_id
    AND json_extract(satir.value, '$.external_id') = ec_order_lines.external_id
    AND json_extract(satir.value, '$.barcode') IS NOT NULL
    AND json_extract(satir.value, '$.barcode') != ''
  LIMIT 1), '')
WHERE barcode = ''
  AND (SELECT status FROM ec_order_packages WHERE id = ec_order_lines.package_id) = 'draft';
