/**
 * sw.js — Offline-first Service Worker for the Viral Reel Finder app shell.
 * Caches local HTML/CSS/JS assets so Saved & History work seamlessly offline.
 * Never caches third-party API calls (handled by 15-min localStorage cache).
 */

const CACHE_NAME = 'viral-reel-finder-shell-v1';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/ui.js',
  './js/storage.js',
  './js/score.js',
  './js/api.js',
  './js/sources/youtube.js',
  './js/sources/instagram.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only intercept same-origin requests; let external APIs & video thumbnails pass through
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Stale-while-revalidate for app shell freshness when online
        event.waitUntil(
          fetch(request)
            .then((networkRes) => {
              if (networkRes && networkRes.ok) {
                return caches
                  .open(CACHE_NAME)
                  .then((cache) => cache.put(request, networkRes.clone()));
              }
              return null;
            })
            .catch(() => null)
        );
        return cachedResponse;
      }

      return fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkRes;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
