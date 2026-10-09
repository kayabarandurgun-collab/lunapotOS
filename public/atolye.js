import {mountQuickLogin} from './quick-access-ui.js';
import {canRoute} from './permissions.js';
import {icon} from './ui-icons.js';
import {createRouteLoader, createSessionOwner} from './route-loader.js';

// MARKA ATÖLYESİ. Kendi başına bir çalışma alanı: e-ticaretin ya da üretimin
// içine gömülü değil, ana ekrandan ayrı bir uygulama olarak açılır.
//
// İki modül, AYRI yetkilerle: Belge Atölyesi (brand_documents) ve
// Logo Kütüphanesi (brand_logos). Biri diğerini açmaz.
//
// Belgeler çalışma alanına bağlıdır (ec / lp): cari, ürün ve teklif kayıtları
// hangi alandaysa belge de oraya yazılır. Alan seçimi adresin içindedir.

const app = document.querySelector('#atolye-app');
const routeLoader = createRouteLoader(), session = createSessionOwner();
let authenticated = false, currentUser = null, mountedRoute = '', mountedScope = '';
let loggingOut = false, startupRetry = start, disposeQuickLogin = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const views = {'belge-atolyesi': 'Belge Atölyesi', 'logo-kutuphanesi': 'Logo Kütüphanesi'};
const HINTS = {
  'belge-atolyesi': 'Teklif, proforma ve dokuz kurumsal evrak türü.',
  'logo-kutuphanesi': 'Onaylı logo dosyaları, renk ve boyut seçimi.'
};
const SCOPES = {ec: 'E-ticaret', lp: 'Üretim'};
const DEFAULT_ROUTE = 'belge-atolyesi';

const routeViews = {
  'belge-atolyesi': {
    load: () => import('./brand-documents-ui.js'),
    mount: (module, root, scope) => module.mountBrandDocuments(root, scope, currentUser)
  },
  'logo-kutuphanesi': {
    load: () => import('./brand-logos-ui.js'),
    mount: (module, root, scope) => module.mountBrandLogos(root, scope, currentUser)
  }
};

// Adres biçimi: #belge-atolyesi?alan=ec&offer=…  — alan verilmezse e-ticaret.
function readHash() {
  const [route, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const scope = SCOPES[params.get('alan')] ? params.get('alan') : 'ec';
  return {route: Object.hasOwn(views, route) ? route : DEFAULT_ROUTE, scope, params};
}

function resetSession() {
  const owner = session.begin();
  authenticated = false; currentUser = null; mountedRoute = ''; mountedScope = ''; loggingOut = false;
  disposeQuickLogin?.(); disposeQuickLogin = null; routeLoader.begin();
  return owner;
}

async function auth(path, body, owner = session.capture()) {
  owner.check();
  const response = await fetch('/api/auth/' + path, {
    signal: owner.signal,
    ...(body ? {method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'application/json'}} : {})
  });
  owner.check();
  const result = await response.json();
  owner.check();
  if (!response.ok) throw new Error(result.error || 'İşlem tamamlanamadı.');
  return result;
}

const allowed = (route, scope) => currentUser?.owner || canRoute(currentUser, scope, route);
const anyAllowed = scope => Object.keys(views).some(route => allowed(route, scope));

function navLink(route, current, scope) {
  return '<a href="#' + route + '?alan=' + scope + '" class="nav-link' + (route === current ? ' active' : '') + '"' +
    (route === current ? ' aria-current="page"' : '') + '><span class="nav-icon">' + icon(route) + '</span>' +
    '<span class="nav-text">' + esc(views[route]) + '</span></a>';
}

