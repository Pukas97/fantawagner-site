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

// Dedupe semplice: evita doppi entro 30s
async function recentlySeen(key, ttlSeconds = 30) {
  const cache = await caches.open('fw-dedupe');
  const req = new Request('https://dedupe.local/' + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) return true;
  await cache.put(req, new Response('1', { headers: { 'x-exp': String(Date.now() + ttlSeconds*1000) }}));
  return false;
}

messaging.onBackgroundMessage(async (payload) => {
  // Ci aspettiamo messaggi data-only
  const data  = payload?.data || {};
  const title = data.title || 'FantAsta';
  const body  = data.body  || '';
  const icon  = data.icon  || '/icons/icon-192.png';
  const eventId = data.eventId || `${title}|${body}`;
  const tag = data.tag || eventId;

  if (await recentlySeen(eventId)) return;

  await self.registration.showNotification(title, {
    body,
    icon,
    badge: '/icons/icon-192.png',
    tag,
    renotify: false,
    data: { url: data.link || '/', eventId }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
