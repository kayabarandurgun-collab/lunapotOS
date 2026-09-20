const DAY = 86400000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const DATE_PRESETS = Object.freeze([
  ['1g', 'Bugün', 1], ['7g', '7 gün', 7], ['14g', '2 hafta', 14],
  ['30g', '30 gün', 30], ['90g', '3 ay', 90], ['180g', '6 ay', 180],
  ['tum', 'Tüm dönem', null], ['custom', 'Özel aralık', null]
].map(([key, label, days]) => Object.freeze({key, label, days})));
export const todayInIstanbul = () => new Date().toLocaleDateString('sv-SE', {timeZone:'Europe/Istanbul'});
export function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0,4) !== '0000' &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function validateDateRange(from, to) {
  if (!isISODate(from) || !isISODate(to)) return 'Geçerli bir başlangıç ve bitiş tarihi seçin.';
  if (from > to) return 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
  return null;
}
export function presetDateRange(preset, {today = todayInIstanbul(), firstDate = ''} = {}) {
  if (!isISODate(today)) throw Error('Bugünün tarihi geçersiz.');
  const item = DATE_PRESETS.find(x => x.key === preset);
  if (!item || preset === 'custom') throw Error('Tarih seçimi geçersiz.');
  if (preset === 'tum') return {preset, from:isISODate(firstDate) && firstDate <= today ? firstDate : '', to:isISODate(firstDate) && firstDate <= today ? today : '', error:null};
  return {preset, from:new Date(Date.parse(today) + (1-item.days)*DAY).toISOString().slice(0,10), to:today, error:null};
}
// Pure with an explicit today. Accepts a hash, query string, URLSearchParams or plain object.
// Concrete dates win over rolling presets, so shared URLs keep their original scope.
export function parseDateRange(input = '', options = {}) {
  const params = input instanceof URLSearchParams ? input : typeof input === 'object' ? new URLSearchParams(input) :
    new URLSearchParams(String(input).includes('?') ? String(input).split('?').slice(1).join('?') : String(input).replace(/^[?#]/,''));
  const requested = params.get('donem') || params.get('preset');
  const fallback = presetDateRange(options.defaultPreset || '30g', options);
  if (['from','to','donem'].some(key=>params.getAll(key).length>1)) return {...fallback,error:'Tarih aralığı aynı parametreyi birden fazla içeremez.'};
  if (params.has('from') || params.has('to')) {
    const from = params.get('from'), to = params.get('to'), error = validateDateRange(from,to);
    if (error) return {...fallback, error};
    const known = DATE_PRESETS.some(x => x.key === requested);
    return {preset:known ? requested : 'custom', from,to,error:null};
  }
  if (requested === 'custom') return {...fallback,error:'Özel aralık için başlangıç ve bitiş tarihi seçin.'};
  if (requested && !DATE_PRESETS.some(x => x.key === requested)) return {...fallback,error:'Tarih seçimi tanınmadı; son 30 gün gösteriliyor.'};
  return requested ? presetDateRange(requested,options) : fallback;
}
export function dateRangeQuery(range) {
  if (range.error) throw Error(range.error);
  if (!range.from && !range.to && range.preset === 'tum') return '';
  const error = validateDateRange(range.from,range.to);
  if (error) throw Error(error);
  return new URLSearchParams({from:range.from,to:range.to}).toString();
}
export function dateRangeLink(route, range, extra = {}) {
  const [path,query = ''] = String(route).replace(/^#/,'').split('?');
  const params = new URLSearchParams(query);
  for (const key of ['from','to','donem','preset']) params.delete(key);
  if (range.preset) params.set('donem',range.preset);
  for (const [key,value] of new URLSearchParams(dateRangeQuery(range))) params.set(key,value);
  for (const [key,value] of Object.entries(extra)) {
    if (value == null || value === '') params.delete(key); else params.set(key,String(value));
  }
  return '#'+path+(params.size?'?'+params:'');
}
export function dateRangeLabel(range) {
  if (!range.from && range.preset === 'tum') return 'Kayıtlı tüm dönem';
  if (validateDateRange(range.from,range.to)) return 'Tarih seçilmedi';
  const date = value => new Date(value+'T12:00:00Z').toLocaleDateString('tr-TR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  return range.from === range.to ? date(range.from) : date(range.from)+' – '+date(range.to);
}
export function dateFilterMarkup(range, {busy = false, basis = 'Teslim tarihi', firstDate = ''} = {}) {
  return `<section class="ins-date-filter" data-date-filter data-first-date="${esc(firstDate)}" aria-label="Tarih aralığı" aria-busy="${busy}">
    <div class="ins-date-presets" role="group" aria-label="Hazır tarih aralıkları">${DATE_PRESETS.map(p=>`<button type="button" class="secondary" data-date-preset="${p.key}" aria-pressed="${range.preset===p.key}" ${busy?'disabled':''}>${p.label}</button>`).join('')}</div>
    <div data-date-custom ${range.preset==='custom'||range.error?'':'hidden'}><form class="ins-date-form" data-date-form><label>Başlangıç<input type="date" name="from" value="${esc(range.from)}" required ${busy?'disabled':''}></label><label>Bitiş<input type="date" name="to" value="${esc(range.to)}" required ${busy?'disabled':''}></label><button type="submit" class="secondary" ${busy?'disabled':''}>Aralığı uygula</button></form></div><p class="ins-date-scope">${esc(basis)} · ${esc(dateRangeLabel(range))}</p>
    <p class="error ins-date-error" data-date-error role="alert" ${range.error?'':'hidden'}>${esc(range.error)}</p>
  </section>`;
}
// Delegation survives rerendering. Owners decide whether to navigate or reload in place.
export function bindDateFilter(root, {onChange, signal, today = todayInIstanbul(), firstDate = ''} = {}) {
  const click = event => {
    const button = event.target.closest('[data-date-preset]');
    if (!button || !root.contains(button) || button.disabled) return;
    const host = button.closest('[data-date-filter]');
    if (button.dataset.datePreset === 'custom') {
      host.querySelector('[data-date-custom]').hidden=false;
      for(const preset of host.querySelectorAll('[data-date-preset]'))preset.setAttribute('aria-pressed',String(preset===button));
      host.querySelector('[name="from"]')?.focus();return;
    }
    onChange?.(presetDateRange(button.dataset.datePreset,{today,firstDate:host.dataset.firstDate || firstDate}));
  };
  const submit = event => {
    if (!event.target.matches('[data-date-form]')) return;
    event.preventDefault();
    const form = event.target, from = form.elements.namedItem('from').value, to = form.elements.namedItem('to').value;
    const error = validateDateRange(from,to), box = form.closest('[data-date-filter]').querySelector('[data-date-error]');
    box.textContent = error || '';box.hidden = !error;
    form.elements.namedItem('to').setAttribute('aria-invalid',String(!!error));
    if (error) {form.elements.namedItem('to').focus();return;}
    onChange?.({preset:'custom',from,to,error:null});
  };
  root.addEventListener('click',click,{signal});root.addEventListener('submit',submit,{signal});
  return () => {root.removeEventListener('click',click);root.removeEventListener('submit',submit);};
}
