// 旧アドレスでインストールされたアプリの Service Worker を外す（古い画面を出し続けないように）。
// 外したあと開いている画面を読み込み直すと、index.html の転送で新しいアドレスへ移る
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.navigate(c.url);
    })(),
  );
});
