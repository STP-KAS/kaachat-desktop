self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(async () => {
      // caches.match resolves undefined on a miss — respondWith(undefined) throws
      // "Failed to convert value to 'Response'", so fall through to a network error.
      const cached = await caches.match(event.request);
      return cached || Response.error();
    }),
  );
});
