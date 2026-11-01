import {mountQuickLogin} from './quick-access-ui.js';
import {canRoute} from './permissions.js';
import {icon} from './ui-icons.js';
import {createRouteLoader, createSessionOwner} from './route-loader.js';

// BUYBOX ROBOTU. Kendi başına bir çalışma alanı: e-ticaretin içine gömülü değil, ana ekrandan ayrı
// bir uygulama olarak açılır (kullanıcı kararı 01.11). Kayıtlar yine ec_ tablolarında, API /api/ec/buybox.
const app = document.querySelector('#buybox-app');
const routeLoader = createRouteLoader(), session = createSessionOwner();
let authenticated = false, currentUser = null, loggingOut = false, startupRetry = start, disposeQuickLogin = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function resetSession() {
  const owner = session.begin();
  authenticated = false; currentUser = null; loggingOut = false;
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

async function render() {
  if (!authenticated || !currentUser) return;
  const view = routeLoader.begin();
  app.innerHTML = '<aside id="sidebar"><a class="brand" href="/buybox/"><img src="/icon.svg" alt="">' +
    '<span>lunapot<span class="brand-sub">BUYBOX ROBOTU</span></span></a>' +
    '<div class="workspace-label">FİYAT TAKİBİ</div>' +
    '<nav aria-label="Buybox menüsü"><div class="nav-primary"><a href="/buybox/" class="nav-link active" aria-current="page"><span class="nav-icon">' + icon('buybox') + '</span><span class="nav-text">Buybox robotu</span></a></div></nav>' +
    '<div class="sidebar-foot"><a class="workspace-home" href="/access' + (currentUser.owner ? '' : '#account') + '">' +
    (currentUser.owner ? 'Ekip ve yetkiler' : 'Hesabım') + '</a>' +
    '<a class="workspace-home" href="/">▦ Tüm uygulamalar</a>' +
    '<div class="version"><span class="status-dot"></span> Buybox robotu v1.0</div>' +
    '<p>Hepsiburada ve Trendyol fiyat takibi</p></div></aside>' +
    '<div class="workspace"><header>' +
    '<button class="mobile-menu icon-button" id="buybox-menu" aria-label="Menüyü aç" aria-expanded="false">☰</button>' +
    '<strong class="mobile-workspace">Buybox</strong>' +
    '<div class="breadcrumb"><span>Buybox robotu</span></div>' +
    '<div class="header-actions"><a class="app-launcher-link" href="/" aria-label="Ana ekran · Uygulamalar">' +
    '<span aria-hidden="true">▦</span> Uygulamalar</a>' +
    '<span class="connection">' + (navigator.onLine ? '● Çevrimiçi' : '● Çevrimdışı') + '</span>' +
    '<button class="text-button" id="buybox-logout">Çıkış</button></div></header>' +
    '<main id="buybox-content"></main>' +
    '<footer><span>Buybox robotu · Hepsiburada ve Trendyol</span>' +
    '<span>Fiyat değiştirir; muhasebe kaydı, stok hareketi ya da fatura yaratmaz</span></footer></div>';

  const content = document.querySelector('#buybox-content');
  document.querySelector('#buybox-menu').onclick = event => {
    const open = document.querySelector('#sidebar').classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  };
  document.querySelector('#buybox-logout').onclick = logout;

  // Yetki sunucuda da uygulanır; burada yalnız anlaşılır bir ekran gösterilir.
  if (!currentUser.owner && !canRoute(currentUser, 'ec', 'buybox')) {
    content.innerHTML = '<section class="card pad"><h2>Buybox robotu</h2><p role="status">Bu ekran sana açılmamış. Yöneticin Ekip ve yetkiler ekranından izin verebilir.</p></section>';
    return;
  }
  await view.mount(content, () => import('./buybox-ui.js'), module => module.mountBuybox(content), {label: 'Buybox robotu'});
}

function startupError(owner, message, retry = start) {
  if (!owner.isCurrent()) return;
  authenticated = false; currentUser = null; loggingOut = false; routeLoader.begin(); startupRetry = retry;
  app.innerHTML = '<section class="loading" data-startup-error><h1>Buybox robotu açılamadı</h1>' +
    '<p role="alert">' + esc(message || (navigator.onLine
      ? 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip yeniden deneyin.'
      : 'İnternet bağlantısı yok. Bağlantınızı yeniden kurun.')) + '</p>' +
    '<button type="button" class="primary" id="buybox-retry">Yeniden dene</button></section>';
  document.querySelector('#buybox-retry').onclick = () => startupRetry();
}

function startupPending(message, retrying = false) {
  app.innerHTML = '<section class="loading" aria-busy="true"><h1>Buybox robotu</h1>' +
    '<p role="status">' + esc(message) + '</p>' +
    (retrying ? '<button type="button" class="primary" id="buybox-retry" disabled>Yeniden deneniyor…</button>' : '') + '</section>';
}

async function logout() {
  const owner = resetSession(); loggingOut = true; startupPending('Oturum kapatılıyor…');
  try { await auth('logout', {}, owner); owner.check(); await start(); }
  catch { if (owner.isCurrent()) startupError(owner, 'Oturum kapatılamadı. Bağlantınızı kontrol edip yeniden deneyin.', logout); }
}

async function start() {
  const retry = document.querySelector('#buybox-retry');
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
      '<a class="brand" href="/buybox/"><img src="/icon.svg" alt=""><span>Buybox robotu</span></a>' +
      '<div><span class="eyebrow">HEPSİBURADA · TRENDYOL</span><h1>Rakibi takip et,<br>ucuz kalma.</h1>' +
      '<p>Seçtiğin ürünlerde fiyat rakiple birlikte iner ve çıkar,<br>tabanın altına düşmez.</p></div>' +
      '<small>Lunapot fiyat takibi</small></section>' +
      '<section class="auth-form"><form id="buybox-login"><span class="pill">Buybox robotu</span>' +
      '<h2>' + (state.initialized ? 'Tekrar hoş geldin.' : 'Önce yönetici hesabı gerekir.') + '</h2>' +
      '<p>' + (state.initialized ? 'Robotu açmak için giriş yap.' : 'Kurulumu ana ekrandan tamamla, sonra buraya dön.') + '</p>' +
      (state.initialized
        ? '<label>Kullanıcı adı · yöneticiysen boş bırak<input name="username" autocomplete="username" maxlength="60"></label>' +
          '<label>Şifre<input name="password" type="password" required maxlength="200" autocomplete="current-password"></label>' +
          '<button class="primary" type="submit">Robotu aç →</button>'
        : '<a class="primary" href="/">Ana ekrana git →</a>') +
      '<p id="buybox-error" class="error" role="alert"></p></form></section></div>';
    const form = document.querySelector('#buybox-login');
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
          form.querySelector('#buybox-error').textContent = error.name === 'TypeError'
            ? 'Sunucuya ulaşılamıyor. Yeniden deneyin.' : error.message;
      }
      finally { if (owner.isCurrent() && form.isConnected) button.disabled = false; }
    };
    mountQuickLogin(form, {onSuccess: () => { if (owner.isCurrent() && form.isConnected) return start(); }})
      .then(close => { if (owner.isCurrent() && form.isConnected) disposeQuickLogin = close; else close(); });
  } catch { if (owner.isCurrent()) startupError(owner); }
}

window.addEventListener('online', () => { if (!authenticated && !loggingOut) startupRetry(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
