const UPSTREAM_ORIGIN = 'https://lunapot-panel.lunapot-os.workers.dev';
const DEFAULT_PUBLIC_ORIGIN = 'https://muhasebe.lunapot.com';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);
const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const SESSION_COOKIE = 'lunapot_session';
const SESSION_VALUE = /^[0-9a-f]{64}$/;
const PROBE_HOST_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.workers\.dev$/;
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'cache-control', 'content-encoding', 'content-length', 'transfer-encoding']);

function textResponse(message, status) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Ortamdan gelen deger bozuk/kotu niyetliyse sabit degere duser; proxy hicbir kosulda acik hale gelmez.
function resolvePublicOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_PUBLIC_ORIGIN;
  let parsed;
  try { parsed = new URL(value.trim()); } catch { return DEFAULT_PUBLIC_ORIGIN; }
  if (parsed.protocol !== 'https:') return DEFAULT_PUBLIC_ORIGIN;
  if (parsed.username || parsed.password) return DEFAULT_PUBLIC_ORIGIN;
  if (parsed.origin !== 'https://' + parsed.hostname) return DEFAULT_PUBLIC_ORIGIN;
  return parsed.origin;
}

// Sadece cutover oncesi canli test icin; tam workers.dev hostname disinda hicbir deger kabul edilmez.
function resolveProbeHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host || !PROBE_HOST_PATTERN.test(host)) return null;
  return host;
}

function pickSessionCookie(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const piece = part.trim();
    const eq = piece.indexOf('=');
    if (eq < 1) continue;
    if (piece.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = piece.slice(eq + 1).trim();
    if (SESSION_VALUE.test(value)) return value;
  }
  return null;
}

// Path/query birebir korunur; upstream origin sabittir, istekten turetilmez.
function upstreamTarget(rawUrl) {
  const schemeEnd = rawUrl.indexOf('://');
  const pathStart = schemeEnd === -1 ? -1 : rawUrl.indexOf('/', schemeEnd + 3);
  if (pathStart === -1) return UPSTREAM_ORIGIN + '/';
  const hashStart = rawUrl.indexOf('#', pathStart);
  const pathAndQuery = hashStart === -1 ? rawUrl.slice(pathStart) : rawUrl.slice(pathStart, hashStart);
  return UPSTREAM_ORIGIN + pathAndQuery;
}

function rewriteLocation(value, publicOrigin) {
  let parsed;
  try { parsed = new URL(value); } catch { return value; }
  if (parsed.origin !== UPSTREAM_ORIGIN) return value;
  return publicOrigin + parsed.pathname + parsed.search + parsed.hash;
}

export async function handleRequest(request, env = {}, fetchImpl = fetch) {
  const publicOrigin = resolvePublicOrigin(env.PUBLIC_ORIGIN);
  const publicHost = new URL(publicOrigin).hostname;
  const probeHost = resolveProbeHost(env.PROBE_HOST);

  let incoming;
  try { incoming = new URL(request.url); } catch { return textResponse('Istek adresi cozumlenemedi.', 400); }

  const host = incoming.hostname.toLowerCase();
  if (host !== publicHost && (probeHost === null || host !== probeHost)) return textResponse('Bulunamadi.', 404);

  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return textResponse('Bu metot desteklenmiyor.', 405);

  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== incoming.origin) return textResponse('Istek kaynagi dogrulanamadi.', 403);
  if (UNSAFE_METHODS.has(method) && origin === null) return textResponse('Istek kaynagi dogrulanamadi.', 403);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase();
    if (name === 'cookie' || name === 'authorization' || name === 'host' || name === 'origin' || name === 'forwarded') continue;
    if (name.startsWith('x-forwarded-')) continue;
    headers.append(key, value);
  }

  const session = pickSessionCookie(request.headers.get('Cookie'));
  if (session !== null) headers.set('Cookie', SESSION_COOKIE + '=' + session);
  // Kontrol bittikten sonra Origin upstream origin'e cevrilir; panelin kendi CSRF kontrolu boylece calisir.
  if (origin !== null) headers.set('Origin', UPSTREAM_ORIGIN);

  const init = { method, headers, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamTarget(request.url), init);
  } catch {
    return textResponse('Panele su anda ulasilamiyor. Lutfen birazdan tekrar deneyin.', 503);
  }

  const outHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    outHeaders.append(key, value);
  }

  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (cookies.length === 0) {
    const single = upstream.headers.get('set-cookie');
    if (single) cookies.push(single);
  }
  // Set-Cookie string'ine dokunulmaz: host-only, Secure, SameSite=Strict aynen kalir, Domain eklenmez.
  for (const cookie of cookies) outHeaders.append('Set-Cookie', cookie);

  const location = upstream.headers.get('Location');
  if (location !== null) outHeaders.set('Location', rewriteLocation(location, incoming.origin));

  outHeaders.set('Cache-Control', 'no-store');

  const status = upstream.status;
  const emptyBody = method === 'HEAD' || status === 204 || status === 304;
  return new Response(emptyBody ? null : upstream.body, { status, statusText: upstream.statusText, headers: outHeaders });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
