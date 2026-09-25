/* MKSI service worker — app shell + runtime tile cache. No push. */
const CACHE_APP = "mksi-app-v35";
const CACHE_TILES = "mksi-tiles-v35";

const APP_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/geo.js",
  "./js/storage.js",
  "./js/weather.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

const TILE_HOSTS = [
  "tile.openstreetmap.org",
  "server.arcgisonline.com",
  "tile.opentopomap.org",
  "unpkg.com",
  "cdn.jsdelivr.net",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_APP).then((cache) => cache.addAll(APP_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_APP && k !== CACHE_TILES)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isTileOrCdn(url) {
  return TILE_HOSTS.some((h) => url.hostname.includes(h));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // App shell: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_APP).then((c) => c.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Tiles & CDN: stale-while-revalidate into tile cache
  if (isTileOrCdn(url)) {
    event.respondWith(
      caches.open(CACHE_TILES).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
