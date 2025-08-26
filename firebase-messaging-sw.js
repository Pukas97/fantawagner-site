// firebase-messaging-sw.js
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

// Se il messaggio ha già "notification", Chrome/Safari la mostrano da soli.
// Per evitare doppioni, NON chiamiamo showNotification in questo caso.
// Se invece fosse "data-only", la mostriamo noi (fallback).
messaging.onBackgroundMessage((payload) => {
  try {
    if (payload && payload.notification) {
      // auto-shown dal browser → niente
      return;
    }
    const title = (payload && payload.data && payload.data.title) || 'Notifica';
    const body  = (payload && payload.data && payload.data.body)  || '';
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png'
    });
  } catch(e) {
    // silenzio
  }
});
