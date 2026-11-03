// Service Worker: guarda la aplicación en caché para que abra sin internet (RNF01).
// Cambiar la versión cada vez que se modifique un archivo de la app, para que los dispositivos la actualicen.
const VERSION = 'aula-v3';
const CACHE_APP = `${VERSION}-app`;
const CACHE_API = `${VERSION}-api`;

const ARCHIVOS_APP = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/db.js',
  '/js/logic.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_APP).then((c) => c.addAll(ARCHIVOS_APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    // API: primero la red; si no hay conexión, la última respuesta guardada.
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp.ok) caches.open(CACHE_API).then((c) => c.put(request, resp.clone()));
          return resp;
        })
        .catch(async () => {
          const enCache = await caches.match(request);
          if (!enCache) return Response.json({ error: 'Sin conexión' }, { status: 503 });
          // Se marca la respuesta para que la app sepa que viene de la caché y no del servidor.
          const cabeceras = new Headers(enCache.headers);
          cabeceras.set('X-Desde-Cache', '1');
          return new Response(enCache.body, { status: enCache.status, headers: cabeceras });
        }),
    );
    return;
  }

  // Archivos de la aplicación: primero la caché (offline-first) y la red como respaldo.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((enCache) => {
      if (enCache) return enCache;
      return fetch(request).catch(() => (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()));
    }),
  );
});
