// SATIŞ MALİYETİ: satış tarihine göre ilk giren ilk çıkar (bkz. migrations/0048_fifo_cost.sql).
//
// Hareket eklenen ürünler ec_cost_dirty'de bekler. Her ürün için bütün stok hareketleri TARİH
// sırasıyla yeniden oynatılır (aynı gün girişler çıkışlardan önce):
//  · giriş (alış, açılış, sayım fazlası) kendi birim değeriyle bir katman açar;
//  · satış en eski katmandan tüketir; stok yetmiyorsa eksik kısım SONRAKİ ilk girişten karşılanır;
//  · satış iadesi, iade edilen satışın gerçek birim maliyetiyle katmana geri döner;
//  · geçici sayımın fatura kapanışı (provisional-close:<sayım>) önce o sayımın katmanından düşer;
//  · sayım eksiği ve diğer çıkışlar en eski katmandan düşer.
// Hesaplanan maliyet kayıtlı maliyetten farklıysa fark ec_cost_revaluations'a yazılır.
// Maliyeti henüz açık olan (faturası gelmemiş) satışa dokunulmaz; açık maliyet mekanizması kapatır.

export async function fifoProduct(db, productId) {
  const [mv, entries, open] = await Promise.all([
    db.prepare('SELECT rowid rid,id,kind,quantity_milli,value_cents,reference,occurred_on FROM ec_stock_movements WHERE product_id=?').bind(productId).all(),
    db.prepare('SELECT id,kind,parent_id,quantity_milli,cost_cents,restock FROM ec_sale_entries WHERE product_id=?').bind(productId).all(),
    db.prepare('SELECT sale_id FROM ec_open_costs WHERE product_id=? AND open_milli>settled_milli').bind(productId).all()
  ]);
  const sales = new Map(entries.results.map(s => [s.id, s]));
  const acik = new Set(open.results.map(o => o.sale_id));
  const list = mv.results.slice().sort((a, b) => a.occurred_on.localeCompare(b.occurred_on)
    || (a.quantity_milli > 0 ? 0 : 1) - (b.quantity_milli > 0 ? 0 : 1) || a.rid - b.rid);
  // cost: satışa yazılan değer, adet: değeri bilinen adet. Birim maliyet = cost / adet.
  const layers = [], pending = [], cost = new Map(), adet = new Map();
  const add = (id, q, v) => { cost.set(id, (cost.get(id) || 0) + v); adet.set(id, (adet.get(id) || 0) + q); };
  const take = (q, onTake) => {
    while (q > 0 && layers.length) { const l = layers[0], t = Math.min(q, l.q); onTake(t, l.unit); l.q -= t; q -= t; if (!l.q) layers.shift(); }
    return q;
  };
  for (const m of list) {
    if (m.quantity_milli > 0) {
      let q = m.quantity_milli, unit = m.value_cents / m.quantity_milli;
      const iade = m.kind === 'return' ? sales.get(m.reference) : null;
      const parent = iade?.kind === 'return' ? sales.get(iade.parent_id) : null;
      if (parent) {
        // Stoksuz satılmış (henüz karşılanmamış) kısmın iadesi hiç çıkmamış malı geri getirir:
        // katman açmaz, satışın bekleyen adedini düşer.
        for (const p of pending) if (p.sale === parent.id && q > 0) { const t = Math.min(q, p.q); p.q -= t; q -= t; }
        for (let k = pending.length - 1; k >= 0; k--) if (!pending[k].q) pending.splice(k, 1);
        if (adet.get(parent.id)) unit = cost.get(parent.id) / adet.get(parent.id);
      }
      // Önce stoksuz satılmış (bekleyen) kısımlar bu girişten karşılanır.
      while (q > 0 && pending.length) { const p = pending[0], t = Math.min(q, p.q); add(p.sale, t, t * unit); p.q -= t; q -= t; if (!p.q) pending.shift(); }
      if (q > 0) layers.push({q, unit, src: m.id});
      continue;
    }
    let q = -m.quantity_milli;
    if (m.kind === 'sale' && sales.has(m.reference)) {
      const id = m.reference;
      if (!cost.has(id)) { cost.set(id, 0); adet.set(id, 0); }
      q = take(q, (t, u) => add(id, t, t * u));
      if (q > 0) pending.push({sale: id, q});
      continue;
    }
    const kapanis = /^provisional-close:([^:]+):/.exec(m.reference || '');
    if (kapanis) {
      const i = layers.findIndex(l => l.src === kapanis[1]);
      if (i >= 0) { const t = Math.min(q, layers[i].q); layers[i].q -= t; q -= t; if (!layers[i].q) layers.splice(i, 1); }
    }
    take(q, () => {});
  }
  const bekleyen = new Set(pending.map(p => p.sale));
  const writes = [];
  for (const [id, c] of cost) {
    const s = sales.get(id);
    if (!s || s.kind !== 'sale' || bekleyen.has(id) || acik.has(id) || !adet.get(id)) continue;
    const birim = c / adet.get(id), hedef = Math.round(birim * s.quantity_milli), fark = hedef - s.cost_cents;
    if (fark) writes.push({sale_id: id, delta: fark});
    // Stoğa dönen iadeler, iade edilen satışın gerçek birim maliyetini taşır.
    for (const r of entries.results) if (r.kind === 'return' && r.parent_id === id && r.restock) {
      const rFark = -Math.round(birim * r.quantity_milli) - r.cost_cents;
      if (rFark) writes.push({sale_id: r.id, delta: rFark});
    }
  }
  return writes;
}

/** Kirli ürünlerin maliyetini yeniden hesaplar. En çok `limit` ürün; kalan sayısını döner. */
export async function fifoRevalue(db, limit = 8) {
  const dirty = (await db.prepare('SELECT product_id FROM ec_cost_dirty LIMIT ?').bind(limit).all()).results;
  let changed = 0;
  for (const {product_id} of dirty) {
    const writes = await fifoProduct(db, product_id);
    const stmts = writes.map(w => db.prepare('INSERT INTO ec_cost_revaluations(id,sale_id,product_id,delta_cents) VALUES(?,?,?,?)')
      .bind(crypto.randomUUID(), w.sale_id, product_id, w.delta));
    stmts.push(db.prepare('DELETE FROM ec_cost_dirty WHERE product_id=?').bind(product_id));
    await db.batch(stmts);
    changed += writes.length;
  }
  const left = (await db.prepare('SELECT COUNT(*) n FROM ec_cost_dirty').first()).n;
  return {products: dirty.length, changed, remaining: left};
}

// POST /api/ec/cost-fifo — bekleyen ürünleri hemen işler (toplu yeniden hesap; kalan 0 olana dek çağrılır).
export async function fifoApi(request, env, path) {
  if (path !== '/api/cost-fifo' || request.method !== 'POST') return null;
  if (env.WORKSPACE !== 'ec') return {products: 0, changed: 0, remaining: 0};
  return fifoRevalue(env.DB, 15);
}
