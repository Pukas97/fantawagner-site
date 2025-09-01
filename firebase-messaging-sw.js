// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBRo2tcepT9VqHYo7TekSGnG93kpTm6KaY",
  authDomain: "fanta-wagner.firebaseapp.com",
  projectId: "fanta-wagner",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be",
});

const messaging = firebase.messaging();

// Background push: mostra manualmente SOLO se il payload non contiene già "notification"
messaging.onBackgroundMessage((payload) => {
  const hasNotificationBlock = !!payload.notification;
  const title = (payload.notification?.title || payload.data?.title || 'Notifica Asta');
  const body  = (payload.notification?.body  || payload.data?.body  || '');
  const link  = (payload.fcmOptions?.link || payload.data?.link || '/');

  if (!hasNotificationBlock) {
    const options = {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: link }
    };
    self.registration.showNotification(title, options);
  }
});

// Click: apri/porta in primo piano la pagina
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = (event.notification?.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
