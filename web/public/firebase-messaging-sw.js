// AgentWatch push service worker. Static file — Vite does not bundle it.
//
// Loads the Firebase compat SDKs (pinned to the same version as the page's
// `firebase` package — see package.json and NOTES.md) and the shared push
// logic in /awsw.js (compiled from src/shared/awsw.ts by scripts/build-sw.mjs).
//
// Push message handling lives in AgentWatchSW (awsw.js): alerts always show a
// notification and send a receipt; state messages only update stored state;
// failed receipts are queued in IndexedDB and retried on the next push or
// activation.

importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js');
importScripts('/awsw.js');

// The Firebase config is injected by scripts/build-sw.mjs into /awsw.js at
// build time, so this file stays generic.
var messaging = firebase.messaging();

var API_BASE = self.AGENTWATCH_API_BASE || '';

self.addEventListener('activate', function (event) {
  // Best-effort retry of any queued receipts.
  event.waitUntil(
    self.AgentWatchSW.drainOutbox(API_BASE).catch(function () {
      return undefined;
    }),
  );
});

messaging.onBackgroundMessage(function (payload) {
  var data = payload && payload.data ? payload.data : {};
  return self.AgentWatchSW.handlePushData(data, {
    apiBase: API_BASE,
    showNotification: function (title, options) {
      return self.registration.showNotification(title, options);
    },
  });
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification && event.notification.data ? event.notification.data : undefined;
  event.waitUntil(self.AgentWatchSW.handleNotificationClick(data, self.clients));
});

// Installability: some browsers still want a fetch handler before offering
// install. Pass-through only — no caching.
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
