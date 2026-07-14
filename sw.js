/* Service Worker — オフライン対応 */
'use strict';

const CACHE = 'chord-studio-v10';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './theory.js',
  './midi.js',
  './audio.js',
  './transcribe.js',
  './render.js',
  './export.js',
  './app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => c.addAll(ASSETS.slice(0, 11))))
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

/* ネットワーク優先: オンライン時は常に最新、オフライン時はキャッシュで動作
 * cache: 'no-store' でブラウザのHTTPキャッシュも経由させず、常にサーバーの最新版を取りに行く */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
