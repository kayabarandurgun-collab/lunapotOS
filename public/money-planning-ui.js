import {can} from './permissions.js';
import {isISODate,todayInIstanbul,validateDateRange} from './date-range.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const planningMoney = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(value/100) : 'Bilgi eksik';
const dateText = value => isISODate(value) ? new Date(value+'T12:00:00Z').toLocaleDateString('tr-TR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}) : 'Tarihi bilinmiyor';
const statusNames={expected:'Beklenen',cheque_pending:'Çek vadesi',recorded:'Kayıtlı hareket',bank_confirmed:'Banka onaylı',reversal:'Ters kayıt',reversed:'Geri alınmış kayıt',unpaid_expense:'Ödeme bilgisi yok',scheduled:'Sabit gider planı'};
const resultNames={recorded:'Kayıtlara göre hesaplandı',estimated:'Tahmini bilgiler içeriyor',incomplete:'Bilgi eksik',overhead_missing:'Genel gider kaydı yok',no_activity:'Bu dönemde kayıt yok'};
const sourceLink = (href,label='Kaydı aç') => typeof href === 'string' && /^#(?:ledger|expenses|accounts|performance|orders)(?:\?|$)/.test(href) ? `<a class="mp-link" href="${esc(href)}">${esc(label)} <span aria-hidden="true">↗</span></a>` : '';
const badge = (label,kind='') => `<span class="mp-badge ${kind}">${esc(label)}</span>`;
const metric = (label,value,note,tone='') => `<article class="mp-metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
const empty = text => `<p class="mp-empty">${esc(text)}</p>`;
const monthRange = (today,delta=0) => {
  const start=new Date(today+'T12:00:00Z');start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()+delta);
  const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
};

function eventMarkup(row) {
  const amount=row.amount_cents === null ? planningMoney(row.net_cents)+' · KDV hariç' : planningMoney(row.amount_cents);
  return `<li class="mp-event"><details><summary><span class="mp-direction ${row.direction === 'incoming' ? 'mp-in' : 'mp-out'}" aria-label="${row.direction === 'incoming' ? 'Giriş' : 'Çıkış'}">${row.direction === 'incoming' ? '↙' : '↗'}</span><span class="mp-event-main"><strong>${esc(row.party_name || row.account_name || row.label)}</strong><small>${esc(row.reference || row.label)}</small><span class="mp-tags">${badge(statusNames[row.state] || 'Kayıt')}${row.group === 'future_record' ? badge('İleri tarihli kayıt','mp-warning') : ''}${row.overdue ? badge('Vadesi geçti','mp-warning') : ''}${row.basis === 'net' ? badge('Nakit tutarı bilinmiyor') : ''}</span></span><span class="mp-event-amount">${esc(amount)}<small>${row.direction === 'incoming' ? 'Giriş' : 'Çıkış'}</small></span></summary><div class="mp-event-detail"><p>${esc(row.note)}</p><dl><div><dt>Açıklama</dt><dd>${esc(row.label)}</dd></div><div><dt>Referans</dt><dd>${esc(row.reference)}</dd></div>${row.occurred_on ? `<div><dt>Kayıt tarihi</dt><dd>${esc(dateText(row.occurred_on))}</dd></div>` : ''}${row.due_on ? `<div><dt>Belgedeki vade</dt><dd>${esc(dateText(row.due_on))}</dd></div>` : ''}${row.planned_on ? `<div><dt>Planlanan gün</dt><dd>${esc(dateText(row.planned_on))}</dd></div>` : ''}${row.account_name ? `<div><dt>Hesap</dt><dd>${esc(row.account_name)}</dd></div>` : ''}</dl>${sourceLink(row.source_link)}</div></details></li>`;
}
function eventGroups(rows) {
  if (!rows.length) return empty('Bu seçimde kayıt yok.');
  const dates=[...new Set(rows.map(r => r.date))];
  return dates.map(date => `<section class="mp-day"><h3>${esc(dateText(date))}</h3><ol class="mp-events">${rows.filter(r => r.date === date).map(eventMarkup).join('')}</ol></section>`).join('');
}
function monthGrid(data,selected) {
  if (data.from.slice(0,7) !== data.to.slice(0,7)) return '';
  const from=data.from.slice(0,7)+'-01',end=monthRange(from).to,count=Number(end.slice(-2));
  const offset=(new Date(from+'T12:00:00Z').getUTCDay()+6)%7, cells=[];
  for(let n=0;n<offset;n++) cells.push('<span class="mp-calendar-blank" aria-hidden="true"></span>');
  for(let n=1;n<=count;n++) {
    const date=from.slice(0,8)+String(n).padStart(2,'0'),rows=data.rows.filter(r => r.date === date && r.in_range);
    const incoming=rows.filter(r => r.direction === 'incoming').length,outgoing=rows.filter(r => r.direction === 'outgoing').length;
    cells.push(`<button type="button" class="mp-calendar-day ${date === data.today ? 'mp-today' : ''}" data-money-day="${date}" aria-pressed="${selected === date}" aria-label="${esc(dateText(date))}, ${incoming} giriş, ${outgoing} çıkış" ${date < data.from || date > data.to ? 'disabled' : ''}><span>${n}</span>${rows.length ? `<small>${rows.length} kayıt</small><span class="mp-dots">${incoming ? '<i class="mp-in-dot"></i>' : ''}${outgoing ? '<i class="mp-out-dot"></i>' : ''}</span>` : ''}</button>`);
  }
  return `<section class="mp-calendar" aria-label="Gün seçimi"><div class="mp-section-head"><h2>Gün seç</h2>${selected ? '<button class="mp-button" type="button" data-money-clear-day>Tüm günler</button>' : '<span>Bir güne dokun</span>'}</div><div class="mp-weekdays" aria-hidden="true">${['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'].map(d=>'<span>'+d+'</span>').join('')}</div><div class="mp-calendar-grid">${cells.join('')}</div></section>`;
}

export function moneyCalendarMarkup(data,{filter='all',selectedDate=''}={}) {
  const {summary:s}=data, totalsNote=t => t.unknown ? `${t.unknown} kayıtta nakit tutarı bilinmiyor · bilinen ${planningMoney(t.known_cents)}` : `${t.count} kayıt · KDV dahil`;
  const passes=r => filter === 'all' || filter === 'expected' && r.group === 'expected' || filter === 'recorded' && r.group === 'recorded' || filter === 'overdue' && r.overdue || filter === r.direction;
  const period=data.rows.filter(r => r.in_range && passes(r) && (!selectedDate || r.date === selectedDate));
  const late=data.rows.filter(r => r.bucket === 'overdue_outside_period' && passes(r)),undated=data.rows.filter(r => r.date === null && passes(r));
  return `<div class="mp-metrics">${metric('Beklenen giriş',planningMoney(s.expected.incoming.amount_cents),totalsNote(s.expected.incoming),'mp-sage')}${metric('Beklenen çıkış',planningMoney(s.expected.outgoing.amount_cents),totalsNote(s.expected.outgoing),'mp-lavender')}${metric('Kayıtlı giriş',planningMoney(s.recorded.incoming.amount_cents),'Banka onaylı bölüm: '+planningMoney(s.bank_confirmed_incoming_cents),'mp-blue')}${metric('Kayıtlı çıkış',planningMoney(s.recorded.outgoing.amount_cents),'Dönem farkı: '+planningMoney(s.recorded_net_cents))}</div>
    <p class="mp-caption">Özetler seçilen dönemin tamamına aittir. Aşağıdaki seçimler yalnız kayıt listesini süzer.</p>
    ${data.access.expenses ? '' : '<p class="mp-notice">Genel gider yetkiniz olmadığı için gider kayıtları ve sabit gider planları bu görünümde yer almıyor.</p>'}
    <div class="mp-filters" role="group" aria-label="Kayıt türü">${[['all','Tümü'],['expected','Beklenen'],['recorded','Kayıtlı hareket'],['incoming','Girişler'],['outgoing','Çıkışlar'],['overdue','Vadesi geçen']].map(([key,label])=>`<button type="button" class="mp-button" data-money-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</div>
    <div class="mp-calendar-layout">${monthGrid(data,selectedDate)}<section class="mp-agenda"><div class="mp-section-head"><h2>${selectedDate ? esc(dateText(selectedDate)) : 'Dönemin para hareketleri'}</h2><span>${period.length} kayıt</span></div>${eventGroups(period)}</section></div>
    ${late.length ? `<section class="mp-section"><div class="mp-section-head"><h2>Dönem dışındaki açık vadeler</h2><span>${late.length} açık kayıt</span></div><p class="mp-caption">Seçilen dönem dışındaki, bugün hâlâ açık vadeler. Planlanan gün sonradan değiştirilmiş olabilir.</p>${eventGroups(late)}</section>` : ''}
    ${undated.length ? `<section class="mp-section"><div class="mp-section-head"><h2>Tarihi bilinmeyenler</h2><span>${undated.length} kayıt</span></div><p class="mp-caption">Gün belli olmadığından dönem toplamına dahil edilmedi. Kaynak kayıttan inceleyebilirsin.</p>${eventGroups(undated)}</section>` : ''}
    <details class="mp-method"><summary>Kapsam ve kayıt yöntemi</summary><p>${esc(data.notice)}</p><p>${esc(data.cash_notice)}</p></details>`;
}

export function businessResultMarkup(data) {
  const s=data.summary,incomplete=s.operating_result_cents === null;
  return `<div class="mp-metrics">${metric('Paket katkısı',planningMoney(s.contribution_cents),`${s.packages} sonuçlanan paket · KDV hariç`,'mp-blue')}${metric('Ortak giderler',planningMoney(s.overhead_cents),`${s.overhead_records} gider ve düzeltme · KDV hariç`,'mp-lavender')}${s.other_income_records ? metric('Satış dışı gelir',planningMoney(s.other_income_cents),`${s.other_income_records} tazminat / diğer gelir · sonuca eklenir`,'mp-blue') : ''}${metric('İşletme sonucu',planningMoney(s.operating_result_cents),resultNames[data.status] || 'Durum bilinmiyor','mp-sage')}</div>
    <section class="mp-result-summary"><div><span class="mp-eyebrow">KDV HARİÇ · SEÇİLEN DÖNEM</span><h2>Satıştan işletmeye kalan</h2><p>Paket katkısı − kayıtlı ortak giderler${s.other_income_records ? ' + satış dışı gelirler' : ''}</p></div>${badge(resultNames[data.status] || 'Bilgi eksik',incomplete ? 'mp-warning' : '')}</section>
    <p class="mp-notice">${esc(data.completeness_notice)}</p>${s.missing_packages ? `<p class="mp-notice">${s.missing_packages} paketin katkısı hesaplanamıyor. Tam işletme sonucu gösterilmedi.</p>` : ''}${s.estimated_packages ? `<p class="mp-notice">${s.estimated_packages} paket tahmini bilgi içeriyor. Sonuç kayıtlar tamamlandıkça değişebilir.</p>` : ''}${s.unallocated_fee_cents !== 0 ? `<p class="mp-notice">Dağıtılmamış kesinti: ${esc(planningMoney(s.unallocated_fee_cents))}. ${esc(data.unallocated_notice)}</p>` : ''}
    ${incomplete && s.calculated_result_cents !== null ? `<p class="mp-caption">Hesaplanabilen paketler eksi kayıtlı giderler: <strong>${esc(planningMoney(s.calculated_result_cents))}</strong>. Bu kısmi tutar tam işletme sonucu değildir.</p>` : ''}
    <div class="mp-result-columns"><section class="mp-section"><div class="mp-section-head"><h2>Gider dağılımı</h2><span>KDV hariç</span></div>${data.expense_categories.length ? `<dl class="mp-category-list">${data.expense_categories.map(e=>`<div><dt>${esc(e.label)}</dt><dd>${esc(planningMoney(e.amount_cents))}</dd></div>`).join('')}</dl>` : empty('Bu dönemde ortak gider kaydı bulunamadı.')}</section><section class="mp-section"><h2>Hesabın kapsamı</h2><p>${esc(data.notice)}</p><p>${esc(data.cost_notice)}</p></section></div>
    <section class="mp-section"><details class="mp-source-list"><summary>Paket kaynakları <span>${data.packages.length} paket</span></summary>${data.packages.length ? `<ol class="mp-events">${data.packages.map(r=>`<li class="mp-source-row"><div><strong>${esc(r.reference)}</strong><small>${esc(r.label)} · ${esc(dateText(r.date))}</small>${r.estimated ? badge('Tahmini','mp-warning') : ''}${r.missing.map(text=>'<p class="mp-caption">'+esc(text)+'</p>').join('')}${r.note?'<p class="mp-caption">'+esc(r.note)+'</p>':''}</div><div><strong>${esc(planningMoney(r.profit_cents))}</strong>${sourceLink(r.source_link,'Paketi incele')}</div></li>`).join('')}</ol>` : empty('Bu kapsamda sonuçlanan paket yok.')}</details></section>
    <section class="mp-section"><details class="mp-source-list"><summary>Gider ve düzeltme kaynakları <span>${data.overhead.length} kayıt</span></summary>${data.overhead.length ? `<ol class="mp-events">${data.overhead.map(r=>`<li class="mp-source-row"><div><strong>${esc(r.label)}</strong><small>${esc(r.reference)} · ${esc(dateText(r.date))}</small><p class="mp-caption">${esc(r.note)}</p></div><div><strong>${esc(planningMoney(r.amount_cents))}</strong>${sourceLink(r.source_link,'Gideri incele')}</div></li>`).join('')}</ol>` : empty('Bu dönemde gider kaydı yok.')}</details></section>`;
}

/** Route owner calls the returned disposer before mounting another view. No business data is persisted. */
export function mountMoneyPlanning(root,ns,user,mode='calendar') {
  if (!['ec','lp'].includes(ns) || !['calendar','result'].includes(mode)) throw Error('Çalışma alanı veya ekran geçersiz.');
  const allowed=mode === 'calendar' ? ['ledger','amounts'].every(k=>can(user,ns,k)) : ns === 'ec' && ['performance','expenses','amounts'].every(k=>can(user,ns,k));
  const abort=new AbortController();let requestAbort=null,sequence=0,disposed=false,data=null,busy=false,error='',filter='all',selectedDate='';
  const today=todayInIstanbul(),params=new URLSearchParams(globalThis.location?.hash.split('?')[1] || ''),defaults=monthRange(today);
  let range={from:params.get('from') ?? defaults.from,to:params.get('to') ?? (mode === 'result' ? today : defaults.to)};
  let inputError=['from','to'].some(k=>params.getAll(k).length>1) ? 'Tarih birden fazla gönderilemez.' : validateDateRange(range.from,range.to);
  const route=mode === 'calendar' ? '#money' : '#business-result';
  root.classList.add('money-planning');
  function remember() {
    if (globalThis.history?.replaceState) history.replaceState(null,'',route+'?'+new URLSearchParams(range));
  }
  function render() {
    if(disposed) return;
    root.setAttribute('aria-busy',String(busy));
    if(!allowed){root.innerHTML='<section class="mp-empty"><h1>Bu görünüm için yetki gerekiyor</h1><p>Kaynak kayıtları ve tutarları görme yetkisi olmadan bu görünüm açılamaz.</p></section>';return;}
    const resultLink=ns === 'ec' && ['performance','expenses','amounts'].every(k=>can(user,ns,k)),moneyLink=['ledger','amounts'].every(k=>can(user,ns,k));
    root.innerHTML=`<header class="mp-header"><div><span class="mp-eyebrow">${ns === 'ec' ? 'E-TİCARET' : 'ÜRETİM'} · PARA</span><h1>${mode === 'calendar' ? 'Ödeme takvimi' : 'İşletme sonucu'}</h1><p>${mode === 'calendar' ? 'Beklenen ödemeler ve kaydedilmiş para hareketleri, gün gün.' : 'Satış katkısını ortak giderlerle birlikte gör.'}</p></div><nav class="mp-view-switch" aria-label="Para görünümleri">${moneyLink ? `<a href="#money" ${mode==='calendar'?'aria-current="page"':''}>Ödeme takvimi</a>` : ''}${resultLink ? `<a href="#business-result" ${mode==='result'?'aria-current="page"':''}>İşletme sonucu</a>` : ''}</nav></header>
      <section class="mp-period" aria-label="Dönem seçimi"><div class="mp-period-actions"><button type="button" class="mp-button" data-money-month="-1" ${busy?'disabled':''}>← Önceki ay</button><button type="button" class="mp-button" data-money-current ${busy?'disabled':''}>Bu ay</button><button type="button" class="mp-button" data-money-month="1" ${busy || mode==='result' && range.to>=today?'disabled':''}>Sonraki ay →</button></div><form data-money-range><label>Başlangıç<input name="from" type="date" value="${esc(range.from)}" required ${busy?'disabled':''}></label><label>Bitiş<input name="to" type="date" value="${esc(range.to)}" ${mode==='result'?`max="${today}"`:''} required ${busy?'disabled':''}></label><button class="mp-button mp-primary" type="submit" ${busy?'disabled':''}>Dönemi göster</button></form></section>
      ${error ? `<div class="mp-notice" role="alert"><p>${esc(error)}</p><button type="button" class="mp-button" data-money-retry>Yeniden dene</button></div>` : busy ? '<div class="mp-loading" role="status">Kayıtlar ve hesaplar hazırlanıyor…</div>' : data ? (mode === 'calendar' ? moneyCalendarMarkup(data,{filter,selectedDate}) : businessResultMarkup(data)) : ''}`;
  }
  async function load() {
    const mine=++sequence;requestAbort?.abort();requestAbort=new AbortController();const signal=requestAbort.signal;
    busy=true;error='';data=null;render();
    try {
      if(inputError)throw Error(inputError);
      const invalid=validateDateRange(range.from,range.to);if(invalid)throw Error(invalid);
      const requested={...range};
      const response=await fetch(`/api/${ns}/${mode==='calendar'?'money-calendar':'business-result'}?`+new URLSearchParams(requested),{signal,cache:'no-store'});
      const payload=await response.json();
      if(disposed || signal.aborted || mine!==sequence)return;
      if(!response.ok)throw Error(payload.error || 'Kayıtlar alınamadı.');
      if(payload.workspace!==ns || payload.mode!==mode || payload.from!==requested.from || payload.to!==requested.to)throw Error('Yanıtın çalışma alanı ve tarih aralığı doğrulanamadı.');
      data=payload;remember();
    } catch(e) {if(disposed || mine!==sequence || signal.aborted || e.name==='AbortError')return;error=e.message || 'Kayıtlar alınamadı.';}
    if(disposed || mine!==sequence || signal.aborted)return;busy=false;render();
  }
  root.addEventListener('submit',event=>{
    if(!event.target.matches('[data-money-range]'))return;event.preventDefault();if(busy)return;
    range={from:event.target.elements.namedItem('from').value,to:event.target.elements.namedItem('to').value};inputError=validateDateRange(range.from,range.to);selectedDate='';load();
  },{signal:abort.signal});
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-money-month],[data-money-current],[data-money-retry],[data-money-filter],[data-money-day],[data-money-clear-day]');
    if(!button || !root.contains(button) || button.disabled || busy)return;
    if(button.hasAttribute('data-money-retry')){load();return;}
    if(button.hasAttribute('data-money-filter')){filter=button.dataset.moneyFilter;render();root.querySelector(`[data-money-filter="${filter}"]`)?.focus();return;}
    if(button.hasAttribute('data-money-day')){selectedDate=selectedDate===button.dataset.moneyDay?'':button.dataset.moneyDay;render();root.querySelector(`[data-money-day="${button.dataset.moneyDay}"]`)?.focus();return;}
    if(button.hasAttribute('data-money-clear-day')){selectedDate='';render();return;}
    const base=isISODate(range.from)?range.from:today;range=monthRange(button.hasAttribute('data-money-current')?today:base,Number(button.dataset.moneyMonth || 0));
    if(mode==='result' && range.to>today)range.to=today;
    inputError=validateDateRange(range.from,range.to);selectedDate='';load();
  },{signal:abort.signal});
  if(allowed)load();else render();
  return ()=>{disposed=true;sequence++;requestAbort?.abort();abort.abort();data=null;root.classList.remove('money-planning');root.removeAttribute('aria-busy');};
}


