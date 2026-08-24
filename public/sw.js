/*
  Service worker.

  Without this the offline story collapses at the first refresh: the app is
  server-rendered, so with no connection the browser gets nothing and the
  clinic is left staring at a dinosaur. Leases and outboxes are useless if
  the page cannot load to reach them.

  Strategy, chosen per resource type rather than one blanket rule:

    * navigations  — network first, fall back to the cached shell. Fresh when
                     online (so deploys land), still opens when not.
    * build assets — cache first. They are content-hashed, so a cached copy
                     is never stale.
    * server actions / POST — never touched. Those are the writes the outbox
                     is responsible for; a service worker replaying them
                     would duplicate work the outbox already owns.
*/

/*
  Bumped to v2 to evict caches poisoned by the bug fixed below: error
  responses were stored as the offline shell, so browsers that loaded the
  site during a database outage kept serving that error back. Changing the
  version makes the activate handler drop the old caches outright, which is
  the only way to clear a bad entry from a browser we cannot reach.
*/
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

// Pages reception actually needs during an outage. Admin and analytics are
// deliberately absent — they cannot work offline anyway.
const SHELL_URLS = ["/", "/billing"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS))
      // A failed pre-cache must not block activation; the runtime cache
      // below will fill in on first visit.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.endsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Writes belong to the outbox, not to the cache.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Next's build output is content-hashed, so a hit is always correct.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          /*
            Only a GOOD page is worth keeping.

            This used to cache every navigation response, errors included. A
            single 500 — a database outage, a bad deploy — was then stored as
            the offline shell and served back from cache afterwards, so the
            site stayed broken in that browser long after the server had
            recovered, and a hard reload was the only way out. An error page
            is never a useful thing to show someone offline.
          */
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request)) ?? (await caches.match("/"));
          if (cached) return cached;
          return new Response(
            "<!doctype html><meta charset=utf-8>" +
              "<body style='font:16px system-ui;padding:40px'>" +
              "<h2>Not available offline</h2>" +
              "<p>Open this page once while connected, then it will work " +
              "without internet.</p>",
            { headers: { "Content-Type": "text/html" }, status: 503 },
          );
        }),
    );
  }
});
