-- AÇIK MALİYET. Stokta olmayan maldan satış yapılabiliyor (allow_negative_stock): tedarikçi
-- faturayı ay sonunda keser, mal ondan önce satılır. Eskiden bu satışın maliyeti stok değeri /
-- stok miktarından hesaplanıyordu; stok sıfır ya da eksiyken sonuç 0 çıkıyor, mal BEDAVA
-- sayılıyordu. Sonra gelen alışın bütün değeri kalan birkaç adede yükleniyor, birim maliyet
-- şişiyordu (TS1: 1.166,67 yerine 1.516,67).
--
-- Yeni kural:
--  · Satışta stokta OLMAYAN kısım "açık"tır. Maliyeti ürünün son muhasebeleşmiş alışındaki
--    KDV hariç birim fiyattan TAHMİN edilir; stoktan değer düşülmez (stok değeri eksiye inemez).
--    Hiç alışı olmayan üründe tahmin yoktur (NULL): maliyet bilinmiyor denir, sıfır sayılmaz.
--  · Alış, açılış ya da sayımla mal girince önce açık satışlar kapanır (en eskisi önce). Satışın
--    maliyeti girişin GERÇEK birim değerine çekilir, aynı tutar stok değerinden düşülür.
--  · Açık kısmı iade edilen satışta tahmin geri alınır; stoğa hiç girmemiş değer eklenmez.
-- Kapanışlar değiştirilemez kayıttır (ec_cost_settlements); stok geçmişinde miktarsız değer
-- satırı olarak görünür. Stok hareketleri defteri değişmez.
-- Wrangler'ın SQL ayrıştırıcısı tetik gövdesindeki CASE/END'i yanlış bölebildiği için iif kullanılır.

