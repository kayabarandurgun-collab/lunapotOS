// Cari ekstresi ve mutabakat hesabı. Saf hesap; veri erişimi ve yetki sunucudadır.
// İşaret kuralı: pozitif tutar BİZİM ALACAĞIMIZ, negatif tutar BİZİM BORCUMUZ.
// Kapama (payment_allocation) ikinci bir para hareketi değildir; toplamlara eklenmez,
// yalnızca hangi hareketin ne kadarının kapandığını göstermek için taşınır.

const int = value => (Number.isSafeInteger(value) ? value : 0);

// Aynı tarihli kayıtlarda sıralama kararlı olmalı ki sayfalar ve belge sürümleri arasında kaymasın.
const order = (a, b) =>
  String(a.occurred_on).localeCompare(String(b.occurred_on)) ||
  String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
  String(a.id).localeCompare(String(b.id));

export function buildStatement({entries = [], allocations = [], from, to}) {
  if (!from || !to) throw new Error('Dönem başlangıcı ve bitişi gerekli.');
  if (from > to) throw new Error('Başlangıç tarihi bitişten sonra olamaz.');

  const closed = new Map();
  for (const allocation of allocations) {
    if (allocation.reversed_by || allocation.reversed_at) continue;
    for (const key of [allocation.positive_entry_id, allocation.negative_entry_id]) {
      if (key) closed.set(key, int(closed.get(key)) + int(allocation.amount_cents));
    }
  }

  // Devir, dönem başından ÖNCEKİ bütün hareketlerden gelir; listedeki sayfa değil.
  let opening = 0;
  const period = [];
  for (const entry of entries) {
    if (entry.occurred_on < from) { opening += int(entry.amount_cents); continue; }
    if (entry.occurred_on > to) continue;
    period.push(entry);
  }
  period.sort(order);

  let running = opening, debit = 0, credit = 0;
  const rows = period.map(entry => {
    const amount = int(entry.amount_cents);
    if (amount > 0) debit += amount; else credit += -amount;
    running += amount;
    const allocated = Math.min(Math.abs(amount), int(closed.get(entry.id)));
    return {
      id: entry.id,
      occurred_on: entry.occurred_on,
      due_on: entry.due_on || null,
      reference: entry.reference,
      description: entry.description,
      source: entry.source,
      reversal_of: entry.reversal_of || null,
      receivable_cents: amount > 0 ? amount : 0,
      payable_cents: amount < 0 ? -amount : 0,
      allocated_cents: allocated,
      remaining_cents: Math.abs(amount) - allocated,
      running_cents: running
    };
  });

  return {
    from, to,
    currency: 'TRY',
    opening_cents: opening,
    debit_cents: debit,
    credit_cents: credit,
    closing_cents: running,
    row_count: rows.length,
    rows
  };
}

// Bakiyeyi kelimeyle anlatır; ekranda ve belgede aynı ifade kullanılır.
export function balanceWording(cents) {
  if (cents > 0) return 'bizim alacağımız';
  if (cents < 0) return 'bizim borcumuz';
  return 'bakiye yok';
}

/**
 * Karşı tarafın bildirdiği bakiyeyi ortak işarete çevirip farkı hesaplar.
 * perspective:
 *   'ours'         → bildirilen tutar zaten bizim işaretimizle verilmiş
 *   'theirs'       → karşı taraf kendi defterinden söylüyor; işaret ters çevrilir
 * Bildirim gelmediyse fark SIFIR DEĞİLDİR, bilinmiyordur.
 */
export function counterpartyDifference({closing_cents, reported_cents, perspective = 'theirs'}) {
  if (reported_cents === null || reported_cents === undefined) {
    return {status: 'unknown', reported_common_cents: null, difference_cents: null,
      wording: 'Karşı taraf bakiyesini bildirmedi. Bu tutar sıfır değil, bilinmiyor.'};
  }
  if (!Number.isSafeInteger(reported_cents)) throw new Error('Bildirilen bakiye geçersiz.');
  if (!['ours', 'theirs'].includes(perspective)) throw new Error('Bakış açısı seçilmeli.');
  const common = perspective === 'theirs' ? -reported_cents : reported_cents;
  const difference = int(closing_cents) - common;
  return {
    status: difference === 0 ? 'agreed' : 'different',
    reported_common_cents: common,
    difference_cents: difference,
    wording: difference === 0
      ? 'Bakiyeler örtüşüyor.'
      : 'Bakiyeler arasında fark var; farkın nedeni açıklanmadan mutabık sayılmaz.'
  };
}

// Belgeye yazılan ekstre görüntüsünün kimliği. Sonradan kayıt gelirse bu değişir,
// böylece eski belge korunur ve fark uyarısı verilebilir.
export function statementFingerprint(statement) {
  const parts = [statement.from, statement.to, statement.opening_cents, statement.closing_cents,
    statement.row_count, ...statement.rows.map(r => r.id + ':' + (r.receivable_cents - r.payable_cents))];
  let hash = 0x811c9dc5;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
