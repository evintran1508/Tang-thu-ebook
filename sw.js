const SHELL_CACHE = 'kesach-shell-v3';
const PAGES_CACHE = 'kesach-scan-pages-v2';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/data/catalog.json',
  '/js/main.js',
  '/js/reader.js',
  '/js/shelf.js',
  '/js/cover.js',
  '/js/store.js',
  '/js/archive.js',
  '/js/detail.js',
  '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (![SHELL_CACHE, PAGES_CACHE].includes(k)) {
            return caches.delete(k);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. User data API must always be fresh from server/disk
  if (url.pathname === '/api/userdata') {
    return;
  }

  // 2. Bỏ qua mọi request gọi ra ngoài domain nội bộ (cross-origin)
  // để trình duyệt xử lý tự nhiên qua HTTP cache, tránh triệt để lỗi CORS và crash Service Worker
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. Same-origin App Shell -> Stale-while-revalidate
  e.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const fetchPromise = fetch(req)
        .then((netRes) => {
          if (netRes && netRes.status === 200) {
            cache.put(req, netRes.clone()).catch(() => {});
          }
          return netRes;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
