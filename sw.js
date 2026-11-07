"use strict";
/* 縦書き小説ビューワー Service Worker (root scope)
   - install: アプリ一式をキャッシュ + skipWaiting
   - activate: 旧キャッシュ削除 + clients.claim
   - fetch: ドキュメントも stale-while-revalidate（キャッシュから即起動し、更新は裏で取得して次回に反映） */
var VERSION = "v9";
var CACHE = "tategaki-viewer-" + VERSION;
var SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        var doc = hit || caches.match("./index.html", { ignoreSearch: true });
        var network = fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return doc; });
        e.waitUntil(network.catch(function () {}));
        return doc || network;
      })
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === "opaque")) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
