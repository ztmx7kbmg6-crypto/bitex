/**
 * BITEX Service Worker - バックグラウンド通知対応
 * iOS 16.4+ PWA / Android Chrome / Desktop Chrome に対応
 * Web Push API (VAPID) によるサーバープッシュも受信可能
 */

const CACHE_NAME = 'bitex-v1';
const ICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%23ffdc00"/><text x="16" y="22" font-size="18" text-anchor="middle" fill="%23000">B</text></svg>';
const BADGE = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="%23ffdc00"/><text x="12" y="17" font-size="13" text-anchor="middle" fill="%23000">B</text></svg>';

// === インストール・アクティベート ===
self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      // 古いキャッシュを削除
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
    ])
  );
});

// === メインスレッドからのメッセージ ===
// アプリがフォアグラウンドにいない時もSWが通知を表示
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'PUSH_NOTIFY') {
    const { title, body, tag } = e.data;
    e.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag: tag || 'bitex',
        icon: ICON,
        badge: BADGE,
        requireInteraction: false,
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        data: { tag, timestamp: Date.now() }
      })
    );
  }

  // メインスレッドに確認応答
  if (e.ports && e.ports[0]) {
    e.ports[0].postMessage({ ok: true });
  }
});

// === Web Push受信（VAPIDサーバー → SW → 通知表示）===
// アプリが完全に閉じていてもiPhone/Androidに届く
self.addEventListener('push', e => {
  let data = { title: 'BITEX', body: '新しい通知があります', tag: 'bitex' };

  if (e.data) {
    try {
      data = Object.assign(data, e.data.json());
    } catch {
      data.body = e.data.text();
    }
  }

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || 'bitex',
      icon: data.icon || ICON,
      badge: BADGE,
      requireInteraction: false,
      renotify: true,
      silent: false,
      vibrate: [200, 100, 200],
      data: data
    })
  );
});

// === 通知クリックでアプリを開く ===
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // 既に開いているウィンドウがあればフォーカス
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      // なければ新しく開く
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// === Periodic Background Sync（定期価格チェック）===
// Chrome Android + HTTPS環境で動作
self.addEventListener('periodicsync', e => {
  if (e.tag === 'btc-price-check') {
    e.waitUntil(checkBtcPriceInBackground());
  }
});

async function checkBtcPriceInBackground() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=jpy');
    const data = await res.json();
    const price = data?.bitcoin?.jpy;
    if (!price) return;

    // 保存した閾値と比較して通知
    const stored = await getStoredThreshold();
    if (stored && stored.alertPrice && Math.abs(price - stored.alertPrice) / stored.alertPrice > 0.05) {
      await self.registration.showNotification('BITEX - 価格アラート', {
        body: `BTC ¥${Math.round(price).toLocaleString()} (バックグラウンド検知)`,
        tag: 'bg-price', icon: ICON, badge: BADGE,
        vibrate: [200, 100, 200]
      });
    }
  } catch (e) {
    // ネットワーク不可時は無視
  }
}

async function getStoredThreshold() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match('__threshold__');
    if (res) return await res.json();
  } catch {}
  return null;
}