-- HATALI RAF SAYIMI TELAFİSİ GERİ ALINDI (6 Ekim 2026).
--
-- NE OLDU. Panelin iki parçası aynı kaydı farklı anladı:
--   · ledger-api.js:380 — "Faturasız mal girişi"ne yazılan İRSALİYE MİKTARINI
--     'GECICI-SAYIM-<irsaliye>' referanslı bir 'count' hareketi olarak yazar. Bu bir RAF SAYIMI
--     DEĞİL, gelen malın miktarıdır; fatura gelince 0065'in kapanışıyla kapanır.
--   · report-stock-link-api.js:429 — o kaydı RAF ANLIK GÖRÜNTÜSÜ sandı: "sayım satıştan SONRAKİ
--     rafı gösterir, satış şimdi stoktan düşülürse raf eksik görünür" diyerek arada satılan adedi
--     'GECICI-SAYIM-<irsaliye>-SAT-<paket>' referansıyla geri ekledi (0050:64-71 gönderim tetiği).
-- Gelen miktar + satılan miktar = fazla stok. Ölçüm (05.10.2026, canlı, salt okuma):
--   341 telafi hareketi · 398 adet · 13.492,34 TL hayalet — panel adedinin %38'i, değerinin %26,5'i.
-- Sahibin elle saydığı iki ürün birebir doğruladı: Perlit 10 L panel 43 → gerçek 28 (saydığı 26-27),
-- Orkide Toprağı 3 L panel 264 → gerçek 151 (dediği "150'den az").
--
-- NEDEN KENDİLİĞİNDEN GEÇMEZ. 0065:204-215 (ec_provisional_closure_plan) kapanış miktarını yalnız
-- ec_provisional_receipt_allocations'tan (özgün irsaliye satırından) alır ve 0065:216-219
-- (ec_provisional_closure_validate) kapanışın NEW.quantity_milli=-p.quantity_milli olmasını ZORUNLU
-- kılar. Hayalet hiçbir tahsise bağlı değil: kapanış onu ne görür ne yutar. Sayım +N, hayalet +G,
-- kapanış -N, teslim +N → panel N+G, gerçek N. Hayalet KALICIDIR.
--
-- BU GÖÇÜN YAPTIĞI: 392 adet / 11.075,00 TL geri çekilir (13 ürün). Her hayalet harekete BİREBİR
-- TAM AYNA yazılır: kind='purchase', eksi miktar, eksi değer, referans TELAFI-IPTAL-<hayalet
-- referansı>, tarih HAYALETİN KENDİ TARİHİ. Stok varlığı 41.782,01 → 30.707,01 TL olur. Bu bir
-- kayıp değil, hiç var olmamış varlığın silinmesidir: cari borçlar (Yalova Seçkin 3 adet /
-- 5.520,00 TL dahil) ve geçmiş satış maliyetleri DEĞİŞMEZ.
--
-- kind='purchase' SEÇİMİNİN İKİ AYRI GEREKÇESİ:
--   1) kind='count' + eksi değer olsa ec_count_loss (0002:33) UYDURMA kayıp gideri yazardı. 0070
--      bu dersi 720 TL'ye öğrendi. 'purchase' ec_count_loss'u uyandırmaz ve ec_stock_apply
--      (0065:200, NEW.quantity_milli>0) kapanış/settlement üretmez.
--   2) fifo-cost.js'in `dus` kümesi: geri çekilmiş sayım ve TAM aynası hiç oynatılmaz. Bu yama
--      ZORUNLUDUR ve bu göçten ÖNCE yayınlanmış olmalıdır. Yama olmadan ayna son dala (orantili)
--      düşer, raftaki gerçek partileri sale:null tüketir, fatura kapanışı (kapanisIsle) o adetleri
--      KAYIP sanıp ec_close_cost_revaluations kind='kayip' yazar ve accounting.js:159 ile
--      money-planning-api.js:165 bunu 'loss' GİDERİ gösterir. Canlı emsal: Klasmann TS1'de
--      -1.725,27 TL (04.10.2026). DOĞRULAMA ec_expenses'a BAKMAZ: o tablo bugün 0 dönüyor, kayıp
--      satırı API katmanında üretiliyor. Doğru prob ec_close_cost_revaluations WHERE kind='kayip'.
--      Yamanın GECICI-IPTAL-'e genellenmesi de ölçümle zorunlu: genellenmezse uydurma kayıp
--      99,18 → 110,03 TL'ye ÇIKAR (mükerrer irsaliye iptalleri 30.09'da iki üründe duruyor).
--
-- İKİ ÜRÜN DOKUNULMAZ (ada göre değil, 6. ifadedeki ÖLÇÜM KAPISI ve 5. ifadedeki DEĞER kuralıyla):
--   · Klasmann TS1 Torf 210 L — 2 adet / 2.333,34 TL. Hayaleti 23.09'da elle
--     (gecici-iptal:TS1-2026-09-23) zaten geri çekilmiş; bakiye değeri 1.600,00 < 2.333,34.
--     Dahil edilse -733,34 ile INVALID_STOCK_VALUE atar ve TEK ifade olduğu için BÜTÜN satırları
--     düşürürdü. Eleme bu yüzden hem doğru hem zorunlu.
--   · Tropikal Kaktüs ve Sukulent BB 225 ml — 4 adet / 84,00 TL. Bakiye değeri 0,00; o değer
--     satışlara akmış (0047:74-77 açık satışta bakiyenin tamamını süpürür). Panel -10 kalır,
--     gerçek -14. Değeri KIRPIP adedi tam yazmak FIFO'ya sıfır değerli bekleyen çıkış bırakır
--     (fifo-cost.js bekleyenCikis → gir: p.q -= t; p.v -= 0) ve sonraki alışın birim maliyetini
--     ~%67 şişirir; aynı 84 TL ikinci kez tahsil edilirdi. KIRPMA YOK, ELEME var.
--
-- BEYAN EDİLEN GERİ DÖNÜŞSÜZ ETKİ. 0045:55 (ec_receipt_reversal_validate) bir teslimin değerini
-- ürünün TOPLAM bakiye değeriyle karşılaştırır (b.value_cents<g.value_cents → RECEIPT_REVERSAL_COST).
-- Bakiye 11.075,00 TL düştüğü için bugün geri alınabilen 5 mal teslimi (toplam 4.920,00 TL) bundan
-- sonra KALICI olarak geri alınamaz; panelde "Yanlış teslimi geri al" düğmesi 409 verir. Bilinçli
-- takastır, göçten ÖNCE sahibe sorulur.
-- İkinci beyan: provisional-inventory.js:4-5 kapanış değerini o anki stok değerine sessizce kırpar
-- ve 0065:216-218 kırpılmışı bilerek kabul eder; eksiği 0049'un 'tamamla' kaydı karşılar. Geri
-- çekme bu yastığı 11.075,00 TL küçültür. Bu yüzden Tropikal faturaları girildikten sonra ürün
-- başına GET /api/ec/cost-fifo/preview?product_id=... ile `guvenli=false` sessizliği aranmalıdır.

