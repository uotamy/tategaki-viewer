"use strict";
/* =========================================================
   縦書き小説ビューワー Service Worker
   - アプリ本体（ドキュメント＋アセット）をキャッシュし、オフラインでも開けるようにする
   - 更新方針：新しい版は、そのセッション内で効くこと
       * ドキュメント（画面遷移）はネットワーク優先（HTTPキャッシュも再検証する）。
         オンラインなら常に最新版が返り、失敗したときだけキャッシュにフォールバック
         するので、オフライン起動で本棚が開けることも維持される
       * 同一オリジンの静的アセットは stale-while-revalidate（表示はキャッシュ、
         裏で更新）。照合はフルURLで行い、クエリ違いを取り違えない
       * skipWaiting + clients.claim で新しい版を速やかに有効化し、ページ側は
         controllerchange で1回だけ自動リロードして新版をその場で表示する
   - 他オリジンへのリクエストには一切介入しない。なろう中継のように対象が
     クエリ（?url=）で決まる通信を SWR キャッシュ＋クエリ無視照合で横取りすると、
     別対象の応答（検索APIのJSONなど）が目次や本文のリクエストに返ってしまい、
     取得が「目次が取得できませんでした」で失敗する事故が起きたため
   - このファイルは assets/ 配下に置かれるため、制御範囲（scope）は assets/ になる。
     ホスティング側の都合でページ本体を制御できない環境では、このSWは実質待機状態となり、
     ページは通常のWebページとしてそのまま動く（フォールバック）。
     ルート直下に置けばそのままルートスコープ版としても動く（パスは scope から算出する）。
   ========================================================= */

var VERSION = "v5";
var SHELL_CACHE = "tategaki-shell-" + VERSION;
var RUNTIME_CACHE = "tategaki-runtime-" + VERSION;

/* SW自身のURL（.../assets/sw.js）から見たアプリのルートと、アプリ本体のURL群 */
var APP_ROOT = new URL("../", self.registration.scope).href;
var INDEX_URL = APP_ROOT + "index.html";
/* IPA明朝フォント（ipaexm.woff2・約3.7MB）は起動用キャッシュに入れない。
   設定から任意でダウンロードされたときに実行時キャッシュ（SWR）へ入り、
   以後はそこから返る */
var SHELL_URLS = [
  APP_ROOT,
  INDEX_URL,
  self.registration.scope + "manifest.webmanifest",
  self.registration.scope + "icon-192.png",
  self.registration.scope + "icon-512.png",
  self.registration.scope + "icon-maskable-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      /* 1つ失敗してもインストール全体を落とさないよう、個別に追加する */
      return Promise.all(SHELL_URLS.map(function (url) {
        return cache.add(url).catch(function () { /* 取れないものは実行時キャッシュに任せる */ });
      }));
    }).then(function () {
      /* 新しい版が用意できたら、待たずに有効化へ進む */
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        /* 旧バージョンのキャッシュはすべて消す。旧版にはクエリ無視照合で
           中継応答を取り違えるキャッシュが残っていることがあり、残すと
           新版でも同じ事故を引きずる */
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () {
      /* 開いているページをただちに新しいSWの制御下に置く */
      return self.clients.claim();
    })
  );
});

/* ページ側からの「待たずに有効化」依頼（更新確認フロー） */
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  /* 他オリジン（なろう中継・公式API・フォントCDN・JSZip CDNなど）には
     介入しない。ブラウザの通常の通信に任せる */
  if (url.origin !== self.location.origin) return;

  /* ドキュメント：ネットワーク優先（更新がそのセッションで届く）、
     失敗したらキャッシュ。?view=narou のようなクエリ違いは同一ドキュメント
     として扱うため、フォールバック照合と保存先はクエリなしの正規URLに寄せる */
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (res) {
        if (res && res.status === 200) {
          /* cloneは本文が消費される前に同期で取る（非同期に回すと使用済みで失敗する） */
          var copyIndex = res.clone();
          var copyRoot = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put(INDEX_URL, copyIndex);
            cache.put(APP_ROOT, copyRoot);
          });
        }
        return res;
      }).catch(function () {
        return caches.match(INDEX_URL).then(function (hit) {
          return hit || caches.match(APP_ROOT);
        });
      })
    );
    return;
  }

  /* 同一オリジンの静的アセット（フォント・アイコンなど）：stale-while-revalidate。
     照合はフルURL（クエリ込み）で行う */
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === "opaque")) {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
