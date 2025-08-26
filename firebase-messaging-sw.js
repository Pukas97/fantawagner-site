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

// dedupe base (30s)
async function recentlySeen(key, ttl = 30) {
  const cache = await caches.open('fw-dedupe');
  const hit = await cache.match(key);
  if (hit) return true;
  await cache.put(key, new Response('1', { headers: { 'x-exp': Date.now() + ttl * 1000 } }));
  return false;
}

messaging.onBackgroundMessage(async (payload) => {
  const data = payload?.data || {};
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
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
