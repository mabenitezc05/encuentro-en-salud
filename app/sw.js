/* Service worker del Encuentro en Salud.
   Estrategia: red primero (la app vive del servidor y de la API);
   solo los estáticos con respaldo en caché para tolerar cortes breves.
   Nunca se cachea /api/ (datos en vivo, sesiones). */
const CACHE = 'encuentro-v1';
const ESTATICOS = ['/', '/css/styles.css', '/js/app.js', '/js/avatar3d.js',
  '/data/data.js', '/img/mariposa_oficial.png', '/img/mariposa.svg', '/img/encuentro.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ESTATICOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // siempre red, sin caché
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp.ok) {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
  );
});
