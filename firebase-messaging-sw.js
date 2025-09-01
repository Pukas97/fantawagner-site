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

// Background push (Android/Safari)
// Mostra manualmente SOLO se non c'è il blocco "notification" nel payload
messaging.onBackgroundMessage((payload) => {
  const hasNotificationBlock = !!payload.notification;
  const title = (payload.notification?.title || payload.data?.title || 'Notifica Asta');
  const body  = (payload.notification?.body  || payload.data?.body  || '');

  if (!hasNotificationBlock) {
    const options = {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    };
    self.registration.showNotification(title, options);
  }
});


// Focus sull’app al tap della notifica
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const urlToOpen = new URL('/', self.location.origin).href;

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