async function render() {
  if (!authenticated || !currentUser) return;
  const view = routeLoader.begin();
  const {route, scope} = readHash();
  mountedRoute = route; mountedScope = scope;

  const links = Object.keys(views).filter(key => allowed(key, scope)).map(key => navLink(key, route, scope)).join('');
  const scopeSwitch = Object.entries(SCOPES).map(([key, label]) =>
    '<a class="atolye-scope' + (key === scope ? ' active' : '') + '" href="#' + route + '?alan=' + key + '"' +
    (key === scope ? ' aria-current="true"' : '') + '>' + esc(label) + '</a>').join('');

  app.innerHTML = '<aside id="sidebar"><a class="brand" href="/atolye/"><img src="/icon.svg" alt="">' +
    '<span>lunapot<span class="brand-sub">MARKA ATÖLYESİ</span></span></a>' +
    '<div class="workspace-label">BELGE VE LOGO</div>' +
    '<nav aria-label="Marka Atölyesi menüsü"><div class="nav-primary">' +
    (links || '<p class="help">Bu alanda açık ekranın yok.</p>') + '</div></nav>' +
    '<div class="atolye-scope-switch" role="group" aria-label="Çalışma alanı">' +
    '<span class="nav-group-label">ÇALIŞMA ALANI</span>' + scopeSwitch + '</div>' +
    '<div class="sidebar-foot"><a class="workspace-home" href="/access' + (currentUser?.owner ? '' : '#account') + '">' +
    (currentUser?.owner ? 'Ekip ve yetkiler' : 'Hesabım') + '</a>' +
    '<a class="workspace-home" href="/">▦ Tüm uygulamalar</a>' +
    '<div class="version"><span class="status-dot"></span> Marka Atölyesi v1.0</div>' +
    '<p>Belgeler çalışma alanına bağlıdır</p></div></aside>' +
    '<div class="workspace"><header>' +
    '<button class="mobile-menu icon-button" id="atolye-menu" aria-label="Menüyü aç" aria-expanded="false">☰</button>' +
    '<strong class="mobile-workspace">Atölye</strong>' +
    '<div class="breadcrumb"><span>Marka Atölyesi</span><span>/</span><strong>' + esc(views[route]) + '</strong>' +
    '<span class="pill">' + esc(SCOPES[scope]) + '</span></div>' +
    '<div class="header-actions"><a class="app-launcher-link" href="/" aria-label="Ana ekran · Uygulamalar">' +
    '<span aria-hidden="true">▦</span> Uygulamalar</a>' +
    '<span class="connection">' + (navigator.onLine ? '● Çevrimiçi' : '● Çevrimdışı') + '</span>' +
    '<button class="text-button" id="atolye-logout">Çıkış</button></div></header>' +
    '<main id="atolye-content"></main>' +
    '<footer><span>Marka Atölyesi · Kurumsal belgeler ve logo</span>' +
    '<span>Bu belgeler fatura, irsaliye ya da stok hareketi yaratmaz</span></footer></div>';

  const content = document.querySelector('#atolye-content');
  document.querySelector('#atolye-menu').onclick = event => {
    const open = document.querySelector('#sidebar').classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  };
  document.querySelector('#atolye-logout').onclick = logout;

  // Yetki sunucuda da uygulanır; burada yalnız anlaşılır bir ekran gösterilir.
  if (!allowed(route, scope)) {
    content.innerHTML = '<section class="card pad"><h2>' + esc(views[route]) + '</h2>' +
      '<p role="status">Bu ekran ' + esc(SCOPES[scope]) + ' alanında sana açılmamış. ' +
      'Yöneticin Ekip ve yetkiler ekranından izin verebilir.</p>' +
      (anyAllowed(scope === 'ec' ? 'lp' : 'ec')
        ? '<p class="help"><a href="#' + route + '?alan=' + (scope === 'ec' ? 'lp' : 'ec') + '">' +
          esc(SCOPES[scope === 'ec' ? 'lp' : 'ec']) + ' alanında dene →</a></p>' : '') + '</section>';
    return;
  }

  const feature = routeViews[route];
  await view.mount(content, feature.load, module => feature.mount(module, content, scope), {label: views[route]});
}

function startupError(owner, message, retry = start) {
  if (!owner.isCurrent()) return;
  authenticated = false; currentUser = null; loggingOut = false; routeLoader.begin(); startupRetry = retry;
  app.innerHTML = '<section class="loading" data-startup-error><h1>Marka Atölyesi açılamadı</h1>' +
    '<p role="alert">' + esc(message || (navigator.onLine
      ? 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip yeniden deneyin.'
      : 'İnternet bağlantısı yok. Bağlantınızı yeniden kurun.')) + '</p>' +
    '<button type="button" class="primary" id="atolye-retry">Yeniden dene</button></section>';
  document.querySelector('#atolye-retry').onclick = () => startupRetry();
}

