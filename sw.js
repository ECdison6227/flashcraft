/* Craft Family PWA Service Worker */

const VERSION = "2026-01-09-1";
const PRECACHE = `craft-precache-${VERSION}`;
const RUNTIME = `craft-runtime-${VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./flashcraft2.0.html",
  "./markcraft.html",
  "./notecraft.html",
  "./lifecraft.html",
  "./weathercraft.html",
  "./manifest.webmanifest",
  "./pwa.js",
  "./offline.html",
  "./favicon.ico",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key === PRECACHE || key === RUNTIME) return null;
          return caches.delete(key);
        })
      );
      await self.clients.claim();
    })()
  );
});

const isNavigationRequest = (request) =>
  request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Navigation: network-first, then cache, then offline fallback.
  if (isNavigationRequest(request)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(RUNTIME);
          cache.put(request, response.clone());
          return response;
        } catch (_) {
          const cached = await caches.match(request);
          return cached || (await caches.match("./offline.html"));
        }
      })()
    );
    return;
  }

  // Assets: cache-first, then network, then error.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME);
        // Cache same-origin and opaque (CDN) responses.
        cache.put(request, response.clone());
        return response;
      } catch (_) {
        return cached || Response.error();
      }
    })()
  );
});
