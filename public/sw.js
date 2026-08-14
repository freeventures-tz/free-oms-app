/*
 * Free Ventures OMS service worker.
 *
 * IT EXISTS TO MAKE THE APP INSTALLABLE, AND FOR NOTHING ELSE.
 *
 * Android installs a real app-drawer entry (a WebAPK) rather than a bookmark shortcut when the
 * origin has a registered service worker with a fetch handler alongside the manifest. That is the
 * whole reason this file exists.
 *
 * IT STORES NOTHING. There is no Cache Storage use anywhere in this file, and the fetch handler
 * never calls `respondWith`, so every request goes to the network untouched and no response is
 * ever kept. That is a SECURITY decision, not an oversight (docs/pwa.md §4):
 *
 *   · Staff share phones. A cached page belonging to whoever signed in last could otherwise be
 *     shown to the next person, and a service-worker cache survives sign-out — it is not cleared
 *     with cookies or with the Supabase session.
 *   · Every protected screen is server-rendered from live database state. Serving any of it from
 *     a cache would mean showing figures, prices or approvals that the database has since changed,
 *     or that the viewer is no longer permitted to see at all.
 *
 * Offline support is therefore NOT provided. Adding it is a real product and architecture
 * decision — what may be read offline, whether anything may be WRITTEN offline, and how conflicts
 * are settled — and it must be specified before it is built, not smuggled in through this file.
 */

self.addEventListener("install", () => {
  // Take over immediately; there is no old cache to drain and nothing to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Delete anything a previous version of this worker may have stored. Today that is nothing, but
  // it means a future mistake cannot leave one user's data on a shared device forever.
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", () => {
  // Intentionally empty. Not calling `respondWith` hands the request straight to the network.
  // Do not add caching here without changing docs/pwa.md first.
});
