const CACHE='adhere-v58';
const SHELL=['./','./index.html','./app.js','./styles.css','./config.js','./manifest.webmanifest',
  './model/score.js','./model/bayes_tracker.js','./model/rules_engine.js','./model/charts.js','./model/ethiopian.js',
  './model/risk_model.json','./model/newborn_model.json','./model/mch_rules.json'];
self.addEventListener('install', e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.filter(u=>u))).then(()=>self.skipWaiting())); });
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
    // Now: serve the cached shell immediately if we have one, and refresh it in the backgroun