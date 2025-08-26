importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBRo2tcepT9VqHYo7TekSGnG93kpTm6KaY",
  authDomain: "fanta-wagner.firebaseapp.com",
  projectId: "fanta-wagner",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be"
});

const messaging = firebase.messaging();

// --- DEDUPE 30s --------------------------------------------------------------
async function seen(key, ttl = 30) {
  const cache = await caches.open('fw-dedupe');
  const req = new Request('https://dedupe.local/' + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) return true;
  await cache.put(req, new Response('1', { headers: { 'x-exp': String(Date.now() + ttl*1000) }}));
  return false;
}

function normalizeData(raw) {
  // FCM a volte incapsula come {data:{...}}, altre come {...}
  const d = raw?.data ? raw.data : raw || {};
  const title   = d.title || 'FantAsta';
  const body    = d.body  || '';
  const icon    = d.icon  || '/icons/icon-192.png';
  const link    = d.link  || '/';
  const eventId = d.eventId || `${title}|${body}`;
  const tag     = d.tag || eventId;
  return { title, body, icon, link, eventId, tag };
}

async function show(dataObj) {
  const { title, body, icon, link, eventId, tag } = normalizeData(dataObj);
  if (await seen(eventId)) return;
  await self.registration.showNotification(title, {
    body,
    icon,
    badge: '/icons/icon-192.png',
    tag,
    renotify: false,
    data: { url: link, eventId }
  });
}

// --- Handler FCM ufficiale (data-only) --------------------------------------
messaging.onBackgroundMessage(async (payload) => {
  // Data-only → mostriamo noi
  await show(payload);
});

// --- Fallback raw Push (alcuni ambienti/Chrome versioni) ---------------------
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    try {
      const j = event.data ? event.data.json() : null;
      // Proviamo sia al top-level sia dentro .data
      const dataObj = j?.data ? j.data : j;
      if (dataObj) { await show(dataObj); }
    } catch (e) {
      // nothing
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hit = all.find(c => c.url.includes(url));
    if (hit) return hit.focus();
    return clients.openWindow(url);
  })());
});

