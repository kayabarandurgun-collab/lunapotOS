import {can} from '../public/permissions.js';
import {isISODate, todayInIstanbul} from '../public/date-range.js';
import {tumSatirlar} from './performance-api.js';

const fail = (message, status = 400) => { throw Object.assign(Error(message), {status}); };
const integer = Number.isSafeInteger;
const sum = values => {
  if (values.some(v => !integer(v))) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return integer(total) ? total : null;
};
const link = (route, params) => route + '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== null && v !== undefined && v !== ''));
const LIVE = "e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM party_entries r WHERE r.reversal_of=e.id)";
const categories = {shipping:'Kargo',commission:'Komisyon',advertising:'Reklam',rent:'Kira',packaging:'Ambalaj',other:'Diğer',loss:'Stok kaybı',purchase_variance:'Alış iadesi farkı',purchase_correction:'Alış düzeltmesi'};

// Read every page; never return a convincing subtotal when an operational limit is reached.
async function readRows(db, sql, args = []) {
  const rows = []; let cursor = null;
  while (true) {
    const page = (await db.prepare(`SELECT * FROM (${sql}) WHERE (? IS NULL OR id>?) ORDER BY id LIMIT 500`).bind(...args,cursor,cursor).all()).results;
    rows.push(...page);
    if (rows.length > 25000) fail('Kayıt sayısı fazla. Tam sonuç için tarih aralığını daraltın.',409);
    if (page.length < 500) return rows;
    const next = page.at(-1).id;
    if (cursor !== null && next <= cursor) fail('Kayıtların tamamı doğrulanamadı. Yeniden deneyin.',409);
    cursor = next;
  }
}

function dateRange(request, mode) {
  const params = new URL(request.url).searchParams, today = todayInIstanbul();
  for (const key of ['from','to']) if (params.getAll(key).length > 1) fail('Tarih birden fazla gönderilemez.');
  const from = params.get('from') ?? today.slice(0,7)+'-01';
  const to = params.get('to') ?? (mode === 'result' ? today : new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10));
  if (!isISODate(from) || !isISODate(to) || from > to) fail('Geçerli bir başlangıç ve bitiş tarihi seçin.');
  if (Date.parse(to)-Date.parse(from) > 365*86400000) fail('En fazla 366 günlük bir aralık seçin.');
  if (mode === 'result' && to > today) fail('İşletme sonucu için bitiş tarihi bugünden sonra olamaz.');
  // An operating result is a workspace-wide overhead comparison. Channel allocation is unknown.
  if (params.has('channel')) fail('Ortak giderler kanallara dağıtılmadığı için kanal süzgeci kullanılamaz.');
  return {from,to,today};
}

export async function moneyPlanningApi(request, env, path) {
  const user = env.USER;
  if (!['/api/money-calendar','/api/business-result'].includes(path)) return null;
  if (request.method !== 'GET') fail('Bu ekran yalnızca okunabilir.',405);
  const ns = env.WORKSPACE, mode = path === '/api/business-result' ? 'result' : 'calendar';
  if (!['ec','lp'].includes(ns) || mode === 'result' && ns !== 'ec') fail('Bu sonuç e-ticaret çalışma alanına aittir.',403);
  const required = mode === 'result' ? ['performance','expenses','amounts'] : ['ledger','amounts'];
  if (!required.every(key => can(user,ns,key))) fail('Bu görünümün kaynaklarını ve tutarlarını görme yetkiniz yok.',403);
  const range = dateRange(request,mode);
  return mode === 'calendar' ? moneyCalendar(env,range,user) : businessResult(env,range,user);
}

