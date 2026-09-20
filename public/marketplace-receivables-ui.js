const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
const money = value => value === null || value === undefined ? 'Gösterilemiyor' : new Intl.NumberFormat('tr-TR', {style:'currency', currency:'TRY'}).format(value / 100);
const provider = value => ({trendyol:'Trendyol', hepsiburada:'Hepsiburada'}[value] || value);
const sections = [['all','Tüm kayıtlar'], ['dated','Tarihli kayıtlar'], ['undated','Tarihi belirsiz'], ['unreferenced','Sipariş referansı yok']];

export function renderMarketplaceReceivables(data) {
  const {filters, summary, pagination} = data;
  const form = `<form data-receivables-form class="v2-toolbar"><label>Rapor mağazası<select name="store_id"><option value="">Mağaza seçin</option>${data.stores.map(store => `<option value="${esc(store.id)}" ${store.id === data.store_id ? 'selected' : ''}>${esc(provider(store.provider))} · ${esc(store.name)}</option>`).join('')}</select></label><label>İşlem tarihi başlangıcı<input type="date" name="from" value="${esc(filters.from)}"></label><label>İşlem tarihi bitişi<input type="date" name="to" value="${esc(filters.to)}"></label><label>Kayıt kapsamı<select name="section">${sections.map(([value, name]) => `<option value="${value}" ${filters.section === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label><button class="secondary" type="submit">Göster</button></form>`;
  const status = row => row.evidence_status === 'consistent' ? 'Raporda bildirildi' : 'Tek tutar gösterilmiyor';
  const rows = data.rows.map(row => `<tr role="row">
    <td role="cell" data-label="Sipariş" class="mr-order"><div class="mr-cell-value"><strong class="mr-order-number">${esc(row.order_no || 'Referans yok')}</strong><small>${row.package_count} paket · ${row.finance_record_count} finans kaydı</small></div></td>
    <td role="cell" data-label="İşlem tarihi" class="mr-date"><div class="mr-cell-value">${esc(row.event_date || 'Tarihi belirsiz')}<small>${esc(row.date_note || '')}</small></div></td>
    <td role="cell" data-label="Bildirilen net" class="mr-net"><div class="mr-cell-value"><span class="mr-money">${money(row.reported_net_cents)}</span><small>${status(row)}</small></div></td>
    <td role="cell" data-label="Kapsam ve kanıt" class="mr-evidence"><div class="mr-cell-value">${esc(row.reason)}${row.has_refund ? '<small>İade kaydı içeriyor. Bildirilen netten tekrar düşülmedi.</small>' : ''}${row.has_payout_event ? '<small>Ödeme/hakediş satırı var; banka teyidi değildir.</small>' : ''}<details><summary>Bildirim kanıtı · ${row.net_observation_count} kaynak satır</summary>${row.observations.length ? `<ul>${row.observations.map(item => `<li>Rapor satırı ${item.row_no} · <span class="mr-money">${money(item.reported_net_cents)}</span> · ${esc(item.event_date || 'İşlem tarihi yok')}${item.payout_date ? ' · Ödeme/vade alanı: ' + esc(item.payout_date) : ''}</li>`).join('')}</ul>` : '<p>Net hakediş alanı bulunmuyor.</p>'}${row.observations_truncated ? '<p>İlk 12 kaynak satır gösteriliyor; hiçbir satır toplamdan sessizce çıkarılmadı.</p>' : ''}<p>Aynı kaynak satırının kesinti ve iade olayları net tutarı çoğaltmaz.</p></details></div></td>
  </tr>`).join('');
  const table = rows ? `<div class="table-wrap mr-table-wrap"><table class="v2-table mr-table" role="table"><caption>Seçili mağazanın rapor bildirimleri</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Sipariş</th><th scope="col" role="columnheader">İşlem tarihi</th><th scope="col" role="columnheader">Bildirilen net</th><th scope="col" role="columnheader">Kapsam ve kanıt</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : `<div class="v2-empty"><h3>${data.store_id ? 'Bu kapsamda kayıt yok.' : 'Rapor mağazasını seçin.'}</h3><p>${data.stores.length ? 'Tüm kayıtlar görünümü, tarihi belirsiz ve sipariş referansı olmayan bildirimleri de içerir.' : 'Henüz rapor mağazası bulunmuyor.'}</p></div>`;
  return `<div class="marketplace-receivables"><div class="notice subtle"><strong>Banka doğrulaması yapılmadı.</strong><p>${esc(data.notice)}</p><a href="/eticaret/#bank">Banka ekstresini aç →</a></div>${form}${summary ? `<div class="v2-grid cols-3 mr-summary"><article class="v2-stat"><span class="v2-stat-label">Sipariş grupları</span><strong class="v2-stat-value">${summary.order_count}</strong><small>Seçili mağazanın raporları</small></article><article class="v2-stat"><span class="v2-stat-label">Net bildirimi belirsiz</span><strong class="v2-stat-value">${summary.unresolved_count}</strong><small>Tek tutar gösterilmiyor</small></article><article class="v2-stat"><span class="v2-stat-label">Döneme alınamayan kayıtlar</span><strong class="v2-stat-value">${summary.undated_count + summary.unreferenced_count}</strong><small>${summary.undated_count} tarihi belirsiz · ${summary.unreferenced_count} referanssız</small></article></div><p class="help">${esc(summary.scope_note)} ${summary.outside_period_count} tarihli kayıt seçilen dönemin dışında. Tarih süzgeci, tarihi belirsiz ve referanssız kayıtlara uygulanmaz.</p>` : ''}<section class="v2-card mr-records"><h2>${esc(sections.find(([key]) => key === filters.section)?.[1])}</h2>${table}<div class="ac-actions mr-pagination"><button type="button" class="secondary" data-receivables-page="${pagination.page - 1}" ${pagination.page <= 1 ? 'disabled' : ''}>← Önceki</button><span>Sayfa ${pagination.page} / ${pagination.pages} · ${pagination.total} kayıt</span><button type="button" class="secondary" data-receivables-page="${pagination.page + 1}" ${pagination.page >= pagination.pages ? 'disabled' : ''}>Sonraki →</button></div></section></div>`;
}

export function mountMarketplaceReceivables(root, namespace = 'ec') {
  if (namespace !== 'ec') throw new Error('Bu görünüm yalnız e-ticaret içindir.');
  const controller = new AbortController();
  const state = {disposed:false, sequence:0, params:new URLSearchParams()};
  // Ledger date/party filters describe a different dataset; do not silently inherit them.
  async function load() {
    const sequence = ++state.sequence;
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<div class="loading" role="status">Rapor bildirimleri yükleniyor…</div>';
    try {
      const response = await fetch('/api/ec/marketplace-receivables?' + state.params, {signal:controller.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Rapor bildirimleri yüklenemedi.');
      if (state.disposed || sequence !== state.sequence) return;
      root.innerHTML = renderMarketplaceReceivables(data);
    } catch (error) {
      if (!state.disposed && sequence === state.sequence && error.name !== 'AbortError')
        root.innerHTML = `<div class="v2-empty" role="alert"><h3>Rapor bildirimleri yüklenemedi.</h3><p>${esc(error.message)}</p><button type="button" class="secondary" data-receivables-retry>Yeniden dene</button></div>`;
    } finally {
      if (!state.disposed && sequence === state.sequence) root.removeAttribute('aria-busy');
    }
  }
  root.addEventListener('submit', event => {
    if (!event.target.matches('[data-receivables-form]')) return;
    event.preventDefault(); event.stopPropagation();
    const data = new FormData(event.target);
    state.params = new URLSearchParams();
    for (const key of ['store_id','from','to','section']) if (data.get(key)) state.params.set(key, data.get(key));
    load();
  }, {signal:controller.signal});
  root.addEventListener('click', event => {
    const page = event.target.closest('[data-receivables-page]');
    if (page && !page.disabled) { state.params.set('page', page.dataset.receivablesPage); load(); }
    else if (event.target.closest('[data-receivables-retry]')) load();
  }, {signal:controller.signal});
  load();
  return () => { state.disposed = true; controller.abort(); root.removeAttribute('aria-busy'); };
}