-- 1) MUSLUK KAPANIR. Bekleyen niyetler etkisizleşir; ec_report_count_offset_lock (0050:57)
--    applied_at'in bir kez konmasına AÇIKÇA izin veriyor. Niyet silinmez, değiştirilmez.
UPDATE ec_report_count_offsets SET applied_at=CURRENT_TIMESTAMP WHERE applied_at IS NULL;

-- 2) Bekleyen niyet bir daha stok hareketine dönemez.
DROP TRIGGER ec_report_count_offset_on_ship;

-- 3) SERT KAPI: faturasız giriş sayımına bir daha telafi niyeti YAZILAMAZ. Kod bu göçten ÖNCE
--    yayınlandığı için bu kapıya çarpacak çağıran yoktur; yine de JS tarafında mekanizmanın
--    yeniden açılmasını kalıcı olarak engeller. ABORT, report-stock-link-api.js'in sipariş
--    döngüsündeki try/catch'i (529 → 627) tarafından yakalanır: yalnız o sipariş 'skipped' olur,
--    rapor turu çökmez.
CREATE TRIGGER ec_report_count_offset_retired BEFORE INSERT ON ec_report_count_offsets BEGIN
 SELECT iif(substr((SELECT m.reference FROM ec_stock_movements m WHERE m.id=NEW.count_movement_id),1,13)='GECICI-SAYIM-',
  RAISE(ABORT,'PROVISIONAL_COUNT_NOT_SHELF'),NULL);
