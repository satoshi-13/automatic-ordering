/* 医療ガス点検：画面を端末に保存して、電波がなくても開けるようにする
 * ・画面のファイル（index.html など）は「ネット優先、つながらなければ保存した画面」
 *   → ネットがあるときは常に最新版、ないときは前回の画面で起動
 * ・GASへの通信（記録の送信）はここでは扱わない（送信箱が担当）
 * 画面のファイルを大きく変えたときは VERSION を上げる */
const VERSION = 'mg-v1';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // GASへの通信などは素通し
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);   // 電波が弱いときは4秒で保存した画面に切り替え
      const res = await fetch(req, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (res.ok) cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true });
      return hit || new Response('オフラインのため表示できません。一度ネットにつながった状態で開いてください。',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
