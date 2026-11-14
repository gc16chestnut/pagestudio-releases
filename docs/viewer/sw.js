// PageStudio Viewer (web version): works offline once opened. Files are served from the phone's cache first,
// and refreshed from the web in the background, so a new version is used the next time the viewer opens.
const CACHE = 'psv-v5';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'viewer.css', 'fonts.css', 'viewer.js', 'core.js', 'effects.js', 'icons.js', 'pubbridge.js', 'handwriting.js', 'lib/pubreader.bundle.js', 'lib/EMFJS.bundle.min.js', 'lib/WMFJS.bundle.min.js', 'icon.png', 'file-pgs.png', 'file-pub.png', 'manifest.webmanifest']).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('Offline', { status: 503 });
  }));
});
