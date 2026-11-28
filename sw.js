/* Rep English 오프라인 캐시: 항상 네트워크를 먼저 쓰고(최신 반영), 실패할 때만 저장본 사용 */
const CACHE = "rep-english-v28";
const CORE = [
  "./", "./index.html", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png",
  "./data/daily.txt", "./data/travel.txt", "./data/business.txt",
  "./data/swap-daily.txt", "./data/swap-travel.txt", "./data/swap-business.txt",
  "./data/forms-daily.txt", "./data/forms-travel.txt", "./data/forms-business.txt",
  "./data/phone.txt", "./data/swap-phone.txt", "./data/forms-phone.txt"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== self.location.origin && !isFont) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});

/* 학습 알림 푸시: 서버는 빈 본문만 보내고, 문구는 여기서 정함 */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Rep English", {
    body: d.body || "오늘의 영어 문장 연습할 시간이에요. 10분이면 충분해요!",
    icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "rep-remind", renotify: true,
    data: { url: d.url || self.registration.scope }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