END;

-- 4) İZ TABLOSU (ekleme-sadece; 0065/0069 uyumlu). DİKKAT: tekillik anahtarı (reference,product_id)
--    çiftidir, reference TEK BAŞINA DEĞİL: hayalet referansı ürün taşımıyor
--    (report-stock-link-api.js ref = <sayım ref>+'-SAT-'+packageId.slice(0,8)), bu yüzden tek
--    pakette iki ürün varsa iki hareket AYNI referansı taşır. Sistemin kendi anahtarı da böyledir:
--    ec_stock_movements UNIQUE(kind,reference,product_id) (0002:9).
CREATE TABLE IF NOT EXISTS ec_sayim_telafi_iptali(
 movement_id TEXT PRIMARY KEY REFERENCES ec_stock_movements(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
 value_cents INTEGER NOT NULL CHECK(value_cents>=0),
 reference TEXT NOT NULL,
 occurred_on TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(reference,product_id));
CREATE TRIGGER ec_sayim_telafi_iptali_no_update BEFORE UPDATE ON ec_sayim_telafi_iptali BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sayim_telafi_iptali_no_delete BEFORE DELETE ON ec_sayim_telafi_iptali BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- 5) UYGUN KÜMENİN ANLIK GÖRÜNTÜSÜ. Ayrı ifade olması ZORUNLU: aynı INSERT içinde ec_stock_apply
--    her satırda bakiyeyi değiştirir ve bağıntılı uygunluk testi satır satır kayardı.
--    Kural: ürünün bugünkü stok DEĞERİ kendi hayalet değerini karşılamıyorsa o ürüne dokunulmaz
--    (TS1 ve Kaktüs böyle elenir). Kırpma YOK: kırpma adet/değer ayrışması ve FIFO artığı doğurur.
INSERT INTO ec_sayim_telafi_iptali(movement_id,product_id,quantity_milli,value_cents,reference,occurred_on)
SELECT m.id,m.product_id,m.quantity_milli,m.value_cents,m.reference,m.occurred_on
FROM ec_stock_movements m
WHERE m.kind='count' AND m.quantity_milli>0 AND m.value_cents>=0
 AND m.reference LIKE 'GECICI-SAYIM-%-SAT-%'
 AND NOT EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind='purchase'
   AND x.product_id=m.product_id AND x.reference='TELAFI-IPTAL-'||m.reference)
 AND NOT EXISTS(SELECT 1 FROM ec_sayim_telafi_iptali t WHERE t.movement_id=m.id)
 AND m.product_id IN (
   SELECT g.product_id FROM
    (SELECT product_id,SUM(value_cents) v FROM ec_stock_movements
     WHERE kind='count' AND quantity_milli>0 AND value_cents>=0 AND reference LIKE 'GECICI-SAYIM-%-SAT-%'
     GROUP BY product_id) g
    JOIN ec_stock_balances b ON b.product_id=g.product_id
   WHERE b.value_cents>=g.v);