function startupPending(message, retrying = false) {
  app.innerHTML = '<section class="loading" aria-busy="true"><h1>Marka Atölyesi</h1>' +
    '<p role="status">' + esc(message) + '</p>' +
    (retrying ? '<button type="button" class="primary" id="atolye-retry" disabled>Yeniden deneniyor…</button>' : '') + '</section>';
}

async function logout() {
  const owner = resetSession(); loggingOut = true; startupPending('Oturum kapatılıyor…');
  try { await auth('logout', {}, owner); owner.check(); await start(); }
  catch { if (owner.isCurrent()) startupError(owner, 'Oturum kapatılamadı. Bağlantınızı kontrol edip yeniden deneyin.', logout); }
}

async function start() {
  const retry = document.querySelector('#atolye-retry');
  if (retry) retry.disabled = true;
  const owner = resetSession(); startupRetry = start;
  startupPending('Oturum kontrol ediliyor…', !!retry);
  try {
    const state = await auth('status', undefined, owner);
    owner.check();
    authenticated = state.authenticated === true && !!state.user;
    currentUser = authenticated ? state.user : null;
    if (authenticated) { await render(); return; }
    app.innerHTML = '<div class="auth-layout"><section class="auth-brand">' +
      '<a class="brand" href="/atolye/"><img src="/icon.svg" alt=""><span>Marka Atölyesi</span></a>' +
      '<div><span class="eyebrow">BELGE · LOGO</span><h1>Kurumsal evrakın<br>tek yerde.</h1>' +
      '<p>Teklif ve proformadan paket listesine, onaylı logo dosyalarından<br>kendi renginle indirmeye.</p></div>' +
      '<small>Lunapot marka kaynakları</small></section>' +
      '<section class="auth-form"><form id="atolye-login"><span class="pill">Marka Atölyesi</span>' +
      '<h2>' + (state.initialized ? 'Tekrar hoş geldin.' : 'Önce yönetici hesabı gerekir.') + '</h2>' +
      '<p>' + (state.initialized ? 'Atölyeyi açmak için giriş yap.'
        : 'Kurulumu ana ekrandan tamamla, sonra buraya dön.') + '</p>' +
      (state.initialized
        ? '<label>Kullanıcı adı · yöneticiysen boş bırak<input name="username" autocomplete="username" maxlength="60"></label>' +
          '<label>Şifre<input name="password" type="password" required maxlength="200" autocomplete="current-password"></label>' +
          '<button class="primary" type="submit">Atölyeyi aç →</button>'
        : '<a class="primary" href="/">Ana ekrana git →</a>') +
      '<p id="atolye-error" class="error" role="alert"></p>' +
      '<small>Belgeler seçtiğin çalışma alanının cari ve ürün kayıtlarını kullanır.</small></form></section></div>';
    const form = document.querySelector('#atolye-login');
    if (!state.initialized) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled || !owner.isCurrent() || !form.isConnected) return;
      button.disabled = true;
      disposeQuickLogin?.(); disposeQuickLogin = null;
      try { await auth('login', Object.fromEntries(new FormData(form)), owner); owner.check(); await start(); }
      catch (error) {
        if (owner.isCurrent() && form.isConnected)
          form.querySelector('#atolye-error').textContent = error.name === 'TypeError'
            ? 'Sunucuya ulaşılamıyor. Yeniden deneyin.' : error.message;
      }
      finally { if (owner.isCurrent() && form.isConnected) button.disabled = false; }
    };
    mountQuickLogin(form, {onSuccess: () => { if (owner.isCurrent() && form.isConnected) return start(); }})
      .then(close => { if (owner.isCurrent() && form.isConnected) disposeQuickLogin = close; else close(); });
  } catch { if (owner.isCurrent()) startupError(owner); }
}

// Aynı ekran içinde adres değişirse ekran baştan kurulmaz; modül kendisi karşılar.
// Çalışma alanı değişirse modül YENİDEN kurulur: başka alanın verisi ekranda kalmaz.
window.addEventListener('hashchange', () => {
  if (!authenticated) return;
  const {route, scope} = readHash();
  if (route === mountedRoute && scope === mountedScope && routeLoader.onHash()) return;
  render();
});
window.addEventListener('online', () => { if (!authenticated && !loggingOut) startupRetry(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