async function moneyCalendar(env, range, user) {
  const {from,to,today} = range, db = env.DB, ns = env.WORKSPACE;
  const expensesAllowed = can(user,ns,ns === 'ec' ? 'expenses' : 'accounts');
  const entries = await readRows(db,`SELECT e.id,e.party_id,e.amount_cents,e.occurred_on,e.due_on,e.reference,e.description,e.source,e.source_key,s.name party_name,
    COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE (a.positive_entry_id=e.id OR a.negative_entry_id=e.id) AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)),0) allocated_cents,
    (SELECT p.planned_on FROM party_entry_plans p WHERE p.entry_id=e.id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1) planned_on,
    (SELECT m.method FROM party_payment_methods m WHERE m.entry_id=e.id) payment_method,
    (SELECT m.due_on FROM party_payment_methods m WHERE m.entry_id=e.id) payment_due_on,
    (SELECT t.id FROM cash_transactions t WHERE t.party_entry_id=e.id AND t.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM cash_transactions r WHERE r.reversal_of=t.id)) paid_cash_id
    FROM party_entries e JOIN suppliers s ON s.id=e.party_id WHERE ${LIVE}
    AND ((payment_method='cek' AND paid_cash_id IS NULL)
      OR (e.source NOT IN ('cash','legacy_payment','reversal') AND payment_method IS NULL AND ABS(e.amount_cents)>allocated_cents))`);
  const bankSelect = ns === 'ec' ? `,(SELECT m.id FROM bank_matches m WHERE m.transfer_in_id=t.id AND m.status='confirmed') bank_match_id` : ',NULL bank_match_id';
  // The two clearing legs are bookkeeping transfers, not another receipt or payment.
  const cash = await readRows(db,`SELECT t.id,t.account_id,t.party_entry_id,t.amount_cents,t.occurred_on,t.reference,t.description,t.reversal_of,
    a.name account_name,a.kind account_kind,e.party_id,s.name party_name,
    (SELECT r.id FROM cash_transactions r WHERE r.reversal_of=t.id) reversed_by${bankSelect}
    FROM cash_transactions t JOIN cash_accounts a ON a.id=t.account_id LEFT JOIN party_entries e ON e.id=t.party_entry_id LEFT JOIN suppliers s ON s.id=e.party_id
    WHERE (a.role IS NULL OR a.role!='marketplace_clearing') AND (t.occurred_on BETWEEN ? AND ? OR t.occurred_on IS NULL OR t.occurred_on='' OR date(t.occurred_on,'+0 days') IS NULL OR date(t.occurred_on,'+0 days')!=t.occurred_on)`,[from,to]);
  const rows = [];
  const add = row => {
    const date = isISODate(row.date) ? row.date : null;
    const overdue = row.group === 'expected' && (date !== null && date < today || isISODate(row.due_on) && row.due_on < today);
    const inRange = date !== null && date >= from && date <= to;
    if (date !== null && !inRange && !overdue) return;
    rows.push({...row,date,overdue,in_range:inRange,bucket:date === null ? 'undated' : inRange ? 'period' : 'overdue_outside_period'});
  };
  for (const e of entries) {
    const sourceLink = link('#ledger',{tab:'entries',party:e.party_id,q:e.reference});
    const base = {party_id:e.party_id,party_name:e.party_name,reference:e.reference,label:e.description,occurred_on:e.occurred_on,entry_id:e.id,source_link:sourceLink,basis:'gross',net_cents:null,group:'expected'};
    if (e.payment_method === 'cek') {
      if (!e.paid_cash_id) add({...base,id:'cheque:'+e.id,kind:'cheque',direction:e.amount_cents > 0 ? 'outgoing' : 'incoming',amount_cents:Math.abs(e.amount_cents),date:e.payment_due_on,due_on:e.payment_due_on,state:'cheque_pending',note:'Çek cariye işlendi; bağlı kasa/banka ödemesi henüz yok.'});
      continue;
    }
    // Payments/collections and old payment backfills are not new receivables/payables.
    if (['cash','legacy_payment','reversal'].includes(e.source) || e.payment_method) continue;
    const remaining = sum([Math.abs(e.amount_cents),-e.allocated_cents]);
    if (remaining !== null && remaining <= 0) continue;
    add({...base,id:'entry:'+e.id,kind:'ledger',direction:e.amount_cents > 0 ? 'incoming' : 'outgoing',amount_cents:remaining,
      date:e.planned_on || e.due_on,due_on:e.due_on,planned_on:e.planned_on,state:'expected',allocated_cents:e.allocated_cents,
      note:e.planned_on ? 'Planlanan gün; belgedeki vade ayrıca gösterilir.' : 'Açık cari kayıt. Tahsilat veya banka onayı değildir.'});
  }
  for (const t of cash) add({id:'cash:'+t.id,kind:'cash',group:t.occurred_on > today ? 'future_record' : 'recorded',date:t.occurred_on,
    amount_cents:integer(t.amount_cents) ? Math.abs(t.amount_cents) : null,net_cents:null,basis:'gross',direction:t.amount_cents > 0 ? 'incoming' : 'outgoing',
    label:t.description,reference:t.reference,party_id:t.party_id,party_name:t.party_name,account_id:t.account_id,account_name:t.account_name,
    entry_id:t.party_entry_id,cash_id:t.id,bank_match_id:t.bank_match_id,reversal_of:t.reversal_of,reversed_by:t.reversed_by,
    state:t.reversal_of ? 'reversal' : t.reversed_by ? 'reversed' : t.bank_match_id ? 'bank_confirmed' : 'recorded',
    note:t.reversal_of ? 'Ters kayıt. Önceki kasa/banka kaydını düzeltir; yeni satış değildir.' : t.reversed_by ? 'Bu kaydın ters kaydı var; düzeltme kendi tarihinde gösterilir.' : t.bank_match_id ? 'Banka ekstresiyle onaylanan giriş; yalnız gerçek banka ayağı sayıldı.' : 'Kasa/banka defterine kaydedildi; ekstre doğrulaması göstermez.',
    source_link:link('#ledger',{tab:'cash',...(isISODate(t.occurred_on) ? {from:t.occurred_on,to:t.occurred_on} : {})})});
  if (expensesAllowed) {
    // Invoice-generated expenses are already covered by their gross party debt.
    // A manual expense has no payment date or VAT field: neither is invented.
    const expenses = await readRows(db,`SELECT e.id,e.reference,e.category,e.label,e.amount_cents,e.occurred_on,e.notes FROM expenses e
      WHERE e.archived_at IS NULL AND e.paid=0 AND e.category!='loss' AND NOT EXISTS(SELECT 1 FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE e.reference='invoice-'||l.id AND i.status='posted')`);
    for (const e of expenses) {
      const scheduled = /^GIDER-PLAN-.+-\d{4}-\d{2}$/.test(e.reference);
      add({id:'expense:'+e.id,kind:'expense',group:'expected',state:'unpaid_expense',direction:'outgoing',date:scheduled ? e.occurred_on : null,
        occurred_on:e.occurred_on,amount_cents:null,net_cents:e.amount_cents,basis:'net',reference:e.reference,label:e.label || categories[e.category] || 'Gider',
        note:'KDV hariç gider kaydı; ödenecek toplam ve banka hareketi bilinmiyor.',source_link:link(ns === 'ec' ? '#expenses' : '#accounts',{...(ns === 'lp' ? {view:'expenses'} : {}),...(isISODate(e.occurred_on) ? {from:e.occurred_on,to:e.occurred_on} : {})})});
    }
    const schedules = await readRows(db,'SELECT id,label,category,amount_cents,day_of_month,starts_on,ends_on FROM expense_schedules WHERE archived_at IS NULL AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?)',[to,from]);
    const generated = schedules.length ? new Set((await readRows(db,`SELECT e.id,e.reference FROM expenses e
      WHERE substr(e.reference,-7) BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM json_each(?) p WHERE e.reference='GIDER-PLAN-'||p.value||'-'||substr(e.reference,-7))`,
      [from.slice(0,7),to.slice(0,7),JSON.stringify(schedules.map(p => p.id))])).map(e => e.reference)) : new Set();
    for (const p of schedules) for (let month=from.slice(0,7);month<=to.slice(0,7);) {
      const date=month+'-'+String(p.day_of_month).padStart(2,'0'), ref='GIDER-PLAN-'+p.id+'-'+month;
      if (date>=from && date<=to && date>=p.starts_on && (!p.ends_on || date<=p.ends_on) && !generated.has(ref)) add({id:'schedule:'+p.id+':'+month,kind:'schedule',group:'expected',state:'scheduled',direction:'outgoing',date,amount_cents:null,net_cents:p.amount_cents,basis:'net',reference:ref,label:p.label,
        note:'Kayıtlı sabit gider planı. Henüz gider oluşturulmadı; KDV dahil ödeme tutarı bilinmiyor.',source_link:link(ns === 'ec' ? '#expenses' : '#accounts',ns === 'ec' ? {} : {view:'expenses'})});
      const [year,m] = month.split('-').map(Number); month = m === 12 ? String(year+1).padStart(4,'0')+'-01' : String(year).padStart(4,'0')+'-'+String(m+1).padStart(2,'0');
    }
  }
  rows.sort((a,b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99') || a.id.localeCompare(b.id));
  const period = rows.filter(r => r.in_range), expected = period.filter(r => r.group === 'expected'), actual = period.filter(r => r.group === 'recorded');
  const grouped = list => Object.fromEntries(['incoming','outgoing'].map(direction => {
    const items=list.filter(r => r.direction === direction), known=items.filter(r => integer(r.amount_cents));
    return [direction,{count:items.length,amount_cents:sum(items.map(r => r.amount_cents)),known_cents:sum(known.map(r => r.amount_cents)),unknown:items.length-known.length,net_only_cents:sum(items.filter(r => r.basis === 'net').map(r => r.net_cents))}];
  }));
  const actualTotals=grouped(actual), inCents=actualTotals.incoming.amount_cents,outCents=actualTotals.outgoing.amount_cents;
  return {workspace:ns,mode:'calendar',...range,as_of:new Date().toISOString(),rows,
    access:{expenses:expensesAllowed},summary:{expected:grouped(expected),recorded:actualTotals,
      recorded_net_cents:inCents === null || outCents === null ? null : sum([inCents,-outCents]),
      bank_confirmed_incoming_cents:sum(actual.filter(r => r.state === 'bank_confirmed' && r.direction === 'incoming').map(r => r.amount_cents)),
      overdue:grouped(rows.filter(r => r.overdue)),undated:grouped(rows.filter(r => r.date === null))},
    notice:'Bekleyenler bugünkü açık kayıtları gösterir. Tarih seçimi ödeme/plan gününü ve kasa hareketini süzer; geçmiş gün sonu bakiyesi değildir. Tarihsiz kayıtlar ve önceki vadeler ayrıca listelenir.',
    cash_notice:'Giriş ve çıkışlar kasa/banka kayıtlarıdır; ters kayıt kendi gününde etkiler. Pazaryeri rapor bildirimi tahsilat veya kesin alacak sayılmaz. Net gider planı KDV dahil nakit tutarına eklenmez.'};
}

async function businessResult(env, range, user) {
  const {from,to} = range, db=env.DB;
  // Uses the engine's stable cursor and twin de-duplication, not page totals or another formula.
  const performance = await tumSatirlar(env,{mode:'delivered',from,to});
  const packageRows=performance.rows.map(r => ({id:r.id,channel:r.channel,reference:r.order_no || r.external_id,label:r.urun || 'Paket',date:r.delivered_on,
    profit_cents:r.profit_cents ?? null,revenue_net_cents:r.revenue_net_cents ?? null,cost_net_cents:r.cost_net_cents ?? null,
    shipping_cents:r.shipping_cents ?? null,commission_cents:r.commission_cents ?? null,other_cents:r.other_cents ?? null,
    estimated:!!(r.fees_estimated || r.cost_estimated),missing:r.missing || [],note:r.cost_note || '',
    source_link:link(can(user,'ec','orders') ? '#orders' : '#performance',{from,to,...(can(user,'ec','orders') ? {package:r.id} : {mode:'delivered'})})}));
  const expenses = await readRows(db,`SELECT e.id,e.reference,e.category,e.label,e.amount_cents,e.occurred_on,e.notes,l.invoice_id
    FROM expenses e LEFT JOIN purchase_lines l ON e.reference='invoice-'||l.id LEFT JOIN purchase_invoices i ON i.id=l.invoice_id
    WHERE e.archived_at IS NULL AND e.occurred_on BETWEEN ? AND ?
    AND (l.id IS NULL OR (l.line_type='expense' AND l.expense_treatment='general' AND i.status='posted'))`,[from,to]);
  // Original general invoice expense stays at original net value. Apply each dated correction
  // exactly once (including reversals), never subtract effective_net as well as the correction.
  const adjustments=await readRows(db,`SELECT a.id,a.reference,'purchase_correction' category,a.reason label,
    iif(a.reversal_of IS NULL,a.stock_cents-a.net_cents,a.net_cents-a.stock_cents) amount_cents,a.occurred_on,a.reason notes,l.invoice_id
    FROM purchase_adjustments a JOIN purchase_lines l ON l.id=a.line_id
    WHERE a.occurred_on BETWEEN ? AND ? AND (a.kind='price' OR (a.kind='service' AND l.expense_treatment='general'
      AND EXISTS(SELECT 1 FROM expenses e WHERE e.reference='invoice-'||l.id AND e.archived_at IS NULL)))`,[from,to]);
  const returns=await readRows(db,`SELECT r.id,r.reference,'purchase_variance' category,r.reason label,
    iif(r.reversal_of IS NULL,r.cost_cents-r.net_cents,r.net_cents-r.cost_cents) amount_cents,r.occurred_on,r.reason notes,l.invoice_id
    FROM purchase_returns r JOIN purchase_lines l ON l.id=r.line_id WHERE r.occurred_on BETWEEN ? AND ? AND r.cost_cents!=r.net_cents`,[from,to]);
  const revaluations=await readRows(db,`SELECT c.id,'kapanis-kayip:'||c.id reference,'loss' category,'Stok kaybı maliyet farkı' label,c.value_cents amount_cents,m.occurred_on,
    'Geçici sayımla kapanan kayıp malın gerçek fatura farkı' notes,NULL invoice_id
    FROM ec_close_cost_revaluations c JOIN stock_movements m ON m.id=c.movement_id WHERE c.kind='kayip' AND m.occurred_on BETWEEN ? AND ?`,[from,to]);
  const mapExpense=(e,source) => ({id:source+':'+e.id,reference:e.reference,category:e.category,label:e.label || categories[e.category] || 'Gider',
    amount_cents:e.amount_cents,date:e.occurred_on,note:e.notes,source,
    source_link:link('#expenses',{from:e.occurred_on,to:e.occurred_on})});
  const overhead=[...expenses.map(e => mapExpense(e,'expense')),...adjustments.map(e => mapExpense(e,'adjustment')),...returns.map(e => mapExpense(e,'return_variance')),...revaluations.map(e => mapExpense(e,'loss_revaluation'))];
  const contribution=sum(packageRows.map(r => r.profit_cents)), knownPackages=packageRows.filter(r => integer(r.profit_cents));
  const overheadTotal=sum(overhead.map(e => e.amount_cents));
  const knownContribution=knownPackages.length || !packageRows.length ? sum(knownPackages.map(r => r.profit_cents)) : null;
  const calculated=knownContribution !== null && overheadTotal !== null ? sum([knownContribution,-overheadTotal]) : null;
  const missing=packageRows.length-knownPackages.length,estimated=packageRows.filter(r => r.estimated).length;
  const pending=performance.unallocated_fee_cents;
  const status=missing || contribution === null || overheadTotal === null || !integer(pending) || pending !== 0 ? 'incomplete'
    : !overhead.length && !packageRows.length ? 'no_activity' : !overhead.length ? 'overhead_missing' : estimated ? 'estimated' : 'recorded';
  const valid=['recorded','estimated'].includes(status);
  return {workspace:'ec',mode:'result',...range,as_of:new Date().toISOString(),basis:'net',status,
    summary:{packages:packageRows.length,missing_packages:missing,estimated_packages:estimated,overhead_records:overhead.length,
      revenue_net_cents:sum(packageRows.map(r => r.revenue_net_cents)),cost_net_cents:sum(packageRows.map(r => r.cost_net_cents)),
      contribution_cents:contribution,calculated_contribution_cents:knownContribution,overhead_cents:overheadTotal,
      operating_result_cents:valid ? sum([contribution,-overheadTotal]) : null,calculated_result_cents:calculated,
      unallocated_fee_cents:integer(pending) ? pending : null},packages:packageRows,overhead,
    expense_categories:[...new Set(overhead.map(e => e.category))].map(category => ({category,label:categories[category] || category,amount_cents:sum(overhead.filter(e => e.category===category).map(e => e.amount_cents))})),
    notice:'KDV hariç işletme sonucu: teslim dönemindeki Trendyol ve Hepsiburada paket katkısı eksi bu dönemde kaydedilen ortak giderler. Web mağaza, diğer satışlar ve üretim alanı bu kapsama girmez. Sonradan işlenen iadeler ortak satış raporundaki gibi teslim dönemine yansır.',
    cost_notice:'Ürün maliyeti paket katkısında bir kez düşülür. Mal alışları, borç ödemeleri ve para çekimleri yeniden gider değildir. Gelir/kurumlar vergisi dahil değildir; şirketin net kârı veya banka bakiyesi değildir.',
    completeness_notice:!overhead.length ? 'Bu dönemde genel gider kaydı yok. Görülen paket katkısı işletmenin net kârı sayılmaz.' : 'Yalnız kaydedilmiş ortak giderler kapsanır; bu kayıtlar tüm işletme giderlerinin eksiksiz olduğunu doğrulamaz.',
    unallocated_notice:'Dağıtılmamış kesinti tutarı çalışma alanının tamamına aittir; bu döneme yeniden gider yazılmaz ve sonuç kesinleşmiş gösterilmez.'};
}





