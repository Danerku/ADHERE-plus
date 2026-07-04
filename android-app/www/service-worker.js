const CACHE='adhere-v2';
const SHELL=['./','./index.html','./app.js','./styles.css','./config.js','./manifest.webmanifest',
  './model/score.js','./model/bayes_tracker.js','./model/rules_engine.js','./model/charts.js',
  './model/risk_model.json','./model/mch_rules.json'];
self.addEventListener('install', e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.filter(u=>u))).then(()=>self.skipWaiting())); });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', e=>{
  const url=new URL(e.request.url);
  if(url.pathname.includes('/api/')) return;                 // API: network, app queues offline
  const isShell = /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
  if(isShell){                                               // network-first so updates land
    e.respondWith(fetch(e.request).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return res;})
      .catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
  } else {                                                   // model/json/assets: cache-first
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return res;})));
  }
});