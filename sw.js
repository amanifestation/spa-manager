/* Luuna Skin Spa — service worker
   Keeps the app openable when the line drops, without ever holding back an update:
   the page itself is fetched from the network first and only falls back to the last
   good copy. Firestore traffic is never touched — that has its own offline cache. */
const VERSION = '2026-09-22v';
const SHELL = 'luuna-shell-' + VERSION;
const LIB = 'luuna-lib-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png',
  './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png'];
/* libraries the app loads from other hosts (Firebase SDK, the PDF maker) */
const LIB_HOSTS = ['www.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
/* never cache, never intercept: live data and sign-in */
const LIVE_HOSTS = ['firestore.googleapis.com', 'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com', 'firebaseinstallations.googleapis.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== LIB).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* the page asks for the new version to take over */
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
  if (e.data === 'VERSION' && e.source) e.source.postMessage({ type: 'VERSION', version: VERSION });
});

/* tapping a notification brings the app forward on the right screen */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const go = (e.notification.data && e.notification.data.go) || 'home';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(self.registration.scope) === 0) {
        try { c.postMessage({ type: 'GO', go: go }); } catch (err) {}
        return c.focus();
      }
    }
    return self.clients.openWindow('./?go=' + encodeURIComponent(go));
  })());
});

const timeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('slow')), ms);
  p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.protocol !== 'http:') return;
  if (LIVE_HOSTS.includes(url.hostname)) return;                    // straight to the network

  /* the app page: newest wins, last good copy is the safety net */
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    e.respondWith((async () => {
      try {
        const fresh = await timeout(fetch(req), 6000);
        if (fresh && fresh.ok) {
          const c = await caches.open(SHELL);
          c.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (err) {
        const c = await caches.open(SHELL);
        return (await c.match('./index.html')) || (await c.match('./')) ||
          new Response('<h1>Offline</h1><p>Sambungan internet diperlukan buat kali pertama.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  /* icons, manifest and other files of our own: cache first, refresh quietly */
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response('', { status: 504 });
    })());
    return;
  }

  /* libraries from other hosts: cached so the app still opens without a line */
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(LIB);
      const hit = await c.match(req);
      if (hit) { fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); }).catch(() => {}); return hit; }
      try { const r = await fetch(req); if (r && r.ok) c.put(req, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    })());
  }
});