-- 6) ÖLÇÜM KAPISI (0050:11-14 ec_report_write_guard deseni). "Bugün ölçtüm, yarın koştur"
--    varsayımı KODA BAĞLANIR: hariç tutma artık ada değil VERİYE bağlı, ve kümenin ölçüldüğü
--    günden kaymış olması SESSİZ değil GÜRÜLTÜLÜ hata verir. Rakamlar 05.10.2026 ölçümüdür;
--    koşturmadan önce thoughts/shared/hayalet-stok-plani-2026-10-06.md §Uygulama adım 3'teki
--    salt okuma sorgusuyla yeniden okunur.
--    EŞİK (hn>=341) ÖLÇÜLEN NÜFUSU İŞARET EDER, kapıyı gevşetmez: ec_stock_movements ekleme-sadece
--    ve değişmez (0002:16-17 IMMUTABLE_LEDGER), bu yüzden canlıda bu sayı yalnız ARTABILIR —
--    arttığı an kapı atar. Eşiğe hiç ulaşmamış veritabanı (sıfırdan kurulum, test düzeneği,
--    yerel kopya) ölçülen veritabanı DEĞİLDİR; orada kapı sessizce geçer ve 5./7. ifadeler
--    hayalet olmadığı için zaten 0 satır yazar. Eşik olmasaydı bu göç her boş veritabanında,
--    yani appFixture'ı kullanan bütün testlerde, SAYIM_TELAFI_OLCUM_DEGISTI ile patlardı.
CREATE TABLE ec_0072_guard(code TEXT NOT NULL);
CREATE TRIGGER ec_0072_guard_abort BEFORE INSERT ON ec_0072_guard BEGIN
 SELECT RAISE(ABORT,'SAYIM_TELAFI_OLCUM_DEGISTI');
END;
INSERT INTO ec_0072_guard(code)
SELECT 'olcum-degisti' FROM (SELECT
  (SELECT COUNT(*) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hn,
  (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hq,
  (SELECT COALESCE(SUM(value_cents),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hv,
  (SELECT COUNT(*) FROM ec_sayim_telafi_iptali) un,
  (SELECT COUNT(DISTINCT product_id) FROM ec_sayim_telafi_iptali) up,
  (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_sayim_telafi_iptali) uq,
  (SELECT COALESCE(SUM(value_cents),0) FROM ec_sayim_telafi_iptali) uv,
  COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0) ayar) x
WHERE x.hn>=341 AND (
       x.hn!=341 OR x.hq!=398000 OR x.hv!=1349234          -- bütün hayalet
    OR x.un!=335 OR x.up!=13 OR x.uq!=392000 OR x.uv!=1107500  -- geri çekilecek
    OR x.hq-x.uq!=6000 OR x.hv-x.uv!=241734                -- ELENEN tam olarak TS1 + Kaktüs
    OR x.ayar!=1);                                         -- 0045 adet tabanı ve STOCK_RESERVED kapalı olmalı
DROP TRIGGER ec_0072_guard_abort;
DROP TABLE ec_0072_guard;

-- 7) AYNA HAREKETLERİ. Anlık görüntüden okur, bakiyeden okumaz. Hareket başına BİREBİR tam ayna:
--    fifo-cost.js'in dus kümesi tam-eşleşme arar; toplu ya da kırpılmış kayıt eşleşmez,
--    orantili()'ye düşer ve fatura kapanışında uydurma kayıp gideri yazdırır. Tarih de hayaletin
--    kendi tarihidir: hayalet hiç oynatılmadığı için tarih FIFO'ya değmez, buna karşılık geçmiş
--    stok raporları ("30 Eylül stoğu") doğru çıkar.
--    INSERT OR IGNORE KULLANILMAZ: ikinci koşuda NOT EXISTS 0 satır verir, çakışma sessizce
--    yutulmaz. UNIQUE(kind,reference,product_id) (0002:9) ikinci emniyet kemeridir.
INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
SELECT 'telafi-iptal-'||t.movement_id,t.product_id,-t.quantity_milli,-t.value_cents,'purchase',
 'TELAFI-IPTAL-'||t.reference,
 'Raf sayımı telafisi geri alındı (0072): faturasız giriş sayımı raf sayımı değildir.',t.occurred_on
FROM ec_sayim_telafi_iptali t
WHERE NOT EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind='purchase'
 AND x.product_id=t.product_id AND x.reference='TELAFI-IPTAL-'||t.reference);
