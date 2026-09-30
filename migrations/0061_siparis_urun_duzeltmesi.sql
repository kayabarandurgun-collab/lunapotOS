-- GÖNDERİLMİŞ SİPARİŞTE "DEPODAN GERÇEKTE NE ÇIKTI" DÜZELTMESİ (tek seferlik).
-- İhtiyaç canlıdan geldi: 10 L torf bitince o siparişlere 2 adet 5 L gönderildi. Sistem bunu
-- kaydedemiyordu. Eşleştirme ekranı yalnız TASLAK siparişte açılıyor (gönderilmiş kaydın geçmişi
-- değiştirilmez) ve doğrudan ürün seçimi kod gereği TAM 1 ADET TEK ÜRÜN. "2 adet 5 L" demenin tek
-- yolu kalıcı ilan bağlantısı kurmaktı; o da o ilanın SONRAKİ bütün siparişlerini değiştirirdi.
--
-- ÇÖZÜM: satırın kalıcı eşleşmesine hiç dokunmadan, yalnız o pakette depodan çıkanı düzelten
-- ek bileşenler. İki tür:
--   ikame → siparişteki ürün raftan çıkmadı; yerine başka ürün(ler) gönderildi.
--   ilave → siparişe parasız bir ürün daha kondu (hediye/özür); ciroya girmez, maliyete girer.
--
-- CİRO DÜZELTME BİLEŞENİNE YAZILMAZ: gelir payı 0'dır. Müşterinin ödediği tutar asıl bileşende
-- durur, böylece ciro bir kez sayılır ve satır gelir payları toplamı 10000'de kalır
-- (packageProfit 'complete' bunu şart koşuyor; bozulsaydı paketin kârı hiç hesaplanmazdı).
--
-- STOK VE MALİYET sistemin kendi tetikleyicilerinden doğar: ikamenin ters kaydı restock=1 ile
-- asıl ürünü rafa geri koyar, yeni bileşenlerin satış kaydı gerçek ürünü düşer. Elle stok yazılmaz.
ALTER TABLE ec_order_line_components ADD COLUMN correction_kind TEXT
  CHECK(correction_kind IS NULL OR correction_kind IN ('ikame','ilave'));
ALTER TABLE ec_order_line_components ADD COLUMN correction_note TEXT NOT NULL DEFAULT '';
-- İkamede hangi bileşenin yerine gönderildiği: sipariş penceresinde "… yerine gönderildi" yazısı
-- ve düzeltmenin geri alınabilmesi bundan okunur.
ALTER TABLE ec_order_line_components ADD COLUMN replaces_component_id TEXT
  REFERENCES ec_order_line_components(id);

-- GÖNDERİLMİŞ SİPARİŞİN GEÇMİŞİ KİLİTLİDİR (ec_order_component_insert_lock): taslak olmayan pakete
-- bileşen eklenemez. Koruma KALDIRILMIYOR, DAR BİR DELİK açılıyor ve kuralı tetikleyici uyguluyor:
-- yalnız gelir payı 0 olan, correction_kind'i dolu bir DÜZELTME satırı, yalnız gönderilmiş ya da
-- teslim edilmiş pakete eklenebilir. Ciro taşıyan (payı 0'dan büyük) satır eskisi gibi reddedilir,
-- böylece gönderilmiş siparişin tutarı hiçbir yoldan değiştirilemez. İptal edilmiş pakete de
-- eklenemez. 20 bileşen sınırı aynen korunur.
DROP TRIGGER ec_order_component_insert_lock;
CREATE TRIGGER ec_order_component_insert_lock BEFORE INSERT ON ec_order_line_components BEGIN
 SELECT CASE WHEN (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=NEW.line_id)!='draft'
   AND NOT (NEW.correction_kind IS NOT NULL AND NEW.revenue_share_bps=0
     AND (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=NEW.line_id) IN ('shipped','delivered'))
   THEN RAISE(ABORT,'ORDER_LOCKED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=(SELECT package_id FROM ec_order_lines WHERE id=NEW.line_id))>=20 THEN RAISE(ABORT,'ORDER_COMPONENT_LIMIT') END;
 -- İkame kaydı gerçekten bir asıl bileşenin yerine geçmeli: kendi kendine ya da başka satırın
 -- bileşenine bağlanamaz, düzeltmenin düzeltmesi olamaz.
 SELECT CASE WHEN NEW.correction_kind='ikame' AND NOT EXISTS(SELECT 1 FROM ec_order_line_components o WHERE o.id=NEW.replaces_component_id AND o.line_id=NEW.line_id AND o.correction_kind IS NULL) THEN RAISE(ABORT,'ORDER_LOCKED') END;
END;
