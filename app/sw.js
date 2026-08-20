/* serves captured camera frames back from Cache Storage so shots survive refresh */
const SHOTS_CACHE = "tcs-shots-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.includes("/shots/")) {
    e.respondWith(
      caches.open(SHOTS_CACHE)
        .then((c) => c.match(e.request))
        .then((r) => r || new Response("", { status: 404 }))
    );
  }
});
