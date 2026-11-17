// OddsEdge IA — Service Worker v5
// - Données sportives : réseau d'abord (temps réel). Le cache n'est qu'un secours hors-ligne,
//   signalé à l'app par l'en-tête x-oe-cache: hit (l'app affiche alors « données différées »).
// - The Odds API : jamais mis en cache (clé API + quota).
// - Page : réseau d'abord, pour que chaque mise à jour du code soit visible immédiatement.
const CACHE = 'oddsedge-real-v5';
const ESPN_CACHE_MAX = 30;   // l'URL ESPN change chaque jour (plage de dates) : on borne le secours hors-ligne
const ASSETS = ['./', './index.html'];
const API_TIMEOUT = 8000;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))   // un 404 n'empêche plus l'installation
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, err => { clearTimeout(t); reject(err); });
  });
}

// Garde les ESPN_CACHE_MAX réponses ESPN les plus récentes (le Cache API conserve l'ordre d'insertion)
async function trimEspnCache() {
  try {
    const c = await caches.open(CACHE);
    const keys = (await c.keys()).filter(r => new URL(r.url).hostname.endsWith('api.espn.com'));
    for (const k of keys.slice(0, Math.max(0, keys.length - ESPN_CACHE_MAX))) await c.delete(k);
  } catch {}
}

async function markCached(res) {
  const headers = new Headers(res.headers);
  headers.set('x-oe-cache', 'hit');
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The Odds API : direct réseau, aucun stockage
  if (url.hostname.endsWith('the-odds-api.com')) return;

  // ESPN : réseau d'abord, secours cache signalé
  if (url.hostname.endsWith('api.espn.com')) {
    e.respondWith((async () => {
      try {
        const res = await withTimeout(fetch(req), API_TIMEOUT);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).then(trimEspnCache).catch(() => {});
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return markCached(cached);
        return new Response(JSON.stringify({ events: [] }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Page (navigation / même origine HTML) : réseau d'abord
  if (req.mode === 'navigate' || (url.origin === location.origin && req.destination === 'document')) {
    e.respondWith((async () => {
      try {
        const res = await withTimeout(fetch(req), 6000);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {}); }
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Polices, Tailwind CDN, sw/manifest : cache d'abord + revalidation en arrière-plan
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
