-- MALİYET MOTORU DÜZELTMELERİ (Codex R02, R03, R07, R08, R11, R12; FIFO tarafı src/fifo-cost.js).
-- 0047/0048 canlıda uygulandı; onlara dokunulmaz, değişiklik burada. Veri onarmaz, geçmiş kayda
-- dokunmaz (yalnız ec_cost_dirty yeni biçime kopyalanır). Eski ve yeni worker bir süre birlikte
-- çalışabilir: eski kod ec_cost_dirty'yi yalnız product_id ile okur/siler/ekler, bu geçişten sonra da
-- çalışır; yeni kod bu geçiş uygulanmadan FIFO'yu çalıştıramaz (hata yakalanır, kuyruk bekler).
-- Wrangler'ın SQL ayrıştırıcısı tetik gövdesindeki CASE/END'i bölebildiği için iif kullanılır.

-- 1) FIFO KUYRUĞU NESİL TAŞIR (R02). Cron ile tarayıcı aynı kirli ürünü aynı anda işleyince aynı
-- fark iki kez yazılıyordu; hesap sırasında gelen yeni hareketin kirli işareti de siliniyordu.
-- Her işaret yeni ve hiç tekrar kullanılmayan bir sıra no (seq) alır. FIFO okuduğu seq hâlâ
-- duruyorsa yazar ve siler; seq değiştiyse (yeni hareket geldi ya da başka yürütücü bitirdi)
-- hiçbir şey yazmaz. Silinip yeniden eklenen satır AUTOINCREMENT sayesinde eski seq'i alamaz.
DROP TRIGGER ec_cost_dirty_mark;
CREATE TABLE ec_cost_dirty_yeni(seq INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL UNIQUE);
INSERT INTO ec_cost_dirty_yeni(product_id) SELECT product_id FROM ec_cost_dirty ORDER BY product_id;
DROP TABLE ec_cost_dirty;
ALTER TABLE ec_cost_dirty_yeni RENAME TO ec_cost_dirty;
-- Sil + ekle: dıştaki ifadenin çakışma kuralı (OR IGNORE vb.) işareti yenilemeyi engelleyemez.
CREATE TRIGGER ec_cost_dirty_mark AFTER INSERT ON ec_stock_movements BEGIN
 DELETE FROM ec_cost_dirty WHERE product_id=NEW.product_id;
 INSERT INTO ec_cost_dirty(product_id) VALUES(NEW.product_id);
END;

-- 2) ALIŞ FİYAT DÜZELTMESİ FIFO'YU TETİKLER (R12). Stok payı olan düzeltme stok hareketi
-- yazmadan bakiyeyi değiştiriyordu; FIFO ürünü yeniden hesaplamıyor, sonraki satış eski fiyatı alıyordu.
CREATE TRIGGER ec_cost_dirty_adjustment AFTER INSERT ON ec_purchase_adjustments WHEN NEW.stock_cents!=0 BEGIN
 DELETE FROM ec_cost_dirty WHERE product_id=(SELECT product_id FROM ec_purchase_lines WHERE id=NEW.line_id);
 INSERT INTO ec_cost_dirty(product_id) SELECT product_id FROM ec_purchase_lines WHERE id=NEW.line_id AND product_id IS NOT NULL;
END;

