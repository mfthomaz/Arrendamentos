const CACHE_NAME = "casathomaz-shell-v5";
const BASE_URL = self.registration.scope;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./domain.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./icons/casathomaz.svg",
  "./icons/casathomaz-192.svg",
  "./icons/casathomaz-512.svg",
];
const SHELL_URLS = SHELL_FILES.map((path) => new URL(path, BASE_URL).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("casathomaz-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/auth/v1/") || url.pathname.includes("/rest/v1/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (
        await caches.match(new URL("./index.html", BASE_URL).href)
      )),
    );
    return;
  }

  if (!SHELL_URLS.includes(url.href)) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
