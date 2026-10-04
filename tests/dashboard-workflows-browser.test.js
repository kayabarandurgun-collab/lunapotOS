import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findPlaywright} from '../scripts/design-audit.mjs';

// Opt in against an ALREADY RUNNING synthetic preview. Never restart/reset it.
// Only GET/HEAD can reach the shared fixture; file bytes remain in the browser.
const preview = process.env.DASHBOARD_PREVIEW_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/dashboard-2026-10-04/workflow-checks');
const documentPath = resolve(root, 'docs/dashboard-2026-10-04/workflows.md');
const command = "$env:DASHBOARD_PREVIEW_URL='http://127.0.0.1:18731'; node --test tests/dashboard-workflows-browser.test.js";
const fence = String.fromCharCode(96).repeat(3);
// Existing policy: VAT and commission-rate metadata are allowed; amounts/margins stay protected.
const moneyKey = /(?:^|_)(?:cents|price|sale_price|unit_cost)$|_(?:cents|bps)$/;
const publicVatKey = /(?:^|_)vat_bps$/;
// tests/komisyon-orani.test.js:177 explicitly permits these three rate fields.
const allowedCommissionKeys = new Set(['commission_rate_bps','komisyon_oran_bps','oran_bps']);
const protectedMoneyNames = new Set([
 'price','sale_price','unit_cost','amount','total_cost','rate_bps','revenue_share_bps','margin_bps','gross','net_revenue',
 'fiyat','maliyet','kargo','hizmet','komisyon','stopaj','paketleme','diger','cebine','istenen','birim_maliyet_kdv_dahil','komisyon_orani','stopaj_orani',
 'report_gross','ledger_gross','missing_gross','commission','shipping','other','package_gross','package_seller_discount','package_platform_discount',
]);
function allowedCommissionRates(data, path = '$', found = []) {
 if (!data || typeof data !== 'object') return found;
 for (const [key, value] of Object.entries(data)) {
  const p = path + (Array.isArray(data) ? '[' + key + ']' : '.' + key);
  if (typeof value === 'number' && (['commission_rate_bps','komisyon_oran_bps'].includes(key) || key === 'oran_bps' && /komisyon/.test(path))) found.push(p + '=' + value);
  if (value && typeof value === 'object') allowedCommissionRates(value, p, found);
 }
 return found;
}
function monetaryLeaves(data, path = '$', found = []) {
  if (!data || typeof data !== 'object') return found;
  const dailyCash = typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date) && Number.isSafeInteger(data.packages) &&
    ['trendyol','hepsiburada'].every(key => Object.hasOwn(data, key) && (typeof data[key] === 'number' || data[key] === null));
  for (const [key, value] of Object.entries(data)) {
    const p = path + (Array.isArray(data) ? '[' + key + ']' : '.' + key);
    if (!publicVatKey.test(key) && !allowedCommissionKeys.has(key) && (moneyKey.test(key) || protectedMoneyNames.has(key) || dailyCash && ['trendyol','hepsiburada'].includes(key)) && value !== null && value !== undefined && typeof value !== 'object' && typeof value !== 'boolean') found.push(p + '=' + String(value));
    if (value && typeof value === 'object') monetaryLeaves(value, p, found);
  }
  return found;
}
function md(value) { return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

test('dashboard workflows: real preview navigation, retained report file, responsive controls and no-amount reader',
  {skip: !preview, timeout: 300000}, async t => {
  const base = new URL(preview);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.pathname, '/');
  assert.equal(base.username + base.password + base.search + base.hash, '');
  const readHealth = async () => {
    const response = await fetch(new URL('/__preview/health', base), {signal: AbortSignal.timeout(15000)});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.local_preview, true); assert.equal(data.synthetic, true); assert.equal(data.network, 'blocked');
    return data;
  };
  const before = await readHealth();
  const evidence = {started: new Date().toISOString(), origin: base.origin, before, after: null, browser: '', cases: [], captures: [], apis: [], blocked: [], errors: []};
  const {api} = await findPlaywright();
  assert.ok(api, 'Installed Playwright is required; no browser/dependency downloads.');
  let browser;
  const launchErrors = [];
  for (const settings of process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? [{executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}]
    : [{channel: 'chrome'}, {channel: 'msedge'}, {}]) {
    try { browser = await api.chromium.launch({headless: true, ...settings}); break; }
    catch (error) { launchErrors.push(error.message.split('\n')[0]); }
  }
  assert.ok(browser, launchErrors.join('; '));
  evidence.browser = browser.version();
  await mkdir(out, {recursive: true});

  async function settle(page) {
    await page.waitForLoadState('networkidle', {timeout: 7000});
    await page.evaluate(() => document.fonts.ready);
  }
  async function contextFor(width, role) {
    const context = await browser.newContext({
      viewport: {width, height: width === 390 ? 844 : 1000},
      locale: 'tr-TR', timezoneId: 'Europe/Istanbul', serviceWorkers: 'block', reducedMotion: 'reduce',
    });
    const blocked = [], errors = [], failed = [], pendingResponses = [], apiBodies = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin || !['GET', 'HEAD'].includes(request.method())) {
        blocked.push(request.method() + ' ' + url.pathname); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.status() >= 400) failed.push(response.status() + ' ' + url.pathname);
      if (role === 'reader' && url.pathname.startsWith('/api/') && response.ok()) {
        pendingResponses.push(response.json().then(data => apiBodies.push({path: url.pathname, data})).catch(() => {}));
      }
    });
    await page.goto(new URL('/__preview/start?scenario=populated&role=' + role + '&next=' + encodeURIComponent('/eticaret/#overview'), base).href);
    await settle(page);
    const auth = await context.request.get(new URL('/api/auth/status', base).href);
    const session = await auth.json();
    assert.equal(session.authenticated, true);
    if (role === 'reader') {
      assert.equal(!!session.user.owner, false);
      assert.equal(session.user.permissions.ec.amounts, 'none');
    }
    return {context, page, width, role, blocked, errors, failed, pendingResponses, apiBodies};
  }

  async function capture(s, name, issues) {
    const {page, width, role} = s;
    await settle(page);
    const layout = await page.evaluate(() => {
      const visible = el => {
        const r = el.getBoundingClientRect(), css = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' &&
          !el.closest('[hidden]') && ![...document.querySelectorAll('details:not([open])')].some(d => d.contains(el) && !d.querySelector(':scope > summary')?.contains(el));
      };
      const describe = el => ({
        text: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.name || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 90),
        tag: el.tagName.toLowerCase(),
        width: Math.round(el.getBoundingClientRect().width * 10) / 10,
        height: Math.round(el.getBoundingClientRect().height * 10) / 10,
      });
      const modal = document.querySelector('dialog[open]');
      const scopes = modal ? [modal] : [...document.querySelectorAll('main,[role=main],.mobile-dock')];
      const controls = [...new Set(scopes.flatMap(scope => [...scope.querySelectorAll('button,input,select,textarea,summary,a[href]')]))]
        .filter(visible).filter(el => !el.disabled && !['hidden', 'file'].includes(el.type))
        // In-text hyperlinks are not standalone touch controls. Check labels for native checkboxes.
        .filter(el => el.tagName !== 'A' || getComputedStyle(el).display !== 'inline')
        .map(el => ['checkbox', 'radio'].includes(el.type) ? el.closest('label') || el : el);
      const short = controls.map(describe).filter(c => c.width < 43.5 || c.height < 43.5);
      return {
        url: location.href, viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        headings: [...document.querySelectorAll('main h1,main h2,dialog[open] h2')].filter(visible).map(e => e.innerText.trim()),
        controls: controls.length, short,
        dialogs: [...document.querySelectorAll('dialog[open]')].map(el => ({...describe(el), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right})),
        alerts: [...document.querySelectorAll('main [role=alert],dialog[open] [role=alert]')].filter(visible).map(e => e.innerText.trim()).filter(Boolean),
        overflowElements: [...document.querySelectorAll('main *')].filter(visible).filter(e => {const r = e.getBoundingClientRect(); return r.left >= 0 && r.right > innerWidth + 1;}).slice(0, 8).map(describe),
      };
    });
    const file = role + '-' + width + '-' + name + '.png';
    await page.screenshot({path: resolve(out, file), fullPage: true, animations: 'disabled'});
    evidence.captures.push({name, width, role, file, ...layout});
    if (layout.overflow) issues.push(name + ': horizontal overflow ' + layout.documentWidth + '/' + layout.viewport + 'px; ' + JSON.stringify(layout.overflowElements));
    if (layout.alerts.length) issues.push(name + ': visible errors: ' + layout.alerts.join('; '));
    if (layout.dialogs.some(d => d.left < -1 || d.right > width + 1)) issues.push(name + ': dialog extends beyond viewport');
    if (width === 390 && layout.short.length) issues.push(name + ': controls below 44px: ' + layout.short.map(c => c.text + ' (' + c.width + '×' + c.height + ')').join('; '));
  }

  async function dashboard(s) {
    await s.page.goto(new URL('/eticaret/#overview', base).href);
    // A hash transition can settle before its async module mounts.
    await s.page.locator(s.role === 'owner' ? 'main .ins-kpis' : 'main .staff-modules').waitFor({state: 'visible', timeout: 20000});
    await settle(s.page);
    assert.equal(new URL(s.page.url()).hash.split('?')[0], '#overview');
    assert.ok((await s.page.locator('main').innerText()).trim().length > 80, 'dashboard contains rendered content');
  }
  async function clickHref(s, hash) {
    const {page} = s;
    // Prefer the actual dashboard action, then the application navigation.
    const selector = 'a[href="' + hash + '"]';
    let link = page.locator('main ' + selector + ':visible').first();
    if (!await link.count()) link = page.locator(selector + ':visible').first();
    if (!await link.count()) {
      const menu = page.getByRole('button', {name: 'Tüm ekranlar', exact: true});
      if (await menu.isVisible()) await menu.click();
      const candidate = page.locator(selector).first();
      assert.ok(await candidate.count(), 'navigation exposes ' + hash);
      const details = candidate.locator('xpath=ancestor::details');
      for (let n = (await details.count()) - 1; n >= 0; n--) {
        if (await details.nth(n).getAttribute('open') === null) await details.nth(n).locator(':scope > summary').click();
      }
      link = page.locator(selector + ':visible').first();
    }
    assert.ok(await link.count(), 'reachable navigation link ' + hash);
    await link.click(); await settle(page);
    assert.equal(new URL(page.url()).hash.split('?')[0], hash.split('?')[0], 'link reaches its distinct screen');
  }
  async function exercise(s, name, work) {
    const entry = {name, width: s.width, role: s.role, status: 'PASS', issues: [], observations: []};
    evidence.cases.push(entry);
    const offsets = {blocked: s.blocked.length, errors: s.errors.length, failed: s.failed.length};
    await t.test(s.width + 'px ' + s.role + ' — ' + name, async () => {
      try { await dashboard(s); await work(entry.issues, entry.observations); }
      catch (error) {
        entry.issues.push(error.message);
        try { await capture(s, name + '-failure', entry.issues); } catch (captureError) { entry.issues.push('Screenshot unavailable: ' + captureError.message); }
      }
      entry.issues.push(...s.blocked.slice(offsets.blocked).map(x => 'Blocked unexpected request: ' + x));
      entry.issues.push(...s.errors.slice(offsets.errors).map(x => 'Browser error: ' + x));
      entry.issues.push(...s.failed.slice(offsets.failed).map(x => 'HTTP failure: ' + x));
      entry.status = entry.issues.length ? 'FAIL' : 'PASS';
      assert.deepEqual(entry.issues, [], entry.name + ': ' + entry.issues.join('\n'));
    });
  }

  try {
    for (const width of [1440, 390]) {
      const s = await contextFor(width, 'owner'), page = s.page;
      try {
        await exercise(s, 'dashboard', async (issues, notes) => {
          await capture(s, 'dashboard', issues);
          notes.push('Populated dashboard rendered; no legacy layout/card-count assertions.');
        });
        await exercise(s, 'report-handoff', async (issues, notes) => {
          await clickHref(s, '#intake');
          await page.getByRole('heading', {name: 'Belge yükle', exact: true}).waitFor();
          // Local synthetic file, intentionally ambiguous: selection must reach the REAL mapper.
          await page.locator('input[type=file]').first().setInputFiles({
            name: 'dashboard-workflow-local.csv', mimeType: 'text/csv',
            buffer: Buffer.from('Alan;Bilgi\nSIDECAR-LOCAL-ONLY;42\n', 'utf8'),
          });
          await page.locator('[data-choice="orders"]').waitFor();
          await capture(s, 'report-choice', issues);
          await page.locator('[data-choice="orders"]').click();
          await page.waitForFunction(() => document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'), null, {timeout: 20000});
          assert.match(await page.locator('[data-wb-child]').innerText(), /dashboard-workflow-local\.csv/);
          await capture(s, 'report-source-handoff', issues);
          // Existing multiple stores require an explicit choice. Source submission
          // only reparses retained bytes/reads profiles; do not submit the mapper.
          for (let attempt = 0; attempt < 3; attempt++) {
            await page.waitForFunction(() => {
              const host = document.querySelector('[data-wb-child]');
              return host?.getAttribute('aria-busy') !== 'true' &&
                host?.querySelector('[data-rb-form="source"],[data-rb-form="map"],[data-rb-act="upload"],.rb-alert.error');
            }, null, {timeout: 20000});
            const source = page.locator('[data-rb-form="source"]');
            if (!await source.count()) break;
            const store = source.locator('[name=store]'), kind = source.locator('[name=kind]');
            if (await store.count()) await store.selectOption({index: 1});
            if (await kind.count()) await kind.selectOption('orders');
            await source.getByRole('button', {name: 'Dosyayı kontrol et', exact: true}).click();
          }
          const child = page.locator('[data-wb-child]');
          assert.deepEqual(await child.locator('.rb-alert.error').allTextContents(), [], 'Retained-file parsing has no error');
          assert.equal(await page.locator('[data-rb="kind"]').inputValue(), 'orders');
          assert.match(await child.innerText(), /dashboard-workflow-local\.csv/);
          const mapper = page.locator('[data-rb-form="map"]');
          if (await mapper.count()) {
            const headers = await mapper.locator('select').first().locator('option').allTextContents();
            assert.ok(headers.includes('Alan') && headers.includes('Bilgi'), 'Original CSV headers reached the mapper');
            assert.match(await child.innerText(), /1 satır/);
            notes.push('Retained filename, orders kind, original column headers and one parsed row reached the existing mapper after store selection.');
          } else {
            await page.locator('[data-rb-act="upload"]').waitFor();
            assert.match(await child.innerText(), /Kontrol|kontrol/);
            notes.push('Existing profile recognized the retained CSV and reached its parsed check step; mapper was legitimately bypassed.');
          }
          await capture(s, 'report-handoff', issues);
          notes.push('No mapping-save, file-upload or apply was submitted.');
        });
        await exercise(s, 'purchase-invoice', async (issues, notes) => {
          await clickHref(s, '#invoices');
          await page.getByRole('heading', {name: 'Fatura geçmişi', exact: true}).waitFor();
          await capture(s, 'purchase-invoices', issues);
          await page.locator('[data-ac="review-invoice"]').first().click();
          await page.locator('dialog[open]').waitFor();
          assert.match(await page.locator('dialog[open]').innerText(), /fatura|tedarikçi/i);
          await capture(s, 'purchase-invoice-review', issues);
          await page.keyboard.press('Escape');
          notes.push('Existing populated invoice opens in the real review dialog; posting, payment and upload are untested.');
        });
        await exercise(s, 'physical-stock', async (issues, notes) => {
          await clickHref(s, '#stock');
          await page.getByRole('button', {name: 'Depo sayımı yap', exact: true}).waitFor();
          await capture(s, 'physical-stock', issues);
          await page.getByRole('button', {name: 'Depo sayımı yap', exact: true}).click();
          const form = page.locator('dialog[open] [data-ac-form="stock"]');
          await form.waitFor();
          await form.locator('[name=product_id]').selectOption({index: 1});
          await form.locator('[name=quantity]').fill('5');
          assert.match(await form.locator('[data-stock-count-preview]').innerText(), /Girilen sayım: 5/);
          assert.match(await form.innerText(), /DAHİL.*HARİÇ/s);
          await capture(s, 'physical-count-preview', issues);
          await page.keyboard.press('Escape');
          notes.push('Physical total input updates the count difference preview; no stock movement saved.');
        });
        await exercise(s, 'unbilled-entry', async (issues, notes) => {
          await clickHref(s, '#stock?action=unbilled');
          const form = page.locator('dialog[open] [data-ac-form="unbilled"]');
          await form.waitFor();
          await form.locator('[name=product_id]').first().selectOption({index: 1});
          await form.locator('[name=quantity]').first().fill('5');
          assert.match(await form.locator('[data-unbilled-preview]').first().innerText(), /Yeni gelen: 5/);
          assert.match(await form.innerText(), /geçici borç/);
          await capture(s, 'unbilled-entry', issues);
          await page.keyboard.press('Escape');
          notes.push('Dashboard action opens unbilled entry and updates incoming quantity preview; no receipt/debt saved.');
        });
        await exercise(s, 'warehouse', async (issues, notes) => {
          await clickHref(s, '#warehouse');
          await page.getByRole('heading', {name: 'Sayım ve tedarik', exact: true}).waitFor();
          await page.getByRole('button', {name: 'Tedarik önerileri', exact: true}).click();
          await page.getByRole('heading', {name: 'Ne kadar almam gerekebilir?', exact: true}).waitFor();
          await capture(s, 'warehouse-reorder', issues);
          await page.getByRole('button', {name: 'Kayıtlı sayımlar', exact: true}).click();
          await page.getByRole('heading', {name: 'Yeni depo sayımı', exact: true}).waitFor();
          await capture(s, 'warehouse-counts', issues);
          notes.push('Both warehouse tabs load real preview data; no counting session created or applied.');
        });
        await exercise(s, 'cari-dossier', async (issues, notes) => {
          await clickHref(s, '#ledger');
          const link = page.locator('main a[href^="#party?id="]').first();
          await link.waitFor();
          const destination = await link.getAttribute('href');
          await link.click(); await settle(page);
          assert.equal(new URL(page.url()).hash, destination);
          await page.locator('main h1').waitFor();
          const name = await page.locator('main h1').innerText();
          assert.ok(name.length > 2);
          await page.getByRole('button', {name: 'Bilgiler', exact: true}).click();
          await capture(s, 'cari-information', issues);
          await page.getByRole('button', {name: 'Faturalar', exact: true}).click(); await settle(page);
          await capture(s, 'cari-invoices', issues);
          notes.push('Actual cari list link opened ' + name + '; information and invoice tabs loaded without edits.');
        });
        await exercise(s, 'payment-calendar', async (issues, notes) => {
          await clickHref(s, '#money');
          await page.getByRole('heading', {name: 'Ödeme takvimi', exact: true}).waitFor();
          await page.getByRole('button', {name: 'Beklenen', exact: true}).click();
          assert.equal(await page.getByRole('button', {name: 'Beklenen', exact: true}).getAttribute('aria-pressed'), 'true');
          const range = page.locator('[data-money-range] [name=from]');
          const current = await range.inputValue();
          await page.getByRole('button', {name: '← Önceki ay', exact: true}).click();
          await page.waitForFunction(old => document.querySelector('[data-money-range] [name=from]')?.value !== old, current);
          await settle(page);
          assert.notEqual(await range.inputValue(), current);
          await capture(s, 'payment-calendar', issues);
          notes.push('Expected-payment filter and previous-month control update the actual calendar.');
        });
        await exercise(s, 'workbench', async (issues, notes) => {
          await clickHref(s, '#workbench');
          await page.getByRole('heading', {name: 'Günlük işler', exact: true}).waitFor();
          await page.getByRole('button', {name: 'Yenile', exact: true}).click(); await settle(page);
          await capture(s, 'workbench', issues);
          const sources = page.locator('main [data-wb-task]');
          notes.push((await sources.count()) + ' task cards rendered from preview data.');
          await page.locator('[data-wb-action="new"]').click();
          await page.locator('dialog[open] [name=title]').waitFor();
          await page.locator('dialog[open] [name=title]').fill('LOCAL UNSAVED WORKFLOW CHECK');
          await capture(s, 'workbench-unsaved-task', issues);
          await page.keyboard.press('Escape');
          notes.push('Task editor opens and cancels; no task metadata persisted.');
        });
      } finally {
        evidence.blocked.push(...s.blocked); evidence.errors.push(...s.errors); await s.context.close();
      }
    }

    for (const width of [1440, 390]) {
      const s = await contextFor(width, 'reader');
      try {
        await exercise(s, 'reader-no-amounts', async (issues, notes) => {
          await capture(s, 'reader-dashboard', issues);
          const content = await s.page.locator('main').innerText();
          assert.doesNotMatch(content, /(?:₺\s*-?[\d]|-?[\d][\d.,\s]*₺|\b[\d][\d.,]*\s*(?:TL|TRY)\b)/, 'Reader dashboard must not render monetary values');
          await Promise.all(s.pendingResponses);
          const leaks = s.apiBodies.flatMap(({path, data}) => monetaryLeaves(data).map(value => path + ' ' + value));
          assert.deepEqual(leaks, [], 'Every successful API response loaded by the reader dashboard must redact monetary fields');
          notes.push(s.apiBodies.length + ' successful dashboard API responses inspected for monetary keys; currency-formatted amounts absent from main content.');
        });
      } finally { evidence.blocked.push(...s.blocked); evidence.errors.push(...s.errors); await s.context.close(); }
    }

    await t.test('no-amount reader: direct API money access is denied or redacted', async () => {
      const s = await contextFor(1440, 'reader'), problems = [];
      const entry = {name: 'reader-direct-apis', role: 'reader', width: 'HTTP', status: 'PASS', issues: problems, observations: []};
      evidence.cases.push(entry);
      try {
        // The current preview may still hide the allowed rates. Verify the audit
        // accepts visible/null metadata without weakening amount/margin checks.
        assert.deepEqual(monetaryLeaves({vat_bps:2000,commission_rate_bps:1500,komisyon_oran_bps:1600,period:{oran_bps:1700}}), []);
        assert.deepEqual(monetaryLeaves({vat_bps:null,commission_rate_bps:null,komisyon_oran_bps:null,period:{oran_bps:null}}), []);
        assert.equal(monetaryLeaves({amount_cents:100,margin_bps:200,revenue_share_bps:300,rate_bps:400}).length, 4);
        const paths = ['/api/ec', '/api/ec/panorama', '/api/ec/performance', '/api/ec/urun-karlilik', '/api/ec/purchases', '/api/ec/ledger', '/api/ec/warehouse', '/api/ec/workbench', '/api/ec/money-calendar', '/api/ec/business-result'];
        for (const path of paths) {
          const response = await s.context.request.get(new URL(path, base).href);
          const data = await response.json(), status = response.status();
          const leaks = status === 200 ? monetaryLeaves(data) : [];
          evidence.apis.push({path, status, leaks, allowedRates: status === 200 ? allowedCommissionRates(data) : []});
          if (![200, 403].includes(status)) problems.push(path + ': expected 200 redacted or 403, received ' + status);
          if (leaks.length) problems.push(path + ': unredacted fields ' + leaks.slice(0, 20).join(', ') + (leaks.length > 20 ? ' (and ' + (leaks.length - 20) + ' more)' : ''));
          if (path === '/api/ec/ledger' && status === 200 && data.parties?.length) {
            const detailPath = '/api/ec/party-profiles/' + encodeURIComponent(data.parties[0].id);
            const detailResponse = await s.context.request.get(new URL(detailPath, base).href);
            const detail = await detailResponse.json(), detailLeaks = detailResponse.status() === 200 ? monetaryLeaves(detail) : [];
            evidence.apis.push({path: detailPath, status: detailResponse.status(), leaks: detailLeaks, allowedRates: detailResponse.status() === 200 ? allowedCommissionRates(detail) : []});
            if (![200, 403].includes(detailResponse.status()) || detailLeaks.length) problems.push(detailPath + ': status=' + detailResponse.status() + '; ' + detailLeaks.join(', '));
          }
        }
        entry.observations.push('GET only. Monetary amounts, margins, revenue shares and other protected fields must be redacted or denied (403). VAT and commission_rate_bps/komisyon_oran_bps/oran_bps are intentionally allowed by existing policy. The audit accepts those metadata fields both visible and null.');
        entry.status = problems.length ? 'FAIL' : 'PASS';
        assert.deepEqual(problems, []);
      } finally { await s.context.close(); }
    });
  } finally {
    evidence.after = await readHealth().catch(error => ({error: error.message}));
    evidence.finished = new Date().toISOString();
    await browser.close();
    const failures = evidence.cases.filter(c => c.status === 'FAIL');
    const lines = [
      '# Dashboard workflow verification — 2026-10-04', '',
      'Run: ' + evidence.started + ' → ' + evidence.finished + '. Origin: ' + evidence.origin + '. Chrome: ' + evidence.browser + '.', '',
      '**' + (evidence.cases.length - failures.length) + '/' + evidence.cases.length + ' workflow cases passed; ' + failures.length + ' failed.** Verified against the running synthetic preview at the timestamp shown; results apply to the listed local cases.', '',
      '## Scope and isolation', '',
      '- Owned files: tests/dashboard-workflows-browser.test.js, public/money-planning.css, public/workspace-design.css, this document, and PNG screenshots in workflow-checks/.',
      '- Parent-controlled synthetic populated preview and coordinated restart; actual worker, routes, API responses and browser modules. No mock API responses or human restart confirmation is implied.',
      '- Fresh browser contexts at desktop 1440×1000 and mobile 390×844; owner and no-amount reader.',
      '- GET/HEAD-only browser guard, same loopback origin, service workers blocked. No reset, restart, git, deployment or live query.',
      '- Report uses an in-memory synthetic CSV; handoff stops at column mapping. Invoice review, count and unbilled forms, warehouse, cari, calendar and workbench are opened/explored without saving.',
      '- Blocked non-read/external attempts: ' + evidence.blocked.length + '. Browser errors: ' + evidence.errors.length + '.',
      '- Coarse fixture counts before: ' + JSON.stringify(evidence.before.counts) + '; after: ' + JSON.stringify(evidence.after.counts) + '. These counts alone do not prove the absence of every possible mutation.', '',
      '## Reproduce', '', fence + 'powershell', "Set-Location 'C:\\Users\\baran\\Desktop\\site\\lunapot-panel'", command, fence, '',
      'The opt-in variable is required; the normal test suite skips this browser test. Start/restart is intentionally not part of the command. Rerun only when requested after the parent changes the UI.', '',
      '## Results', '', '| Viewport | Role | Workflow | Result | Evidence |', '| --- | --- | --- | --- | --- |',
      ...evidence.cases.map(c => '| ' + c.width + ' | ' + c.role + ' | ' + c.name + ' | ' + c.status + ' | ' + md(c.observations.join(' ')) + ' |'),
      '', '## Actionable failures', '',
      ...(failures.length ? failures.flatMap(c => ['### ' + c.width + ' ' + c.role + ' — ' + c.name, '', ...c.issues.map(i => '- ' + md(i)), '']) : ['No failures in this bounded verification.', '']),
      '## Reader API evidence', '', 'Existing no-amount contract retains amounts/margins/revenue-share protection while permitting VAT and the three commission-rate metadata aliases. See tests/komisyon-orani.test.js:177 and src/permission-policy.js MONEY_NAMES.', '', '| Endpoint | HTTP | Exposed protected money fields |', '| --- | ---: | --- |',
      ...evidence.apis.map(a => '| ' + a.path + ' | ' + a.status + ' | ' + md(a.leaks.length ? a.leaks.slice(0, 12).join('; ') + ' (' + a.leaks.length + ' total)' : 'None found') + ' |'),
      '', '### Commission-rate metadata — existing intentional policy', '',
      ...evidence.apis.filter(a => a.allowedRates?.length).map(a => '- ' + a.path + ': ' + a.allowedRates.length + ' allowed commission-rate values observed; examples: ' + a.allowedRates.slice(0, 6).join('; ')),
      'The established regression explicitly requires no-amount staff to see commission_rate_bps, komisyon_oran_bps and nested oran_bps while commission amounts and revenue remain hidden. The proposed rate-hiding change was reverted by the parent; existing policy is retained. This audit exempts exactly those commission fields and VAT metadata. Margins and revenue shares remain protected. Allowed fields may be present or null in this bounded amount-disclosure audit; it does not independently require their display.',
      '', '## Screenshots and layout measurements', '',
      'Document overflow is checked at both widths. Mobile standalone enabled controls in main, open dialogs and the bottom navigation are checked against 44×44 CSS pixels (0.5px rounding tolerance). In-text inline links and hidden/disabled controls are excluded; native checkbox/radio labels are measured. This is a geometric check, not a full accessibility audit.', '',
      '| Width | Role | Screen | Overflow | Controls below 44px | Capture |', '| ---: | --- | --- | --- | --- | --- |',
      ...evidence.captures.map(c => '| ' + c.width + ' | ' + c.role + ' | ' + c.name + ' | ' + c.documentWidth + '/' + c.viewport + (c.overflow ? ' FAIL' : ' fits') + ' | ' + md(c.short.map(x => x.text + ' ' + x.width + '×' + x.height).join('; ') || 'None') + ' | [PNG](workflow-checks/' + c.file + ') |'),
      '', '## Limits and handoff', '',
      '- This verifies local synthetic navigation and the listed interactions, not all production features. No payment, posting, durable upload, stock movement, receipt, warehouse apply or task save was executed.',
      '- Successful CSV cases prove retained filename/type and parsed mapper or recognized-profile check step. XLSX/PDF/XML/image processing, OCR, server byte persistence, duplicates and report apply are outside this run.',
      '- Reader checks cover currency-formatted dashboard text, protected money/proportion keys and daily channel cash in successful dashboard responses, and the listed endpoints. VAT and the three intentional commission-rate fields are permitted. Free-text disclosures and unvisited endpoints require separate review.',
      '- Shared preview memory can retain worker code from process startup. At the policy correction, the parent reported that this preview still hid commission-rate metadata pending a final restart. Passing this audit verifies amount protection and permits both visible/null allowed rates; it does not prove the runtime has restored their visibility. This sidecar never restarts the preview.',
      '- Sidecar application edits are limited to the two assigned touch-target stylesheets. Business logic, backend code and dashboard.css belong to the parent/other agents.',
      '- Required tldr-code was read; its CLI is unavailable, so focused source searches were used. No Skill/Task/subagent tool was exposed. Handoff and continuity evidence stay in this owned document to respect the explicit file boundary.',
      '- Handoff: the parent agent controls remaining backend fixes, preview restarts and final full-browser verification. This sidecar has completed the assigned changes; the recorded 21 cases describe the preview at the run timestamp.', '',
    ];
    await writeFile(documentPath, lines.join('\n'), 'utf8');
    console.log('Workflow evidence: ' + documentPath);
    console.log('Cases=' + evidence.cases.length + ', failures=' + failures.length + ', screenshots=' + evidence.captures.length);
  }
});