-- 3) FATURASI GELEN GEÇİCİ SAYIM AÇIK SATIŞ KAPATMAZ (R03/R11). Mal teslimi, açık geçici sayım
-- kadarını (aynı mal; teslimle aynı batch'te kapanır) YENİ mal saymaz: yalnız fazlası stoksuz
-- satılmış açık satışları kapatır. Eskiden teslim önce açık satışı kapatıyor, hemen ardından sayım
-- kapanışı aynı adetleri stoktan düşüyor; gerçekte malı olmayan satış "maliyeti kesin" görünüyordu.
-- Aynı ürün faturada birden çok satırsa, aynı teslimin (fatura+referans) henüz kapanmamış önceki
-- satırları sayımın o kadarını zaten ayırmıştır: aynı adet iki kez "yeni mal değil" sayılmaz.
DROP TRIGGER ec_stock_apply;
CREATE TRIGGER ec_stock_apply AFTER INSERT ON ec_stock_movements BEGIN
 UPDATE ec_stock_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE product_id=NEW.product_id;
 INSERT INTO ec_cost_settlements(id,sale_id,product_id,quantity_milli,value_cents,source_id,occurred_on)
  SELECT NEW.id||':'||x.sale_id,x.sale_id,x.product_id,x.take,CAST(NEW.value_cents*1.0*x.take/NEW.quantity_milli AS INTEGER),NEW.id,NEW.occurred_on
  FROM (SELECT o.sale_id,o.product_id,MIN(o.open_milli-o.settled_milli,MAX(0,NEW.quantity_milli
     -iif(NEW.kind='purchase' AND EXISTS(SELECT 1 FROM ec_goods_receipts g WHERE g.id=NEW.id),MIN(NEW.quantity_milli,MAX(0,COALESCE((SELECT SUM(m.quantity_milli-COALESCE((SELECT -SUM(c.quantity_milli) FROM ec_stock_movements c WHERE c.kind='purchase' AND c.product_id=m.product_id AND c.reference LIKE 'provisional-close:'||m.id||':%'),0))
        FROM ec_stock_movements m WHERE m.product_id=NEW.product_id AND m.kind='count' AND m.quantity_milli>0 AND m.reference LIKE 'GECICI-SAYIM-%'),0)
     -MAX(0,COALESCE((SELECT SUM(g2.quantity_milli) FROM ec_effective_receipts g2 JOIN ec_purchase_lines l2 ON l2.id=g2.line_id JOIN ec_goods_receipts g ON g.id=NEW.id JOIN ec_purchase_lines l ON l.id=g.line_id
        WHERE g2.id!=NEW.id AND l2.invoice_id=l.invoice_id AND g2.reference=g.reference AND l2.product_id=NEW.product_id),0)
       -COALESCE((SELECT -SUM(c.quantity_milli) FROM ec_stock_movements c JOIN ec_goods_receipts g ON g.id=NEW.id JOIN ec_purchase_lines l ON l.id=g.line_id
        WHERE c.product_id=NEW.product_id AND c.kind='purchase' AND c.reference LIKE 'provisional-close:%' AND substr(c.reference,-length(':'||l.invoice_id||':'||g.reference))=':'||l.invoice_id||':'||g.reference),0)))),0)
     -COALESCE((SELECT SUM(p.open_milli-p.settled_milli) FROM ec_open_costs p WHERE p.product_id=o.product_id AND p.open_milli>p.settled_milli AND (p.occurred_on<o.occurred_on OR (p.occurred_on=o.occurred_on AND p.rowid<o.rowid))),0))) take
   FROM ec_open_costs o WHERE o.product_id=NEW.product_id AND o.open_milli>o.settled_milli) x
  WHERE NEW.quantity_milli>0 AND NEW.kind IN ('purchase','opening','count') AND NEW.value_cents>=0 AND x.take>0;
END;

-- Geçici sayımı kapatmış ya da stoksuz satılmış bir satışı kapatmış (maliyetini vermiş) teslim geri
-- alınamaz: kapanışlar değiştirilemez kayıttır, geri alma sayımı/açık satışı yeniden açmaz; mal ya da
-- maliyet defterden kaybolurdu. Hata kodu mevcut "güvenle geri alınamıyor" mesajına düşer.
CREATE TRIGGER ec_receipt_reversal_provisional BEFORE INSERT ON ec_receipt_reversals BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_cost_settlements s WHERE s.source_id=NEW.receipt_id)
  OR EXISTS(SELECT 1 FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id JOIN ec_stock_movements c ON c.product_id=l.product_id AND c.kind='purchase' AND c.reference LIKE 'provisional-close:%' AND substr(c.reference,-length(':'||l.invoice_id||':'||g.reference))=':'||l.invoice_id||':'||g.reference WHERE g.id=NEW.receipt_id),RAISE(ABORT,'RECEIPT_REVERSAL_COST'),NULL);
END;

