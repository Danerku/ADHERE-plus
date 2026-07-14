const CACHE='adhere-v87';
const SHELL=['./','./index.html','./app.js','./styles.css','./config.js','./manifest.webmanifest',
  './model/score.js','./model/bayes_tracker.js','./model/rules_engine.js','./model/charts.js','./model/ethiopian.js','./model/lcg.js','./model/pcc.js',
  './model/risk_model.json','./model/newborn_model.json','./model/mch_rules.json'];

// A NEW CACHE MUST BE FILLED FROM THE NETWORK, NOT FROM THE BROWSER'S OLD ONE.
//
// `cache.addAll(SHELL)` fetches through the browser's ordinary HTTP cache. So a device that already
// held an old copy of a model file could satisfy the install from that stale copy, and the BRAND NEW
// service-worker cache would be populated with the OLD MODEL. Caught live: after the retrain, cache
// adhere-v82 held the retrained intrapartum model and the PREVIOUS newborn model — a tablet was
// scoring newborns with a model we had replaced, and nothing anywhere said so.
//
// `cache:'reload'` bypasses the HTTP cache: a new cache version now means new files, every time.
self.addEventListener('install', e=>{ e.waitUntil(
  caches.open(CACHE)
    .then(c=>c.addAll(SHELL.filter(u=>u).map(u=>new Request(u,{cache:'reload'}))))
    .then(()=>self.skipWaiting())); });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', e=>{
  const url=new URL(e.request.url);
  if(url.pathname.includes('/api/')) return;                 // API: network, app queues offline
  const isShell = /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
  if(isShell){
    // STALE-WHILE-REVALIDATE, with a short network race.
    //
    // This was network-first with no timeout. On a link that is UP but very slow — the normal case on
    // 2G — the tablet re-downloaded the whole ~112 KB shell on EVERY open and the provider waited
    // 20-45 s staring at a blank screen, even though a byte-identical copy was already cached. Only a
    // completely dead link fell back to the cache, so "instant second load" never actually happened
    // in the facilities this is built for.
    //
    // Now: serve the cached shell immediately if we have one, and refresh it in the background so the
    // next open gets the new deploy. If nothing is cached (first ever load) wait for the network.
    // A deploy therefore lands one reload later, which is the right trade for a 2G clinic.
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      const hit=await cache.match(e.request);
      const net=fetch(new Request(url.href,{cache:'no-store'}))
        .then(res=>{ if(res&&res.ok) cache.put(e.request,res.clone()); return res; })
        .catch(()=>null);
      if(hit){ e.waitUntil(net); return hit; }                 // instant, and quietly refreshed
      return (await net) || (await cache.match('./index.html')) || Response.error();
    })());
  } else {                                                   // model/json/assets: cache-first
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return res;})));
  }
});