CREATE TABLE ec_open_costs(
 sale_id TEXT PRIMARY KEY REFERENCES ec_sale_entries(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 occurred_on TEXT NOT NULL,
 open_milli INTEGER NOT NULL CHECK(open_milli>=0),
 settled_milli INTEGER NOT NULL DEFAULT 0 CHECK(settled_milli>=0 AND settled_milli<=open_milli),
 estimate_cents INTEGER CHECK(estimate_cents IS NULL OR estimate_cents>=0),
 settled_estimate_cents INTEGER NOT NULL DEFAULT 0,
 settled_cents INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_open_costs_product ON ec_open_costs(product_id,occurred_on);

CREATE TABLE ec_cost_settlements(
 id TEXT PRIMARY KEY,
 sale_id TEXT NOT NULL REFERENCES ec_open_costs(sale_id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
 value_cents INTEGER NOT NULL CHECK(value_cents>=0),
 source_id TEXT NOT NULL,
 occurred_on TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_cost_settlements_product ON ec_cost_settlements(product_id);
CREATE TRIGGER ec_cost_settlement_no_update BEFORE UPDATE ON ec_cost_settlements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_cost_settlement_no_delete BEFORE DELETE ON ec_cost_settlements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Kapanış: satışın maliyeti tahminden gerçeğe çekilir, değer stoktan düşülür.
-- Tahminin bu kapanışa düşen payı: son kapanışta kalan tamamı, öncekilerde orantılı pay.
CREATE TRIGGER ec_cost_settlement_apply AFTER INSERT ON ec_cost_settlements BEGIN
 UPDATE ec_sale_entries SET cost_cents=cost_cents+NEW.value_cents-(SELECT iif(o.estimate_cents IS NULL,0,iif(o.settled_milli+NEW.quantity_milli>=o.open_milli,o.estimate_cents-o.settled_estimate_cents,CAST(ROUND(o.estimate_cents*1.0*NEW.quantity_milli/o.open_milli) AS INTEGER))) FROM ec_open_costs o WHERE o.sale_id=NEW.sale_id) WHERE id=NEW.sale_id;
 UPDATE ec_open_costs SET settled_estimate_cents=settled_estimate_cents+iif(estimate_cents IS NULL,0,iif(settled_milli+NEW.quantity_milli>=open_milli,estimate_cents-settled_estimate_cents,CAST(ROUND(estimate_cents*1.0*NEW.quantity_milli/open_milli) AS INTEGER))),settled_milli=settled_milli+NEW.quantity_milli,settled_cents=settled_cents+NEW.value_cents WHERE sale_id=NEW.sale_id;
 UPDATE ec_stock_balances SET value_cents=value_cents-NEW.value_cents WHERE product_id=NEW.product_id;
END;

-- Stok uygulaması + kapanış TEK tetikte: bakiye önce güncellenir, sonra açık satışlar kapanır.
-- Ayrı tetik olsaydı sırası belirsiz kalır, kapanış bakiyeden önce çalışıp değeri eksiye itebilirdi.
-- Pay tabana yuvarlanır: kapanışların toplamı girişin değerini hiçbir zaman aşmaz.
DROP TRIGGER ec_stock_apply;
CREATE TRIGGER ec_stock_apply AFTER INSERT ON ec_stock_movements BEGIN
 UPDATE ec_stock_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE product_id=NEW.product_id;
 INSERT INTO ec_cost_settlements(id,sale_id,product_id,quantity_milli,value_cents,source_id,occurred_on)
  SELECT NEW.id||':'||x.sale_id,x.sale_id,x.product_id,x.take,CAST(NEW.value_cents*1.0*x.take/NEW.quantity_milli AS INTEGER),NEW.id,NEW.occurred_on
  FROM (SELECT o.sale_id,o.product_id,MIN(o.open_milli-o.settled_milli,MAX(0,NEW.quantity_milli-COALESCE((SELECT SUM(p.open_milli-p.settled_milli) FROM ec_open_costs p WHERE p.product_id=o.product_id AND p.open_milli>p.settled_milli AND (p.occurred_on<o.occurred_on OR (p.occurred_on=o.occurred_on AND p.rowid<o.rowid))),0))) take
   FROM ec_open_costs o WHERE o.product_id=NEW.product_id AND o.open_milli>o.settled_milli) x
  WHERE NEW.quantity_milli>0 AND NEW.kind IN ('purchase','opening','count') AND NEW.value_cents>=0 AND x.take>0;
END;

-- Satış: stokta olmayan kısım açık kaydedilir; stoktan yalnız stokta OLAN kısmın değeri düşer.
DROP TRIGGER ec_sale_stock;
CREATE TRIGGER ec_sale_stock AFTER INSERT ON ec_sale_entries WHEN NEW.kind='sale' BEGIN
 INSERT INTO ec_open_costs(sale_id,product_id,occurred_on,open_milli,estimate_cents)
  SELECT NEW.id,NEW.product_id,NEW.occurred_on,NEW.quantity_milli-MAX(0,b.quantity_milli),
   (SELECT CAST(ROUND(l.net_cents*1.0*(NEW.quantity_milli-MAX(0,b.quantity_milli))/l.quantity_milli) AS INTEGER)
    FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
    WHERE l.product_id=NEW.product_id AND i.status='posted' AND l.line_type='product' AND l.quantity_milli>0
    ORDER BY i.invoice_date DESC,i.created_at DESC LIMIT 1)
  FROM ec_stock_balances b WHERE b.product_id=NEW.product_id AND NEW.quantity_milli>MAX(0,b.quantity_milli);
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
  VALUES(NEW.id,NEW.product_id,-NEW.quantity_milli,
   -iif(EXISTS(SELECT 1 FROM ec_open_costs WHERE sale_id=NEW.id),COALESCE((SELECT iif(quantity_milli>0,value_cents,0) FROM ec_stock_balances WHERE product_id=NEW.product_id),0),NEW.cost_cents),
   'sale',NEW.id,NEW.external_id,NEW.occurred_on);
 UPDATE ec_sale_entries SET cost_cents=-(SELECT value_cents FROM ec_stock_movements WHERE id=NEW.id)+COALESCE((SELECT estimate_cents FROM ec_open_costs WHERE sale_id=NEW.id),0)
  WHERE id=NEW.id AND EXISTS(SELECT 1 FROM ec_open_costs WHERE sale_id=NEW.id);
END;

-- İade: satışın henüz kapanmamış açık kısmı iade edilirse o adetlerin tahmini hiç stoktan
-- çıkmamıştı; stoğa yalnız gerçekten çıkmış değer geri girer, açık miktar ve tahmin azalır.
DROP TRIGGER ec_return_stock;
CREATE TRIGGER ec_return_stock AFTER INSERT ON ec_sale_entries WHEN NEW.kind='return' AND NEW.restock=1 BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
  VALUES(NEW.id,NEW.product_id,NEW.quantity_milli,
   MAX(0,-NEW.cost_cents-COALESCE((SELECT iif(o.open_milli>o.settled_milli,CAST(ROUND((COALESCE(o.estimate_cents,0)-o.settled_estimate_cents)*1.0*MIN(NEW.quantity_milli,o.open_milli-o.settled_milli)/(o.open_milli-o.settled_milli)) AS INTEGER),0) FROM ec_open_costs o WHERE o.sale_id=NEW.parent_id),0)),
   'return',NEW.id,NEW.external_id,NEW.occurred_on);
 UPDATE ec_open_costs SET
  estimate_cents=iif(estimate_cents IS NULL,NULL,estimate_cents-CAST(ROUND((estimate_cents-settled_estimate_cents)*1.0*MIN(NEW.quantity_milli,open_milli-settled_milli)/(open_milli-settled_milli)) AS INTEGER)),
  open_milli=open_milli-MIN(NEW.quantity_milli,open_milli-settled_milli)
  WHERE sale_id=NEW.parent_id AND open_milli>settled_milli;
END;

-- GEÇMİŞ: bugüne kadar maliyeti 0 kalmış satışlar (iade edilmemiş kısmı) açık sayılır ve
-- satıştan SONRAKİ ilk alış/açılış/sayım girişinin birim değeriyle kapatılır. Giriş yoksa
-- son alış fiyatından tahmin yazılır ve ilk girişte kendiliğinden kapanır.
INSERT INTO ec_open_costs(sale_id,product_id,occurred_on,open_milli,estimate_cents)
 SELECT s.id,s.product_id,s.occurred_on,s.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM ec_sale_entries r WHERE r.parent_id=s.id AND r.kind='return' AND r.restock=1),0),
  (SELECT CAST(ROUND(l.net_cents*1.0*(s.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM ec_sale_entries r WHERE r.parent_id=s.id AND r.kind='return' AND r.restock=1),0))/l.quantity_milli) AS INTEGER)
   FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id
   WHERE l.product_id=s.product_id AND i.status='posted' AND l.line_type='product' AND l.quantity_milli>0
   ORDER BY i.invoice_date DESC,i.created_at DESC LIMIT 1)
 FROM ec_sale_entries s
 WHERE s.kind='sale' AND s.cost_cents=0 AND s.quantity_milli>0
  AND s.quantity_milli>COALESCE((SELECT SUM(r.quantity_milli) FROM ec_sale_entries r WHERE r.parent_id=s.id AND r.kind='return' AND r.restock=1),0);
UPDATE ec_sale_entries SET cost_cents=(SELECT COALESCE(o.estimate_cents,0) FROM ec_open_costs o WHERE o.sale_id=ec_sale_entries.id)
 WHERE id IN (SELECT sale_id FROM ec_open_costs);
INSERT INTO ec_cost_settlements(id,sale_id,product_id,quantity_milli,value_cents,source_id,occurred_on)
 SELECT 'gecmis:'||o.sale_id,o.sale_id,o.product_id,o.open_milli,CAST(m.value_cents*1.0*o.open_milli/m.quantity_milli AS INTEGER),m.id,m.occurred_on
 FROM ec_open_costs o JOIN ec_stock_movements m ON m.id=(SELECT m2.id FROM ec_stock_movements m2
   WHERE m2.product_id=o.product_id AND m2.quantity_milli>0 AND m2.value_cents>0 AND m2.kind IN ('purchase','opening','count') AND m2.occurred_on>=o.occurred_on
   ORDER BY m2.occurred_on,m2.rowid LIMIT 1)
 WHERE o.open_milli>0
  AND (SELECT value_cents FROM ec_stock_balances WHERE product_id=o.product_id)>=CAST(m.value_cents*1.0*o.open_milli/m.quantity_milli AS INTEGER);
