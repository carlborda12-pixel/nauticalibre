/* Service worker: avisos push y caché mínima del panel (instalable como app). */
const CACHE = 'nal-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/backend.js', '/vendor/supabase.js', '/vendor/qrcode.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Red primero para el panel (siempre la última versión); la API nunca se cachea.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/webhook')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { titulo: 'Náutica Aire Libre', cuerpo: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Náutica Aire Libre', {
    body: d.cuerpo || '', tag: d.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/' }, requireInteraction: /tomala|Sin atender|no respondió/i.test(d.titulo || ''),
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if ('focus' in w) { w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