-- 4) GEÇİCİ SAYIM KAPANIŞININ TAMAMLANMASI (R11). Değiştirilemez kayıt; değer stoktan düşülür
-- (eksi değer stoğa ekler). İki tür:
--  · tamamla: kapanış sayımın tahmini değerini stoktan düşer; stok değeri eksiye inemediği için o anki
--    bakiye yetmezse (sayılan mal satılmış, fatura tahminden ucuz) eksik yazılıyordu. FIFO satışları
--    gerçek fiyata çekince değer stoğa döner ve eksik kısım düşülür. Gider etkisi yoktur.
--  · kayip: sayılan malın bir kısmı sayım eksiği (kayıp) olarak tahmini değerle gidere yazılmıştı; fatura
--    gelince o adetlerin gerçek fiyat farkı stokta sahipsiz kalıyordu. Fark stoktan çıkar ve kayıp
--    giderini düzeltir (muhasebe ekranında "Geçici sayım kayıp farkı").
CREATE TABLE ec_close_cost_revaluations(
 id TEXT PRIMARY KEY,
 movement_id TEXT NOT NULL REFERENCES ec_stock_movements(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 kind TEXT NOT NULL DEFAULT 'tamamla' CHECK(kind IN ('tamamla','kayip')),
 value_cents INTEGER NOT NULL CHECK(value_cents!=0 AND (kind='kayip' OR value_cents>0)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_close_cost_revaluations_product ON ec_close_cost_revaluations(product_id);
CREATE TRIGGER ec_close_cost_revaluation_no_update BEFORE UPDATE ON ec_close_cost_revaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_close_cost_revaluation_no_delete BEFORE DELETE ON ec_close_cost_revaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_close_cost_revaluation_apply AFTER INSERT ON ec_close_cost_revaluations BEGIN
 UPDATE ec_stock_balances SET value_cents=value_cents-NEW.value_cents WHERE product_id=NEW.product_id;
END;

-- 5) İADEYLE İPTAL EDİLEN AÇIK ADET KAYDEDİLİR. FIFO, satışın hangi adetlerinin maliyetli olduğunu
-- tarih sırasıyla yeniden kurar; tetik aynı şeyi kayıt sırasıyla yapar. İkisi aynı adetleri karşılamış
-- mı diye bakabilmek için iadenin iptal ettiği açık adet saklanır (eski kayıtlarda 0: FIFO temkinli davranır).
ALTER TABLE ec_open_costs ADD COLUMN cancelled_milli INTEGER NOT NULL DEFAULT 0;

-- 6) GERÇEK İADE BAŞKA AÇIK SATIŞI KAPATIR (R07). Maliyeti bilinen satışın fiziksel iadesi stoğa
-- değerli mal getirir; aynı üründe stoksuz satılmış (açık) satış varsa o mal onun eksiğini karşılar.
-- Eskiden kapanış yalnız alış/açılış/sayım girişinde yapılıyordu: 0 adet stokta değer kalıyor,
-- diğer satış tahminle açık duruyordu. İadenin kendi satışının açık kısmını iptal eden adedi hiç
-- stoktan çıkmamış maldır: o kısım kimseyi kapatmaz, değer taşımaz (kapasite = iade − iptal edilen).
-- Kapanışlar değiştirilemez kayıttır; tarih ve sıra kuralı alış kapanışıyla aynıdır.
DROP TRIGGER ec_return_stock;
CREATE TRIGGER ec_return_stock AFTER INSERT ON ec_sale_entries WHEN NEW.kind='return' AND NEW.restock=1 BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
  VALUES(NEW.id,NEW.product_id,NEW.quantity_milli,
   MAX(0,-NEW.cost_cents-COALESCE((SELECT iif(o.open_milli>o.settled_milli,CAST(ROUND((COALESCE(o.estimate_cents,0)-o.settled_estimate_cents)*1.0*MIN(NEW.quantity_milli,o.open_milli-o.settled_milli)/(o.open_milli-o.settled_milli)) AS INTEGER),0) FROM ec_open_costs o WHERE o.sale_id=NEW.parent_id),0)),
   'return',NEW.id,NEW.external_id,NEW.occurred_on);
 INSERT INTO ec_cost_settlements(id,sale_id,product_id,quantity_milli,value_cents,source_id,occurred_on)
  SELECT NEW.id||':'||x.sale_id,x.sale_id,x.product_id,x.take,CAST(r.v*1.0*x.take/r.q AS INTEGER),NEW.id,NEW.occurred_on
  FROM (SELECT NEW.quantity_milli-COALESCE((SELECT MIN(NEW.quantity_milli,o.open_milli-o.settled_milli) FROM ec_open_costs o WHERE o.sale_id=NEW.parent_id AND o.open_milli>o.settled_milli),0) q,
         (SELECT value_cents FROM ec_stock_movements WHERE id=NEW.id) v) r,
   (SELECT o.sale_id,o.product_id,MIN(o.open_milli-o.settled_milli,MAX(0,
      NEW.quantity_milli-COALESCE((SELECT MIN(NEW.quantity_milli,c.open_milli-c.settled_milli) FROM ec_open_costs c WHERE c.sale_id=NEW.parent_id AND c.open_milli>c.settled_milli),0)
      -COALESCE((SELECT SUM(p.open_milli-p.settled_milli) FROM ec_open_costs p WHERE p.product_id=o.product_id AND p.sale_id!=NEW.parent_id AND p.open_milli>p.settled_milli AND (p.occurred_on<o.occurred_on OR (p.occurred_on=o.occurred_on AND p.rowid<o.rowid))),0))) take
    FROM ec_open_costs o WHERE o.product_id=NEW.product_id AND o.sale_id!=NEW.parent_id AND o.open_milli>o.settled_milli) x
  WHERE r.q>0 AND r.v>=0 AND x.take>0;
 UPDATE ec_open_costs SET
  estimate_cents=iif(estimate_cents IS NULL,NULL,estimate_cents-CAST(ROUND((estimate_cents-settled_estimate_cents)*1.0*MIN(NEW.quantity_milli,open_milli-settled_milli)/(open_milli-settled_milli)) AS INTEGER)),
  cancelled_milli=cancelled_milli+MIN(NEW.quantity_milli,open_milli-settled_milli),
  open_milli=open_milli-MIN(NEW.quantity_milli,open_milli-settled_milli)
  WHERE sale_id=NEW.parent_id AND open_milli>settled_milli;
END;
