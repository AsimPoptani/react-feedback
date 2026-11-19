// The inbox's service worker, scoped to the inbox path. It keeps the page itself and the last thread data the inbox loaded, so the inbox opens with no signal.
// It only ever handles GET requests for the files and API reads listed below. It never sees a key (those are PUT requests to the app), and it caches no image.
const VERSION = 'fb-inbox-0.8.1';
const SHELL = `${VERSION}-shell`, DATA = `${VERSION}-data`;
const FILES = ['./', 'app.js', 'areas.js', 'markdown.js', 'donut.js', 'quote.js', 'aside.js', 'tracker.js', 'secret.js', 'outbox.js', 'presence.js'];
const SCOPE = new URL('./', self.location.href).pathname;
const API = new URL('../api/', self.location.href).pathname;
// The thread list, one thread's JSON, the profile (and its two avatars), pins, areas, tracker and config. Never a search (?q=) or anything with a query.
const DATA_PATH = new RegExp(`^${API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(threads(/[^/]+)?|profile(/avatar/(user|agent))?|pins|areas|tracker|config)$`);
const PATIENCE = 6000; // a slow network gives way to the saved copy after this long

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('fb-inbox-') && k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// The saved copy, marked so the page knows it is looking at old data.
function stale(response) {
  const headers = new Headers(response.headers); headers.set('X-Fb-Offline', '1');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const saved = () => cache.match(request, { ignoreVary: true });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), PATIENCE);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) { void cache.put(request, response.clone()); return response; }
    if (response.status >= 500) { const hit = await saved(); if (hit) return stale(hit); }
    return response;
  } catch (error) {
    clearTimeout(timer);
    const hit = await saved();
    if (hit) return stale(hit);
    throw error;
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === `${SCOPE}sw.js`) return;
  if (url.pathname.startsWith(SCOPE) && url.search === '') event.respondWith(networkFirst(request, SHELL));
  else if (DATA_PATH.test(url.pathname) && url.search === '') event.respondWith(networkFirst(request, DATA));
});
