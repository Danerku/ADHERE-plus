/* ADHERE+ SPA — register → partograph → AI score, checklist, danger-sign, delivery, PNC.
   Talks to /api (PHP). On-device AI via RiskModel. Offline queue in localStorage. */
let ME=null, MODEL=null, RM=null, NBMODEL=null, NRM=null, RULES=null, RE=null; const BTS={};
const API_BASE=(typeof window!=='undefined'&&window.ADHERE_API_BASE)||'';
const $=(s,r=document)=>r.querySelector(s);
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild;};
const app=()=>$('#app');
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lastAI={}, BTapplied={}, lastScoreId={};
const RANK={green:0,amber:1,red:2};
function escalate(a,b){ return RANK[a]>=RANK[b]?a:b; }
// Deterministic clinical red-flags — can only RAISE the AI band, never lower it (safety layer).
function clinicalFlags(o){ let band='green'; const R=[]; const up=b=>{band=escalate(band,b);};
  if(o.sbp>=160||(o.dbp&&o.dbp>=110)){up('red');R.push('severe hypertension');} else if(o.sbp>=140){up('amber');R.push('raised BP');}
  if(o.fhr<100||o.fhr>180){up('red');R.push('severe fetal HR');} else if(o.fhr<110||o.fhr>160){up('amber');R.push('abnormal fetal HR');}
  if(o.mld>=3){up('red');R.push('severe moulding');} else if(o.mld>=2){up('amber');R.push('moulding');}
  if(o.tmp>=38.5){up('red');R.push('high fever');} else if(o.tmp>=38){up('amber');R.push('fever');}
  if(o.hrs>=6&&(o.cvx-4)/o.hrs<0.25){up('red');R.push('arrested labour');} else if(o.hrs>=4&&(o.cvx-4)/o.hrs<0.5){up('amber');R.push('protracted labour');}
  return {band,reasons:R};
}
// clinically-neutral defaults for features the partograph UI does not collect
// A NUMBER OR NULL — but ZERO IS A NUMBER. `+x||null` silently turns 0 into null, so a recorded
// APGAR of 0 (a flat, white, asphyxiated newborn) or an estimated blood loss of 0 became
// indistinguishable from "not assessed". Empty stays null; a real 0 is kept.
function numOrNull(v){ if(v===''||v===null||v===undefined) return null; const n=+v; return Number.isNaN(n)?null:n; }

// ============================================================================================
// PLAUSIBLE RANGES — a typing error is not a measurement.
//
// A clinician typed a height of 1,700,000 cm. Nothing stopped her: the HTML min/max attributes are
// only a hint, and the save did `+ht.value||null` with no check. Three women in the live database
// already carry heights of 65, 45 and 55 cm — the same mistake in the other direction. Height is
// stored ONCE on her record and drives BMI at EVERY antenatal contact, so one bad number silently
// corrupts her BMI, and her BMI risk grade, for the whole pregnancy.
//
// These bounds are deliberately WIDE. They are not clinical normals — the alerts already handle
// abnormal. They are the limits of what a human measurement can possibly be, so the only thing they
// ever reject is a slip of the finger. A real 0 is still a real 0 (see numOrNull): FHR 0 means no
// fetal heart heard, APGAR 0 means a flat baby, and both must get through.
const RANGES={
  //  key            min      max     label                          note
  height_cm:      [ 120,     200,  'Height (cm)'                 ],
  weight_kg:      [  30,     200,  'Weight (kg)'                 ],
  age:            [  10,      60,  'Age'                         ],
  ga_weeks:       [   4,      43,  'Gestational age (weeks)'     ],
  bp_systolic:    [  60,     250,  'Systolic BP'                 ],
  bp_diastolic:   [  30,     160,  'Diastolic BP'                ],
  pulse:          [  30,     200,  'Pulse'                       ],
  temperature:    [  30,      43,  'Temperature (°C)'       ],
  resp_rate:      [   6,      60,  'Respiratory rate'            ],
  spo2:           [  50,     100,  'SpO₂ (%)'               ],
  fundal_height:  [  10,      45,  'Fundal height (cm)'          ],
  fetal_heart:    [   0,     220,  'Fetal heart rate'            ],   // 0 = no fetal heart heard
  hgb:            [   3,      20,  'Haemoglobin (g/dl)'          ],
  muac:           [  10,      45,  'MUAC (cm)'                   ],
  cervix_cm:      [   0,      10,  'Cervical dilatation (cm)'    ],
  contractions:   [   0,      10,  'Contractions per 10 min'     ],
  hours_labour:   [   0,      48,  'Hours in active labour'      ],
  apgar:          [   0,      10,  'APGAR'                       ],
  birth_weight_g: [ 300,    6000,  'Birth weight (g)'            ],
  blood_loss_ml:  [   0,    5000,  'Estimated blood loss (ml)'   ],
  td_dose:        [   1,       5,  'Td dose number'              ],
  ifa_tabs:       [   0,     200,  'IFA tablets'                 ],
  gravida:        [   0,      20,  'Gravida'                     ],
  para:           [   0,      20,  'Para'                        ],
  viral_load:     [   0, 10000000, 'Viral load'                  ],
  cd4:            [   0,    2000,  'CD4 count'                   ]
};
// Check one field. Empty is always fine (not every measurement is taken).
function rangeError(key, v){
  const R=RANGES[key]; if(!R) return null;
  const n=numOrNull(v); if(n===null) return null;              // blank -> nothing to check
  if(!Number.isFinite(n)) return R[2]+' must be a number.';
  if(n<R[0] || n>R[1]) return R[2]+' of '+n+' is not possible — it must be between '+R[0]+' and '+R[1]+'. Please check what you typed.';
  return null;
}
// Guard a save. `pairs` is [[elementId, rangeKey], ...]. Returns true if everything is plausible;
// otherwise shows the problem and returns false so the caller does NOT save.
// Any element that is not on the screen is simply skipped, so a screen can list fields it may not
// render for every role without breaking.
function checkRanges(pairs){
  const errs=[];
  pairs.forEach(([id,key])=>{
    const el=document.getElementById(id); if(!el) return;
    const e=rangeError(key, el.value);
    if(e){ errs.push(e); el.style.borderColor='#d13b3b'; }
    else { el.style.borderColor=''; }
  });
  // Diastolic above systolic is a transposition, not a reading.
  const s=document.getElementById('bps')||document.getElementById('sbp');
  const d=document.getElementById('bpd')||document.getElementById('dbp');
  if(s&&d){ const sv=numOrNull(s.value), dv=numOrNull(d.value);
    if(sv!==null && dv!==null && dv>=sv){ errs.push('The diastolic BP ('+dv+') cannot be the same as or higher than the systolic ('+sv+'). They may have been entered the wrong way round.'); s.style.borderColor='#d13b3b'; d.style.borderColor='#d13b3b'; } }
  if(errs.length){ modal('Please check these values', errs.join('<br><br>'), 'risk'); return false; }
  return true;
}
// ============================================================================================
// The model's field-missingness defaults. NOTE: age, parity, ga and prior_cs are NOT here — the
// model was trained to impute them itself, and supplying a fixed guess (age 25, GA 39) as if it were
// measured both defeats that and, for GA, scored every woman as term. Those come from her record or
// are omitted so the model's own default applies.
const FEAT_DEFAULTS={rom_hours:2,meconium:0,urine_prot:0,bleeding:0,headache:0,blurred:0,epigastric:0,clonus:0};
// Derive real maternal features from the woman's record (falls back to neutral defaults).
function motherFeats(W){ W=W||{};
  const out={};
  if(W.age!=null&&W.age!=='') out.age=+W.age;
  if(W.para!=null&&W.para!=='') out.parity=+W.para;
  // GESTATIONAL AGE — from whatever the record actually holds, in priority order. It used to come
  // ONLY from women.lnmp, which registration never captures, so out.ga was unset and the scorer fell
  // back to a default of 39: EVERY woman was scored as term, including a 32-week preterm labour whose
  // GA was sitting in her ANC contacts the whole time. GA is the newborn model's dominant feature.
  //   1. LNMP if recorded (most precise);
  //   2. the latest ANC-contact GA, advanced to today;
  //   3. the booking GA (ga_first_contact), advanced from the first-contact date.
  // If none exist, ga is LEFT UNSET so the model applies its own trained default rather than a term
  // assumption dressed up as a measurement.
  // Advance a GA measured on an earlier DATE forward to today. A GA is only true as of the day it was
  // taken; using it raw is how a woman booked at 10 weeks got scored as a 10-week (clamped to 24) labour.
  const advance=(weeks, fromDate)=>{
    let wk=+weeks; if(!(wk>0)) return null;
    if(fromDate){ const d=(Date.now()-new Date(String(fromDate).slice(0,10)+'T00:00:00').getTime())/864e5;
                  if(d>0&&d<310) wk+=d/7; }
    return wk;
  };
  let ga=null;
  if(W.lnmp){ const d=(Date.now()-new Date(W.lnmp+'T00:00:00').getTime())/864e5; if(d>0&&d<310) ga=d/7; }
  if(ga==null && W.anc_ga_weeks!=null && W.anc_ga_weeks!=='') ga=advance(W.anc_ga_weeks, W.anc_ga_date);  // latest ANC contact, BY WOMAN
  if(ga==null && W.ga_now!=null && W.ga_now!=='')             ga=+W.ga_now;
  if(ga==null && W.ga_first_contact)                          ga=advance(W.ga_first_contact, W.first_contact_date);
  // A GA outside 24-43 is not a measurement we can trust - usually a stale booking GA that was never
  // advanced. Leave it UNSET rather than CLAMPING it to 24, which told the model "extremely preterm"
  // about a woman who was merely booked early. An omitted feature gets the model's trained default.
  if(ga!=null){ const r=Math.round(ga); if(r>=24 && r<=43) out.ga=r; }
  if(W.prior_cs==='yes') out.prior_cs=1;
  return out;
}
// Transparent MEOWS (Modified Early Obstetric Warning Score): aggregate-weighted trigger score.
// Any single parameter scoring 3 = red trigger; total>=5 = red; total 3-4 = amber (increase monitoring).
function meowsScore(v){ const parts=[]; let total=0;
  const add=(pts,label)=>{ if(pts>0){ total+=pts; parts.push({pts,label}); } };
  // NB the `&& s` guard: an empty box gives +'' === 0, and isNaN(0) is false, so a MISSING
  // systolic BP used to score 0<=90 -> 3 points -> a spurious RED MEOWS. Every other
  // parameter already guarded this way.
  const s=+v.sbp; if(!isNaN(s)&&s){ add(s<=90?3:s>=160?3:(s>=150||s<=100)?2:s>=140?1:0, 'systolic '+s); }
  const d=+v.dbp; if(!isNaN(d)&&d){ add(d>=110?3:d>=100?2:d>=91?1:0, 'diastolic '+d); }
  const p=+v.pulse; if(!isNaN(p)&&p){ add(p>=120?3:(p>=110||p<=50)?2:(p>=100||p<=59)?1:0, 'pulse '+p); }
  const r=+v.rr; if(!isNaN(r)&&r){ add((r>=25||r<8)?3:(r>=21||r<=11)?2:0, 'resp '+r); }
  const t=+v.temp; if(!isNaN(t)&&t){ add(t<=35?3:t>=39?2:(t>=38||t<36)?1:0, 'temp '+t); }
  const o=+v.spo2; if(!isNaN(o)&&o){ add(o<92?3:o<94?2:o<96?1:0, 'SpO₂ '+o); }
  const anyRed=parts.some(x=>x.pts>=3);
  const band=(anyRed||total>=5)?'red':(total>=3?'amber':'green');
  return {total,parts,band};
}
// Explainability: readable findings driving the intrapartum estimate (rule-derived, mirrors model mechanisms).
function riskDrivers(o,feat){ const D=[];
  if(feat.cvx_rate!=null&&feat.hrs>=4&&feat.cvx_rate<0.5) D.push('slow cervical progress ('+feat.cvx_rate.toFixed(1)+' cm/h)');
  if(o.mld>=2) D.push('moulding +'+o.mld);
  if(o.fhr<110) D.push('low fetal HR ('+o.fhr+')'); else if(o.fhr>160) D.push('high fetal HR ('+o.fhr+')');
  if(o.sbp>=160) D.push('severe hypertension ('+o.sbp+')'); else if(o.sbp>=140) D.push('raised BP ('+o.sbp+')');
  if(o.tmp>=38) D.push('fever ('+o.tmp+'°C)');
  if(o.amn==='M'||feat.meconium) D.push('meconium-stained liquor');
  if(o.hrs>=8) D.push('prolonged labour ('+o.hrs+'h)');
  return D;
}
// A super_admin is an admin, plus the estate (facilities) and cross-facility user management.
// Every admin gate in the UI goes through ADMIN() so that promoting the system owner to
// super_admin does not lock them out of the screens they already use.
const ADMIN=()=> !!(ME && (ME.role==='admin' || ME.role==='super_admin'));
const SUPER=()=> !!(ME && ME.role==='super_admin');
const online=()=>navigator.onLine;

// EVERY request gets a deadline. There was no timeout anywhere, and navigator.onLine only reports
// whether the tablet has a LINK — in a facility with a working wifi router but a dead uplink it is
// permanently true. So a request would hang for the browser's default (tens of seconds to minutes)
// while the 60-second loop kept firing more of them on top, stacking up in-flight requests on a link
// that was never going to answer. A read now gives up quickly and is served from the device instead.
const NET_TIMEOUT=12000;                 // generous for 2G, far short of the browser's default
function tfetch(url,opt,ms){
  const c=(typeof AbortController!=='undefined')?new AbortController():null;
  const t=setTimeout(()=>{ try{ c&&c.abort(); }catch(e){} }, ms||NET_TIMEOUT);
  return fetch(url, Object.assign({}, opt, c?{signal:c.signal}:{}))
    .finally(()=>clearTimeout(t));
}
function newCid(){ try{ return crypto.randomUUID(); }catch(e){ return 'c'+Date.now()+Math.random().toString(36).slice(2); } }

// ============================================================================================
// THE OFFLINE QUEUE — where a facility loses a real record
//
// localStorage is the only durable store on the device and it is NOT transactional. Every write
// below therefore RE-READS, modifies, and writes back, and only ever removes an item by its cid.
// The previous version snapshotted the queue at the top of flush() and wrote the survivors back
// at the bottom; anything a provider saved DURING that flush was silently erased by the write-back,
// and one auth failure erased the entire un-attempted tail of the queue.
// ============================================================================================
function qRead(){
  try{
    const a=JSON.parse(localStorage.qq||'[]');
    if(!Array.isArray(a)) return [];
    // SELF-HEAL. Devices in the field may already hold queued `login` attempts from the build that
    // wrongly treated authentication as a deferrable write. Such an entry can never do anything useful
    // - it just sits there reporting "pending" for ever, and replaying an old password is not something
    // we would ever want to do. Drop them on sight; every clinical record is untouched.
    const clean=a.filter(x=>!isAuthPath(x&&x.path));
    if(clean.length!==a.length){ try{ localStorage.qq=JSON.stringify(clean); }catch(e){} }
    return clean;
  }catch(e){ return []; }
}
// The QUEUE and the FAILED list are the durable copy of a patient's data. Write them through lsSet,
// which — at quota — evicts the refetchable read CACHE first and only fails if there is genuinely no
// room. And RETURN whether it succeeded, so a caller can tell the provider the truth. The old bare
// try/catch swallowed a quota failure and the record was silently never queued while the UI said
// "saved".
function qWrite(a){ return lsSet('qq', a); }
function qDrop(cid){ qWrite(qRead().filter(x=>x.cid!==cid)); }              // remove by identity, never by position
function qBump(cid){ const q=qRead(); const i=q.findIndex(x=>x.cid===cid); if(i<0) return 0; q[i].tries=(q[i].tries||0)+1; qWrite(q); return q[i].tries; }
function dlqRead(){ try{ const a=JSON.parse(localStorage.dlq||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function dlqWrite(a){ return lsSet('dlq', a); }
function dlqAdd(it,status,why){ const d=dlqRead(); d.push(Object.assign({},it,{status,why,failed_at:localDateTime()})); dlqWrite(d); }

function queue(item){
  item.by=(ME&&ME.id)||null;
  item.by_name=(ME&&ME.full_name)||'';
  item.queued_at=localDateTime();
  if(!item.cid) item.cid=newCid();
  const q=qRead(); q.push(item);
  if(!qWrite(q)){
    // Could not persist the outbox even after evicting the cache. The record is NOT saved — say so,
    // loudly, so nothing is lost in silence.
    throw new Error('The device is out of storage — this record could NOT be saved. Free some space on the tablet and enter it again.');
  }
  paintNet();
  return {queued:true};
}

// ============================================================================================
// WORKING FULLY OFFLINE
//
// Queueing the WRITES was never enough. Offline, every GET failed too — so the worklists came up
// empty and there was nothing to attach a record to. A provider with no signal could see nobody and
// register nobody. In facilities that are offline most of the day, that is the whole tool.
//
// Three pieces:
//   1. READS  — every successful GET is cached. When the network is gone, reads are served from
//               that cache, so yesterday's patients are still there today.
//   2. WRITES — a record created offline is given a LOCAL id and stored on the device. It appears
//               in the worklists immediately, and her chart opens and works like any other.
//   3. SYNC   — when the queued POST finally lands, the server returns the real id. Every other
//               queued item that referred to the local id is rewritten before it is sent. The server
//               never sees a local id, so none of this needs a backend change.
//
// WHY LOCAL IDS ARE NEGATIVE INTEGERS, not strings like "tmp-abc".
// This codebase does `+id`, `Number(id)` and `x.id==id` in dozens of places. A string id becomes
// NaN the first time it is coerced, and NaN would be written as the episode_id of every child row —
// silently detaching a woman's partograph from her chart. A negative integer survives every
// coercion the app performs, and `id < 0` is an unambiguous "not yet synced".
// ============================================================================================
const OC='oc', OL='ol', OM='om';                    // read cache | local records | id map

function lsGet(k,d){ try{ const v=JSON.parse(localStorage.getItem(k)); return (v==null)?d:v; }catch(e){ return d; } }
function lsSet(k,v){
  try{ localStorage.setItem(k,JSON.stringify(v)); return true; }
  catch(e){
    // Out of space. Evict READ CACHE only — never the queue, never a local record, never the id map.
    // Those are the only copy of a patient's data; the cache can always be refetched.
    ocEvict();
    try{ localStorage.setItem(k,JSON.stringify(v)); return true; }
    catch(e2){ toast('The device is out of storage. Free some space — new records cannot be saved.'); return false; }
  }
}
function ocAll(){ return lsGet(OC,{}); }
function ocPut(path,data){
  // A fresh server response is the truth. Any record we created on this device that the server has
  // now confirmed back to us can retire its local copy — that, and not a blanket wipe, is how the
  // local store stays clean.
  if(Array.isArray(data)) locPrune(data);
  const c=ocAll(); c[path]={at:Date.now(),data}; lsSet(OC,c);
}
function ocGet(path){ const c=ocAll(); return c[path]?c[path].data:null; }
function ocClear(){ try{ localStorage.removeItem(OC); }catch(e){} }
function ocEvict(){
  const c=ocAll(); const keys=Object.keys(c).sort((a,b)=>(c[a].at||0)-(c[b].at||0));
  keys.slice(0, Math.ceil(keys.length/2)).forEach(k=>delete c[k]);       // drop the oldest half
  try{ localStorage.setItem(OC,JSON.stringify(c)); }catch(e){ try{ localStorage.removeItem(OC); }catch(e2){} }
}
function locAll(){ const a=lsGet(OL,[]); return Array.isArray(a)?a:[]; }
function locAdd(r){ const a=locAll(); a.push(r); lsSet(OL,a); }
function locUpdate(id,patch){ const a=locAll(); const i=a.findIndex(x=>String(x.id)===String(id)); if(i>=0){ Object.assign(a[i],patch); lsSet(OL,a); } }
function locDrop(id){ lsSet(OL, locAll().filter(x=>String(x.id)!==String(id))); }
// A record we created offline has just synced. Keep the row — swap its local id for the real one and
// mark it synced. She then stays visible without interruption (mergeLocal de-duplicates her against
// the server's list by id) instead of vanishing in the gap between the sync and the next refetch.
function locReconcile(tmp, real){
  const a=locAll(); const i=a.findIndex(x=>String(x.id)===String(tmp));
  if(i<0) return;
  a[i]=Object.assign({}, a[i], {id:real, _local:0, _synced:1});
  delete a[i]._failed; delete a[i]._why;
  lsSet(OL,a);
}
// Retire synced local copies the server has now confirmed. Only ever drops rows marked _synced —
// an UNSENT record is the only copy of a patient's data and is never touched here.
function locPrune(rows){
  const ids=new Set(rows.map(r=>r&&String(r.id)));
  const a=locAll();
  const keep=a.filter(x=>!(x._synced && ids.has(String(x.id))));
  if(keep.length!==a.length) lsSet(OL,keep);
}

let _lseq=0;
function newLocalId(){ _lseq=(_lseq+1)%1000; return -(Date.now()*1000 + _lseq); }   // NEGATIVE integer ~ -1.75e15
// A LOCAL ID IS A SPECIFIC, HUGE NEGATIVE NUMBER — not merely "any negative". This matters: a
// provider can type a negative into a clinical field (e.g. BP -120, blood loss -5). If "negative"
// alone meant "local id", that mistype would look like an unresolved parent and permanently wedge
// the whole device's sync queue. Local ids are -(epoch_ms*1000+seq), always < -1e12; nothing a human
// types reaches that magnitude. Server ids are small positives. So the test is a magnitude gate.
const LOCAL_ID_MIN = -1e12;
const isLocalId=v=>{ const n=(typeof v==='number')?v:parseInt(v,10); return !isNaN(n) && n<LOCAL_ID_MIN; };

function idmap(){ return lsGet(OM,{}); }
function idmapPut(tmp,real){ const m=idmap(); m[String(tmp)]=real; lsSet(OM,m); }

// Which POST paths CREATE something the app later reads back by id, and under what collection the
// GET returns it. Anything not listed is queued as before (it is a child row that needs no local id).
const CREATES={ women:'women', episodes:'episodes', pregnancy_tests:'pregnancy_tests',
  fp_clients:'fp_clients', imm_clients:'imm_clients', pmtct:'pmtct', babies:'babies',
  observations:'observations', anc_visits:'anc_visits', pnc_visits:'pnc_visits',
  danger_signs:'danger_signs', maternal_vitals:'maternal_vitals', delivery:'delivery',
  anc_screening:'anc_screening', referrals:'referrals', checklist:'checklist',
  // These are ALSO read back by id offline (labs?episode=, fp_visits?client=, imm_doses?client=,
  // pmtct_infants?mother=, pmtct_fu?mother=, bemonc/handover?episode=). Left out of CREATES they saved
  // no local record, so the screen re-rendered from the stale cache without the new row and the
  // provider entered it again — a duplicate on sync. They store a local record like everything else.
  labs:'labs', fp_visits:'fp_visits', imm_doses:'imm_doses', pmtct_infants:'pmtct_infants',
  pmtct_fu:'pmtct_fu', bemonc:'bemonc', handover:'handover', lafp:'lafp' };

// Serve a GET from the device. The query shapes the app actually uses are bounded (episode=, ep=,
// woman=, category=, flag=, client=, mother=, id=, programme=, q=), so the matcher is exact rather
// than a guess.
function localRows(path){
  const [base,qs]=String(path).split('?');
  const rows=locAll().filter(r=>r._coll===base);
  if(!qs) return rows;
  const p=new URLSearchParams(qs);
  return rows.filter(r=>{
    for(const [k,v] of p.entries()){
      if(v==='' || v==null) continue;
      if(k==='flag'){ if(v==='highrisk' && String(r.high_risk)!=='1') return false; continue; }
      if(k==='q'){
        const hay=((r.mrn||'')+' '+(r.first_name||'')+' '+(r.father_name||'')+' '+(r.name||'')).toLowerCase();
        if(hay.indexOf(String(v).toLowerCase())<0) return false; continue;
      }
      let f=null;
      if(k==='episode') f='episode_id';
      else if(k==='ep'||k==='id') f='id';
      else if(k==='woman') f='woman_id';
      else if(k==='mother') f='mother_id';
      else if(k==='category') f='service_category';
      else if(k==='programme') f='programme';
      else if(k==='client') f=(base==='fp_visits')?'fp_client_id':'client_id';
      else if(k==='fu') continue;                        // pmtct_fu extra filters not modelled
      else continue;                                    // a filter we do not model: do not exclude
      if(String(r[f]) !== String(v)) return false;
    }
    return true;
  });
}
// Unsynced records show up alongside the server's, online or off — otherwise a woman registered
// offline would vanish from the worklist the moment the signal came back but before the flush ran.
function mergeLocal(path,data){
  if(!Array.isArray(data)) return data;
  const loc=localRows(path);
  if(!loc.length) return data;
  const have=new Set(data.map(x=>String(x.id)));
  return data.concat(loc.filter(x=>!have.has(String(x.id))));
}

// A locally-created episode has no server JOIN behind it, so the chart would render with no name and
// no MRN. Carry her details across from the woman's record on the device.
function localWoman(wid){
  const l=locAll().find(x=>x._coll==='women' && String(x.id)===String(wid));
  if(l) return l;
  const c=ocAll();
  for(const k of Object.keys(c)){
    const d=c[k].data;
    if(!Array.isArray(d)) continue;
    const f=d.find(x=>x && String(x.id)===String(wid) && (x.mrn!==undefined||x.first_name!==undefined));
    if(f) return f;
  }
  return null;
}
function decorateLocal(rec, base){
  if(base!=='episodes') return;
  const w=localWoman(rec.woman_id); if(!w) return;
  ['first_name','father_name','mrn','gravida','para','age','height_cm','lnmp','edd','blood_group','rh_factor',
   'hiv_known_positive','prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed',
   'chronic_htn','diabetes','cardiac_renal','pregnancy_planned','ga_first_contact','late_anc_initiation']
   .forEach(k=>{ if(w[k]!==undefined) rec[k]=w[k]; });
}

// Queue a write, and — if it CREATES something — give it a local id and store it so the app can
// carry on using it immediately.
function queueWrite(method,path,bodyObj,cid){
  const base=String(path).split('?')[0];
  const seg=base.split('/');
  if(method==='POST' && CREATES[seg[0]]){
    // SOME COLLECTIONS POST AN ARRAY (checklist, anc_screening: one row per item). Object.assign({},
    // [..]) turns an array into {0:{...},1:{...}} — a junk record with no episode_id, invisible to
    // localRows. The screen then reopened blank, the provider filled it in again, and the sync
    // produced duplicates. Store ONE local record per element instead.
    const coll=CREATES[seg[0]];
    if(Array.isArray(bodyObj)){
      // Mint a local id per row, but QUEUE FIRST - if the outbox cannot be persisted (quota) queue()
      // throws, and we must not be left holding N local rows with no way to ever send them while the UI
      // still shows them as recorded. Same order as the single-object path below.
      const ids=bodyObj.map(()=>newLocalId());
      queue({method,path,bodyObj,cid,tmp:ids[0],tmps:ids});   // tmps: ALL of them, so ALL get reconciled
      bodyObj.forEach((row,i)=>locAdd(Object.assign({}, row||{}, {id:ids[i], _coll:coll, _local:1, _at:localDateTime()})));
      return {ids, id:ids[0], local:true, queued:true};
    }
    const tid=newLocalId();
    const rec=Object.assign({}, bodyObj||{}, {id:tid, _coll:coll, _local:1, _at:localDateTime()});
    decorateLocal(rec, seg[0]);
    // Queue FIRST — the outbox is the durable copy. If it cannot be persisted (device truly out of
    // space) queue() throws and the caller tells the provider it was NOT saved, instead of the UI
    // reporting success over a record that was never written anywhere.
    queue({method,path,bodyObj,cid,tmp:tid});
    locAdd(rec);
    // Shaped like the server's replies so no caller has to know it happened offline.
    return {id:tid, ids:[tid], local:true, queued:true};
  }
  if(method==='PATCH' && isLocalId(seg[1])) locUpdate(seg[1], bodyObj||{});   // correct a record that has not synced yet
  return queue({method,path,bodyObj,cid});
}

// Rewrite local ids to the real ones the server has since given us.
function subIds(v,m){
  if(Array.isArray(v)) return v.map(x=>subIds(x,m));
  if(v && typeof v==='object'){ const o={}; for(const k in v) o[k]=subIds(v[k],m); return o; }
  const key=String(v);
  if(/^-\d+$/.test(key) && m[key]!==undefined) return m[key];
  return v;
}
function anyLocalLeft(v,m){
  if(Array.isArray(v)) return v.some(x=>anyLocalLeft(x,m));
  if(v && typeof v==='object'){ for(const k in v){ if(anyLocalLeft(v[k],m)) return true; } return false; }
  // Only a REAL local id (13+ digit negative) that is not yet mapped counts as unresolved. A small
  // negative a provider typed into a field is NOT a local reference and must not stall the queue.
  return isLocalId(v) && m[String(v)]===undefined;
}
// Every unmapped local id a queued item still references — used to decide whether it can be sent,
// and to detect an ORPHAN (a child whose parent will never sync because it was rejected/dropped).
function unresolvedRefs(v,m,acc){
  acc=acc||[];
  if(Array.isArray(v)){ v.forEach(x=>unresolvedRefs(x,m,acc)); return acc; }
  if(v && typeof v==='object'){ for(const k in v) unresolvedRefs(v[k],m,acc); return acc; }
  if(isLocalId(v) && m[String(v)]===undefined) acc.push(String(v));
  return acc;
}
// Is this local-id parent still coming? True if some queued item will CREATE it (its tmp), so a
// child that references it can wait. If nothing in the queue will ever produce it, the child is an
// orphan and must be surfaced rather than looped on forever.
// ...but only a parent the CURRENT user can actually send. flush() skips items queued by another user
// (they replay when that user signs back in). If the parent belongs to user A and the child to user B,
// B's flush saw A's parent still in the queue, concluded "not an orphan", and waited - for ever. B's
// clinical record was never sent, never failed, never shown. On a shared tablet (the normal case here)
// that is silent, permanent loss. A parent B cannot send is, from B's point of view, not coming.
function parentStillComing(tmpId, cur){
  return qRead().some(it=>String(it.tmp)===String(tmpId) && !(it.by && it.by!==cur));
}

// A hoisted declaration, not a const arrow: qRead() is defined far earlier in the file and calls this
// to self-heal a poisoned queue, so it must exist regardless of evaluation order.
function isAuthPath(p){
  const base=String(p==null?'':p).split('?')[0].replace(/^\/+/,'');
  return base==='login' || base==='logout' || base==='change_password';
}
// REMOVING A RECORD IS NOT SOMETHING TO DO LATER. If a void were queued offline, the app would say
// "removed" while she was still sitting in the worklist, the local cache and every count on the
// device — and the removal would only really happen hours later. A void goes to the server now, or it
// fails and says so. (The clinical WRITE path is unaffected: recording care still works offline.)
function isImmediatePath(p){
  const base=String(p==null?'':p).split('?')[0].replace(/^\/+/,'');
  return base==='void' || base==='unvoid';
}

// AUTHENTICATION IS NOT A CLINICAL RECORD AND MUST NEVER BE QUEUED.
// `write = method!=='GET'` meant a LOGIN - a POST - was treated like a patient record: if it was slow
// or blipped, api() "helpfully" queued it and returned {queued:true}. That reply carries no user, so the
// app never actually signed anyone in; it just said the session had expired, and the next attempt was
// queued too. The provider was locked out of the tool entirely while the badge reported "3 pending".
// Replaying a stale password later is also plainly wrong. Auth reaches the network or FAILS LOUDLY.
async function api(method, path, bodyObj){
  const auth=isAuthPath(path) || isImmediatePath(path);  // neither may be deferred to the queue
  const write=method!=='GET';
  const queueable=write && !auth;
  const cid=queueable?newCid():null;   // stable key: a replay cannot double-commit

  // A record that has not synced yet lives only on this device. Never ask the server about it — it
  // has never heard of it, and the 404 would blank her chart.
  const seg0=String(path).split('?')[0].split('/');
  if(!write && isLocalId(seg0[1])) return localRows(seg0[0]+'?id='+seg0[1])[0] || null;
  if(!write && /[?&](ep|episode|woman|mother|client|id)=-\d+/.test(path)) return localRows(path);

  let res=null;
  try{
    const headers={'Content-Type':'application/json'}; if(cid) headers['X-Idempotency-Key']=cid;
    res=await tfetch(API_BASE+'api/'+path,{method,headers,
      credentials:'include',body:bodyObj?JSON.stringify(bodyObj):undefined},
      auth?25000:undefined);      // signing in is worth waiting longer for than a worklist refresh
  }catch(e){
    // No HTTP response at all: airplane mode, DNS failure, connection refused, mobile data with
    // no route. Nothing reached the server, so the entry is safe to queue and replay.
    if(isImmediatePath(path)) throw new Error('You are offline. A record can only be removed while you are connected — otherwise it would still be on this device and in the counts.');
    if(auth) throw new Error('Could not reach the server to sign you in. Check the connection and try again.');
    if(queueable) return queueWrite(method,path,bodyObj,cid);
    // AND THE READ IS SERVED FROM THE DEVICE. This is what makes the tool usable in a facility with
    // no signal: the worklists, and every chart she has opened before, are still there.
    const cached=ocGet(path);
    if(cached!==null && cached!==undefined) return mergeLocal(path,cached);
    const loc=localRows(path);
    if(loc.length) return loc;
    throw e;
  }
  // A RESPONSE IS NOT A SAVE. The old code set reached=true the moment fetch() resolved and only
  // queued when it had NOT resolved — so a 502, a captive portal and an expired session each threw
  // the observation away while telling the provider her entries were "still queued". They were not.
  if(res.status===401){
    // On a LOGIN, 401 means "wrong username or password" - NOT "your session expired". Signing the user
    // out here (and queueing the attempt) is what created the lock-out loop.
    // ...but a 401 on a VOID really is an expired session — it is not a login attempt.
    if(isImmediatePath(path)){ sessionLost(); throw new Error('Your session has expired — please sign in again.'); }
    if(auth){ const d=await res.json().catch(()=>({})); throw new Error((d&&d.error)||'Incorrect username or password.'); }
    if(queueable){ const r=queueWrite(method,path,bodyObj,cid); sessionLost(); return r; }
    sessionLost(); throw new Error('Your session has expired — please sign in again.');
  }
  if(res.status>=500){                       // 500/502/503/504 — the server is unwell, not the data
    if(auth) throw new Error('The server is not responding (HTTP '+res.status+'). Please try again in a moment.');
    if(queueable) return queueWrite(method,path,bodyObj,cid);
    const c1=ocGet(path); if(c1!==null&&c1!==undefined) return mergeLocal(path,c1);
    throw new Error('The server is not responding (HTTP '+res.status+'). Please try again.');
  }
  let data=null;
  try{ data=await res.json(); }
  catch(e){
    // A 200 that is not JSON is a wifi sign-in page, not a save.
    if(auth) throw new Error('No usable response from the server — you may be behind a wifi sign-in page.');
    if(queueable) return queueWrite(method,path,bodyObj,cid);
    const c2=ocGet(path); if(c2!==null&&c2!==undefined) return mergeLocal(path,c2);
    throw new Error('No usable response from the server — you may be behind a wifi sign-in page.');
  }
  // 403 (forbidden / password change required / cross-origin) and 4xx (validation, duplicate MRN)
  // are faults in the REQUEST. Replaying them can never succeed, so they are surfaced, not queued.
  if(!res.ok) throw new Error((data&&data.error)||('HTTP '+res.status));

  // The read succeeded: keep it, so she can still see it when the signal goes. Merge in anything
  // created on this device that has not synced yet, or a woman registered offline would disappear
  // from the worklist the moment the network came back but before the queue drained.
  if(!write){ ocPut(path,data); return mergeLocal(path,data); }
  return data;
}

// An expired session is NOT offline. Tear down the fake logged-in state and make her sign in.
function sessionLost(){
  if(!ME) return;
  ME=null; localStorage.removeItem('me');
  try{ route(); }catch(e){}
  const n=qRead().length;
  toast('Your session has expired. Please sign in again'+(n?(' — '+n+' unsent '+(n===1?'entry is':'entries are')+' safely queued and will be sent when you do.'):'.'));
}

let _flushing=false;
async function flush(){
  // RE-ENTRANCY GUARD. boot(), the 60-second timer and the browser's 'online' event can all fire
  // at once. Two concurrent flushes replay the same items — and because the server claimed the
  // idempotency key only AFTER committing, both passed the duplicate check and both inserted.
  // That is a duplicate episode, a duplicate visit, a duplicate baby.
  if(_flushing) return;
  _flushing=true;
  try{
    const cur=(ME&&ME.id)||null;
    if(!cur || !online()) return;
    const tried=new Set();
    for(;;){
      // Re-read every iteration: anything the provider saves mid-flush must survive.
      const it=qRead().find(x=>!tried.has(x.cid) && !(x.by && x.by!==cur));
      if(!it) break;
      tried.add(it.cid);

      // ---- RECONCILE THE LOCAL IDS ----------------------------------------------------------
      // A woman registered offline was given a local id, and her episode, her partograph and her
      // babies all point at it. Her POST goes first (the queue is FIFO), the server hands back her
      // real id, and every later item is rewritten to it here. The SERVER NEVER SEES A LOCAL ID.
      const m=idmap();
      const path=String(it.path).replace(/^([^?]*\/)(-\d+)/, (s,pre,id)=> (m[id]!==undefined ? pre+m[id] : s));
      const body=subIds(it.bodyObj, m);
      const pending=unresolvedRefs(body,m).concat((String(path).match(/\/(-\d{13,})/g)||[]).map(s=>s.slice(1)));
      if(pending.length){
        // This row points at a parent (a woman, an episode) that has not synced yet. Never send an id
        // the server cannot resolve — that is how a partograph ends up attached to nothing.
        //
        // But "wait for the parent" MUST NOT mean "wait forever". If the parent was REJECTED (a
        // duplicate MRN is the classic case) it will never get a real id, and the old code sat on
        // this item and `break`-ed on every future flush — so every record on the device, for every
        // patient, never synced again, silently, while the badge just said "N pending".
        //
        // So: if any queued item will still create that parent, wait (it is ahead of us, FIFO). If
        // NOTHING in the queue will ever produce it, this row is an ORPHAN — surface it on the failed
        // screen where a human can act on it, and let the rest of the queue drain.
        const orphan=pending.filter(t=>!parentStillComing(t,cur));
        if(orphan.length){
          dlqAdd(it,0,'the record it belongs to could not be saved (see the entries above) — this one needs to be re-entered against the correct patient');
          if(it.tmp) locUpdate(it.tmp,{_failed:1,_why:'the parent record could not be saved'});
          qDrop(it.cid);
          continue;                            // DRAIN THE REST — one bad parent no longer freezes the device
        }
        continue;                              // parent is still in the queue ahead of us: skip, retry next pass
      }

      let res=null;
      try{
        const hd={'Content-Type':'application/json'}; if(it.cid) hd['X-Idempotency-Key']=it.cid;
        res=await tfetch(API_BASE+'api/'+path,{method:it.method,headers:hd,
          credentials:'include',body:JSON.stringify(body)});
      }catch(e){ break; }                     // network dropped again — stop. Everything stays queued.

      if(res.ok){
        // If this item CREATED something, learn its real id and retire the local copy.
        if(it.tmp){
          const d=await res.json().catch(()=>({}));
          const real=(d && (d.id || (Array.isArray(d.ids)&&d.ids[0]))) || null;
          // Do NOT ocClear() here, and do NOT locDrop() her.
          //   ocClear() wiped the ENTIRE read cache on the first successful create — so when the
          //   signal died mid-flush (the normal case on a 2G link) the device was left offline with
          //   an empty cache and the provider could see NO patients at all.
          //   locDrop() then deleted the only local copy, so between syncing and the next successful
          //   GET she appeared in neither the cache nor the local rows — she vanished.
          // Instead: KEEP her local row and swap in the real id. mergeLocal() de-duplicates her
          // against the server's list by id, so she shows exactly once, continuously; and locPrune()
          // retires the local copy the moment a fresh server response actually contains her.
          if(real){ idmapPut(it.tmp, real); locReconcile(it.tmp, real); }
          // An ARRAY create (ANC risk screening, checklist, BEmONC) makes one local row PER ITEM. Only
          // ids[0] used to be reconciled, so the other thirty kept `_local:1` for ever: locPrune (which
          // only retires _synced rows) never touched them, mergeLocal kept appending them to every later
          // GET, and because they land LAST they OVERWROTE the server's current answer - so an item
          // corrected by anyone still showed the stale offline answer here, and re-saving pushed the
          // stale answer back to the server. Reconcile them all.
          if(Array.isArray(it.tmps) && Array.isArray(d && d.ids)){
            it.tmps.forEach((t,i)=>{ const rid=d.ids[i];
              if(rid!==undefined && rid!==null){ idmapPut(t, rid); locReconcile(t, rid); } });
          }
        }
        qDrop(it.cid); continue;              // sent. Remove THIS item, by cid.
      }

      if(res.status===401){ sessionLost(); break; }   // keep the lot; they replay after sign-in
      if(res.status===403){
        // NOT a session problem. 403 is also returned for "password change required" and for the
        // CSRF origin check. Signing her out here put the app in an endless logout loop that she
        // could not escape and the queue never drained. Stop quietly and try again later.
        break;
      }
      if(res.status>=500){
        const t=qBump(it.cid);
        if(t>=8){ dlqAdd(it,res.status,'the server kept failing'); qDrop(it.cid); continue; }
        // HEAD-OF-LINE BLOCKING. A 5xx used to stop the whole flush, on the reasonable theory that
        // the server is unwell and hammering it will not help. But if the 5xx is caused by ONE
        // entry the server will never accept, that entry sits at the head of the queue and blocks
        // every valid record behind it — a whole offline shift stuck behind one bad row, while the
        // provider is told only "sync N pending".
        //   * first two failures  -> back off. The server probably IS unwell; give it a moment.
        //   * after that          -> step OVER this entry and drain the rest. It stays queued and
        //                            keeps retrying, and is surfaced on the failed screen at 8.
        if(t<2) break;
        continue;
      }
      // 4xx — the server rejected the CONTENT. Retrying cannot help. It goes to the failed list,
      // which is VISIBLE and recoverable (see failedScreen).
      const why=(await res.json().catch(()=>({}))).error||('rejected (HTTP '+res.status+')');
      dlqAdd(it,res.status,why);
      // If this was a record CREATED on this device, the local copy is the only copy — keep it, but
      // mark it so she is not left thinking it synced. The classic case: two tablets both registered
      // the same woman offline and the second one collides on her MRN. That is a decision for a
      // human, not something to silently drop or silently duplicate.
      if(it.tmp) locUpdate(it.tmp,{_failed:1,_why:(res.status===409?'This MRN already exists — she may already be registered':why)});
      qDrop(it.cid);
    }
  } finally { _flushing=false; paintNet(); }
}

function paintNet(){
  const n=$('#net'); if(!n) return;
  const q=qRead(), cur=(ME&&ME.id)||null;
  const mine=q.filter(x=>!x.by || x.by===cur).length;
  const theirs=q.length-mine;                       // queued by someone else on this shared tablet
  const dl=dlqRead().length;
  let t = online() ? (mine?('sync '+mine+' pending'):'online') : 'offline';
  if(theirs) t += ' · '+theirs+' for another user';
  if(dl)     t += ' · '+dl+' failed';
  n.textContent=t;
  n.className='pill '+(!online()?'red':((mine||dl)?'amber':'green'));
  n.style.cursor=(dl||theirs)?'pointer':'';
  n.onclick=(dl||theirs)?(()=>{ location.hash='#failed'; }):null;
  n.title=(dl?'Tap to see the entries that could not be saved.':(theirs?'Entries queued by another user on this device. They will send when that user signs in.':''));
}
window.addEventListener('online',()=>{paintNet();flush().then(warmCache);}); window.addEventListener('offline',paintNet);

// FILL THE CACHE WHILE THERE IS SIGNAL, so there is something to work from when there is not.
// Without this, a provider whose device has never loaded a worklist opens the app in a facility with
// no signal and sees nothing at all. This runs quietly in the background whenever she is online.
// THE REFERRAL LOOP HAD NO END. `referred` was set and nothing ever wrote `returned_at` — the column
// existed, the API accepted it, and no screen sent it. So a woman referred out carried the amber
// "referred" pill for the rest of her care, and a provider looking at the postnatal list could not
// tell who was still away and who had come back and was sitting in front of her.
function referPill(r){
  if(!r || r.referred!=1) return '';
  if(r.returned_at) return '<span class="pill green" title="Returned '+esc(String(r.returned_at).slice(0,16))+'">referred &middot; came back</span>';
  return '<span class="pill amber">referred &mdash; away</span>';
}

// A record created on this device and not yet sent. She must be able to SEE that — otherwise she has
// no way to know that the tablet in her hand holds the only copy of this woman's chart.
function syncPill(r){
  if(!r || !isLocalId(r.id)) return '';
  const l=locAll().find(x=>String(x.id)===String(r.id));
  if(l && l._failed) return '<span class="pill red" title="'+esc(l._why||'')+'">not sent &mdash; needs attention</span>';
  return '<span class="pill amber" title="Recorded on this device. It will be sent when you are back online.">on this device &mdash; not sent yet</span>';
}

async function warmCache(){
  if(!online() || !ME || ME._offline) return;
  const paths=['episodes','episodes?category=anc','episodes?category=labour','episodes?category=pnc',
               'episodes?flag=highrisk','providers','pregnancy_tests','fp_clients','imm_clients','pmtct','women?q='];
  for(const p of paths){ try{ await api('GET',p); }catch(e){ break; } }   // one failure = signal gone; stop
}

// The failed queue used to be WRITE-ONLY: a rejected entry was pushed into localStorage.dlq and
// nothing ever read it back. The provider saw "· 1 failed" and had no way to find out what failed,
// for whom, or to do anything about it. Her record was unreachable JSON on a shared tablet.
async function failedScreen(){
  const dl=dlqRead(), cur=(ME&&ME.id)||null;
  const theirs=qRead().filter(x=>x.by && x.by!==cur);
  const fmt=o=>esc(JSON.stringify(o.bodyObj||{},null,1).slice(0,600));
  app().innerHTML=nav()+`
  <div class="card"><h3>Entries that could not be sent</h3>
    ${dl.length?`<p class="muted">These were rejected by the server. Nothing here has been saved. Correct the record in the patient's chart, then discard the entry — or retry it if you think the problem is fixed.</p>
     ${dl.map((d,i)=>`<div class="card" style="border-left:4px solid #a32d2d">
        <b>${esc(d.method)} ${esc(d.path)}</b> <span class="muted">&middot; queued ${esc(d.queued_at||'')} by ${esc(d.by_name||'—')} &middot; failed ${esc(d.failed_at||'')}</span>
        <div style="color:#a32d2d;margin:4px 0">${esc(d.why||('HTTP '+d.status))}</div>
        <pre style="background:#f6f7f7;padding:8px;border-radius:6px;overflow:auto;font-size:11px;margin:6px 0">${fmt(d)}</pre>
        <button class="sm" data-retry="${i}">Retry</button>
        <button class="sm" data-drop="${i}" style="background:#a32d2d">Discard</button>
       </div>`).join('')}
     <button id="dlexp">Download all as a file</button>`
    :'<p class="muted">Nothing has failed. Every entry has been sent.</p>'}
  </div>
  ${theirs.length?`<div class="card"><h3>Waiting for another user</h3>
    <p class="muted">${theirs.length} ${theirs.length===1?'entry was':'entries were'} recorded on this device by
    <b>${esc(theirs[0].by_name||'another user')}</b> and could not be sent before they signed out. They will send
    automatically the next time that user signs in on this device. They are not lost.</p></div>`:''}`;

  document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=async()=>{
    const i=+b.dataset.retry, d=dlqRead(); const it=d[i]; if(!it) return;
    d.splice(i,1); dlqWrite(d);
    delete it.status; delete it.why; delete it.failed_at; it.tries=0;
    it.cid=newCid();                                    // a fresh key: the old one may be recorded server-side
    // Re-queue at the HEAD, not the tail. A retried item is almost always a PARENT (the woman whose
    // MRN collided), and everything that depends on her is already in the queue. Pushing her to the
    // back put her behind her own children, which then could not resolve her — so "Retry" appeared
    // to do nothing at all. She goes first; her children resolve behind her.
    const q=qRead(); q.unshift(it); qWrite(q);
    toast('Queued again — trying now','ok'); await flush(); failedScreen();
  });
  document.querySelectorAll('[data-drop]').forEach(b=>b.onclick=()=>{
    const i=+b.dataset.drop;
    if(!confirm('Discard this entry? It was never saved, and this cannot be undone.')) return;
    const d=dlqRead(); d.splice(i,1); dlqWrite(d); paintNet(); failedScreen();
  });
  const ex=$('#dlexp');
  if(ex) ex.onclick=()=>{ const bl=new Blob([JSON.stringify(dlqRead(),null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(bl);
    a.download='adhere_failed_entries_'+localDate()+'.json'; a.click(); };
}
// Visible feedback so a save can never fail silently (api() throws on any non-OK response).
function toast(msg,kind){ let t=document.getElementById('toast'); if(!t){ t=document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);color:#fff;padding:10px 18px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:9999;max-width:92%;font-size:14px;transition:opacity .3s'; document.body.appendChild(t); } t.style.background=(kind==='ok')?'#0f6e56':'#a32d2d'; t.textContent=msg; t.style.opacity='1'; clearTimeout(t._h); t._h=setTimeout(()=>{ t.style.opacity='0'; },4500); }
window.addEventListener('unhandledrejection',e=>{ const m=(e.reason&&e.reason.message)?e.reason.message:''; if(m&&m!=='undefined') toast('Could not save — '+m+'. Nothing was recorded; please try again.'); });

async function boot(){
  try{ MODEL=await (await fetch('model/risk_model.json')).json(); RM=new RiskModel(MODEL); }catch(e){}
  try{ NBMODEL=await (await fetch('model/newborn_model.json')).json(); NRM=new RiskModel(NBMODEL); }catch(e){}
  try{ RULES=await (await fetch('model/mch_rules.json')).json(); RE=new RulesEngine(RULES); }catch(e){}
  // Distinguish THREE states that used to be conflated into one:
  //   (a) the server answered and we have a session  -> log in
  //   (b) the server answered and said "no user"      -> the session is GONE. Show the login
  //       screen. Do NOT resurrect the cached user: doing that rendered a full working admin
  //       UI over an empty database, every write 401'd, and the provider never knew.
  //   (c) the server could not be reached             -> we are genuinely offline. The cached
  //       user is legitimate here, because writes will queue and replay.
  let reachedServer=false;
  try{
    const res=await fetch(API_BASE+'api/me',{credentials:'include'});
    reachedServer=true;
    const r=await res.json();
    ME=r.user||null;
    if(ME) localStorage.me=JSON.stringify(ME);
    else localStorage.removeItem('me');          // (b) the cached identity is stale — bin it
  }catch(e){ /* (c) network failure */ }
  if(!ME && !reachedServer && localStorage.me){ ME=JSON.parse(localStorage.me); ME._offline=true; }

  paintNet(); route();
  // FLUSH AT START-UP. The queue was only ever flushed on the browser's `online` event, which
  // does not fire on page load — so a device that recorded data offline, was closed, and was
  // reopened on a working connection showed "sync N pending" for ever and never sent it.
  if(ME && !ME._offline) flush().then(warmCache);
  // The 60-second loop must never OVERLAP itself. setInterval does not wait for an async body, so on
  // a slow link a new cycle started every 60 s while the previous one was still in flight, piling
  // requests onto an already-starved connection. One cycle at a time.
  let _cycling=false;
  setInterval(async()=>{
    if(!ME || !online() || _cycling) return;
    _cycling=true;
    try{ await flush(); await warmCache(); }
    catch(e){}
    finally{ _cycling=false; }
  }, 60000);
}
$('#logout').onclick=async()=>{
  // Do not let her walk away from unsent records. They are keyed to HER user id, so once she signs
  // out they are skipped on every flush and sit on the tablet, invisible, until she signs in on
  // this same device again. If the tablet is wiped or reassigned first, they are gone for good.
  const mine=qRead().filter(x=>!x.by || x.by===((ME&&ME.id)||null));
  if(mine.length){
    if(online()){ toast('Sending '+mine.length+' unsent '+(mine.length===1?'entry':'entries')+' before signing out…'); await flush(); }
    const left=qRead().filter(x=>!x.by || x.by===((ME&&ME.id)||null)).length;
    if(left && !confirm(left+' '+(left===1?'entry has':'entries have')+' not been sent yet.\n\nThey stay on THIS device and will only send when you sign in here again. If you sign out now, nobody else can send them.\n\nSign out anyway?')) return;
  }
  try{ await api('GET','logout'); }catch(e){}
  ME=null; localStorage.removeItem('me'); location.hash=''; route(); paintNet();
};
window.addEventListener('hashchange', route);

function route(){
  // A CORRECTION IN PROGRESS DOES NOT SURVIVE LEAVING THE SCREEN.
  //
  // EDIT_ANC / EDIT_PNC / EDIT_BABY / EDIT_VITAL / EDIT_DEL hold the ROW BEING CORRECTED, including
  // its id. Nothing cleared them on navigation. So: press Correct on Almaz's ANC contact, get called
  // away, tap Home, open Fatuma's ANC screen — the form comes up pre-filled with ALMAZ's readings,
  // and pressing Save PATCHes ALMAZ's row with them. A correction to one woman written into another
  // woman's record, with no warning and nothing on screen to say so.
  //
  // Every Correct button calls its screen function DIRECTLY (never via the hash), so clearing the
  // flags here — on a real navigation — cancels a stale edit without ever cancelling a live one.
  EDIT_ANC=null; EDIT_PNC=null; EDIT_BABY=null; EDIT_VITAL=null; EDIT_DEL=null;
  $('#who').textContent = ME?(' — '+ME.full_name+' ['+ME.role+']'+(ME.facility_name?' · '+ME.facility_name:'')+(ME._offline?' · offline':'')):'';
  $('#logout').style.display = ME?'inline-block':'none';
  if(!ME) return login();
  if(ME.must_change_password==1 && !ME._offline) return forcePw();
  const h=(location.hash||'#home').slice(1); const [screen,arg]=h.split('/');
  // Modals live on document.body, not inside #app, so a route change does not clear them.
  // Without this, a risk popup raised for one woman stays on screen over the NEXT patient's
  // chart — showing her data and blocking the UI. Always tear it down on navigation.
  document.getElementById('mdl')?.remove();
  ({home:home,register:register,antenatal:ancList,labour:labour,highrisk:highriskList,partograph:partograph,anc:ancScreen,
    checklist:checklist,danger:danger,delivery:delivery,pnc:pnc,dashboard:dashboard,users:users,facilities:facilities,
    referral:referralScreen,ancvisit:ancVisits,pncvisit:pncVisits,baby:babiesScreen,handover:handoverScreen,vitals:vitalsScreen,report:reportScreen,editwoman:editWoman,patient:patientHub,facilityedit:facilityEdit,bemonc:bemoncScreen,supervisor:supervisorDash,reminders:remindersScreen,registers:registersScreen,pregtest:pregTest,
    fp:fpScreen,fpclient:fpClient,imm:immScreen,immclient:immClient,pmtct:pmtctScreen,pmtctclient:pmtctClient,
    find:findWoman,failed:failedScreen,voided:voidedScreen,
    letter:letterScreen, export:exportScreen,
    account:accountScreen}[screen]||(ME.role==='supervisor'?supervisorDash:home))(arg);
}

function forcePw(){
  $('#logout').style.display='inline-block';
  app().innerHTML=`<div class="card" style="max-width:390px;margin:44px auto">
    <h3>Set a new password</h3>
    <p class="muted">For security, choose a new password before continuing.</p>
    <label>Current password<input id="cp0" type="password" autocomplete="current-password"></label>
    <label style="margin-top:8px">New password (min 8 characters)<input id="np1" type="password" autocomplete="new-password"></label>
    <label style="margin-top:8px">Confirm new password<input id="np2" type="password" autocomplete="new-password"></label>
    <button class="act" id="setpw" style="margin-top:12px">Save and continue</button> <span class="muted" id="fpm"></span></div>`;
  $('#setpw').onclick=async()=>{ const a=np1.value,b=np2.value,c=cp0.value;
    if(a.length<8){ $('#fpm').textContent=' at least 8 characters'; return; }
    if(a!==b){ $('#fpm').textContent=' passwords do not match'; return; }
    try{ const r=await api('POST','password',{current:c,new:a}); if(r&&r.ok){ ME.must_change_password=0; localStorage.me=JSON.stringify(ME); location.hash='#home'; route(); } else $('#fpm').textContent=' '+((r&&r.error)||'error'); }catch(e){ $('#fpm').textContent=' '+(e.message||'error'); } };
}

function login(){
  app().innerHTML='';
  const c=el(`<div class="card" style="max-width:360px;margin:48px auto">
    <h3 style="justify-content:center">Sign in</h3>
    <p class="muted" style="text-align:center;margin-top:-6px">ADHERE+ : MCH &mdash; AI Decision Support</p>
    <label>Username<input id="u" autocomplete="username" autofocus></label>
    <label style="margin-top:8px">Password<input id="p" type="password" autocomplete="current-password"></label>
    <button class="act" id="go" style="margin-top:14px;width:100%">Sign in</button>
    <p class="muted" id="msg" style="text-align:center"></p></div>`);
  app().appendChild(c);
  $('#go').onclick=async()=>{ try{ const r=await api('POST','login',{username:$('#u').value,password:$('#p').value}); ME=r.user; localStorage.me=JSON.stringify(ME); location.hash='#home'; route(); }catch(e){ $('#msg').textContent=e.message; } };
}

function nav(){ const h=(location.hash||'#home').split('/')[0]; const on=x=>h===x?' on':'';
  const L=(href,txt)=>`<a class="nav${on(href)}" href="${href}">${txt}</a>`;
  const B=(href,txt)=>`<a class="bn${on(href)}" href="${href}">${esc(txt)}</a>`;
  const _p=(location.hash||'').replace(/^#/,'').split('/'); const _EP=['partograph','anc','checklist','danger','delivery','baby','bemonc','handover','referral','report','vitals','ancvisit','pncvisit'];
  const back=(_EP.indexOf(_p[0])>=0 && _p[1] && /^\d+$/.test(_p[1]))?`<a class="nav" href="#patient/${_p[1]}" style="font-weight:600">‹ Back to patient</a>`:'';
  // sticky patient context bar (uses cache set by patientHub)
  const _pid=(_p[0]==='patient'||_EP.indexOf(_p[0])>=0)?_p[1]:null; const C=window.CTX;
  const pbar=(_pid && C && String(C.id)===String(_pid))?`<div class="pbar"><div class="pav">${esc(C.ini)}</div><div class="pinfo"><div class="pnm">${esc(C.name)}</div><div class="pmeta">${esc(C.meta)}</div></div>${_p[0]!=='patient'?`<a class="pback" href="#patient/${_pid}">Hub</a>`:''}</div>`:'';
  if(ME.role==='supervisor') return pbar+`<nav class="navbar">${L('#supervisor','Supervisor')}${L('#reminders','Reminders')}</nav><nav class="botnav">${B('#supervisor','Board')}${B('#reminders','Alerts')}</nav>`;
  // ONE place to navigate: Home. The tab strip used to repeat Antenatal / Labour / Postnatal /
  // Dashboard, which are the very same links as the Home tiles — two controls for one
  // destination, and a strip that grew with every new module. Home is the launcher now, and it
  // can do what a tab never could: show live counts, and show what a role is allowed to touch.
  const top=`<nav class="navbar">${back}
  ${L('#home','Home')}
  ${L('#dashboard','Dashboard')}</nav>`;
  const bot=`<nav class="botnav">${B('#home','Home')}${B('#dashboard','Dashboard')}</nav>`;
  return pbar+top+bot; }

// ---- HOME = the launcher -----------------------------------------------------
// Full-width tiles grouped by what the provider is DOING, not by which paper register
// it maps to. Adding a module adds a tile, not a tab.
function tileHtml(href,icon,title,sub,tone,ro){
  const c={teal:['#e1f5ee','#5dcaa5','#04342c','#0f6e56'],
           red:['#fcebeb','#f09595','#791f1f','#a32d2d'],
           soft:['#eef6f5','#dbe7e4','#0b3d3a','#5b6663'],
           plain:['#f7f9f9','#e6eae8','#334155','#5b6663']}[tone||'soft'];
  // `ro` = this role may open it but may not save. Say so on the tile, rather than letting
  // them fill in a form and meet a 403 at the end of it.
  const badge = ro ? `<span style="float:right;font-size:10px;font-weight:600;letter-spacing:.03em;background:#fff;border:1px solid ${c[1]};color:${c[3]};border-radius:20px;padding:1px 7px">VIEW ONLY</span>` : '';
  return `<a href="${href}" class="tile" style="display:block;text-decoration:none;background:${c[0]};border:1px solid ${c[1]};border-radius:12px;padding:14px 13px">
    <div style="font-size:20px;line-height:1">${icon}${badge}</div>
    <div style="font-size:14px;font-weight:600;color:${c[2]};margin-top:6px">${title}</div>
    <div style="font-size:11px;color:${c[3]};margin-top:1px">${sub||''}</div></a>`;
}
// What each role may actually WRITE. This mirrors the server's require_role() gates exactly —
// the server is the enforcement, this is only so the UI stops misleading people.
//   clinical  = partograph, ANC/delivery/PNC entry, newborn, labs, risk scores, PMTCT
//   intake    = registering a woman, pregnancy test, opening an episode
//   fp        = family planning, LAFP removal, immunization
function canDo(what){
  const r=ME.role;
  // ADMIN() covers admin AND super_admin. Testing r==='admin' literally here made a super_admin
  // fall through to the observer branch: every clinical tile came up VIEW ONLY for the one account
  // that is supposed to be able to do everything.
  if(ADMIN()) return true;
  if(r==='provider') return what!=='admin';
  if(r==='recorder') return (what==='intake'||what==='fp');
  return false;                                  // observer, supervisor: read-only
}
function tileGrid(inner){ return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px">${inner}</div>`; }
function sectionLabel(t){ return `<div style="font-size:11px;letter-spacing:.05em;color:#8a9490;margin:2px 0 6px">${t}</div>`; }

async function home(){
  const ec=(window.Ethiopian?Ethiopian.fmt(new Date()):'');
  const isAdmin=ADMIN();
  // Home is now the ONLY way to navigate, so its tiles have to carry real information:
  // how many are waiting, and whether you are allowed to act.
  let hr=0,lab=0,pm=0,anc=0,pnc=0;
  try{ const eps=await api('GET','episodes');
       hr =(eps||[]).filter(e=>e.high_risk==1).length;
       lab=(eps||[]).filter(e=>e.service_category==='labour'&&e.status==='laboring').length;
       anc=(eps||[]).filter(e=>e.service_category==='anc'&&e.status==='active').length;
       pnc=(eps||[]).filter(e=>e.service_category==='pnc'&&e.status==='active').length; }catch(e){}
  try{ const pms=await api('GET','pmtct'); pm=(pms||[]).filter(pmtctNeedsAction).length; }catch(e){}
  let pt=0;
  try{ const pts=await api('GET','pregnancy_tests'); pt=(pts||[]).filter(x=>x.result==='pending').length; }catch(e){}
  const roClin=!canDo('clinical'), roIntake=!canDo('intake'), roFp=!canDo('fp');
  const n=(c,unit,idle)=>c?(c+' '+unit):idle;

  app().innerHTML=nav()+`<div class="card">
    <h3>Welcome, ${esc(ME.full_name)}</h3>
    <p class="muted" style="margin-bottom:14px">${esc(ME.role)}${ME.facility_name?' · '+esc(ME.facility_name):''}${ec?' · '+ec:''}</p>
    ${roClin&&!ADMIN()?`<p class="muted" style="font-size:12px;margin:-8px 0 12px">Tiles marked <b>VIEW ONLY</b> can be opened and read, but not saved to, with your role.</p>`:''}

    ${sectionLabel('CARE CONTINUUM')}
    ${tileGrid(
      tileHtml('#register','&#128100;','Register','New client','teal',roIntake)+
      tileHtml('#find','&#128269;','Find a woman','Already registered · new episode','teal',roIntake)+
      tileHtml('#pregtest','&#129514;','Pregnancy test',(pt?pt+' awaiting result':'Results & routing'),(pt?'red':'teal'),roIntake)+
      tileHtml('#antenatal','&#128197;','Antenatal',n(anc,'in care','8 contacts'),'teal',roClin)+
      tileHtml('#labour','&#128147;','Labour ward',n(lab,'in labour','Partograph · AI'),'teal',roClin)+
      tileHtml('#pnc','&#128118;','Postnatal',n(pnc,'in care','Mother + newborn'),'teal',roClin)+
      tileHtml('#highrisk','&#9888;&#65039;','High risk',n(hr,'flagged','None flagged'),(hr?'red':'soft'),roClin)
    )}

    ${sectionLabel('FAMILY PLANNING &amp; PREVENTION')}
    ${tileGrid(
      tileHtml('#fp','&#128737;','Family planning','Methods · LAFP removal','soft',roFp)+
      tileHtml('#pmtct','&#129656;','PMTCT',n(pm,'need action','Mother + exposed infant'),(pm?'red':'soft'),roClin)+
      tileHtml('#imm','&#128137;','Immunization','Td · HPV','soft',roFp)
    )}

    ${sectionLabel('REPORTS')}
    ${tileGrid(
      tileHtml('#dashboard','&#128202;','Dashboard','Outcomes · quality','soft')+
      tileHtml('#registers','&#128203;','MoH registers','Print · export','soft')
    )}

    ${sectionLabel('ADMIN')}
    ${tileGrid(
      (isAdmin?tileHtml('#facilities','&#127973;','Facilities','','plain'):'')+
      (isAdmin?tileHtml('#users','&#128101;','Users','','plain'):'')+
      (isAdmin?tileHtml('#reminders','&#128276;','Reminders','','plain'):'')+
      (isAdmin?tileHtml('#voided','&#128465;&#65039;','Removed records','Review · restore','plain'):'')+
      ((isAdmin||ME.role==='provider'||ME.role==='supervisor')?tileHtml('#export','&#128190;','Export','The facility&rsquo;s data as a spreadsheet','plain'):'')+
      tileHtml('#account','&#9881;&#65039;','My account','Profile · password','plain')
    )}
  </div>`;
}

// Password lives HERE, not on the landing page — a provider opening the app should see
// their work, not a password form.
function accountScreen(){
  app().innerHTML=nav()+`<div class="card"><h3>My account</h3>
   <div class="grid">
    <label>Name<input value="${esc(ME.full_name||'')}" disabled></label>
    <label>Username<input value="${esc(ME.username||'')}" disabled></label>
    <label>Role<input value="${esc(ME.role||'')}" disabled></label>
    <label>Facility<input value="${esc(ME.facility_name||'')}" disabled></label>
    <label>Cadre<input value="${esc(ME.cadre||'')}" disabled></label>
   </div>
   <p class="muted" style="font-size:12px;margin-top:8px">To change your name, role or facility, ask an administrator.</p></div>

   <div class="card"><h3>Change my password</h3>
    <div class="grid">
     <label>Current password<input id="cpw" type="password" autocomplete="current-password"></label>
     <label>New password <span class="muted" style="font-weight:400">(at least 8 characters)</span><input id="npw" type="password" autocomplete="new-password"></label>
    </div>
    <button class="act" id="chpw" style="margin-top:10px">Update password</button> <span class="muted" id="pwm"></span></div>`;
  $('#chpw').onclick=async()=>{ const b=$('#chpw'); if(b.disabled) return; b.disabled=true;
    try{ const r=await api('POST','password',{current:cpw.value,new:npw.value});
      if(r&&r.ok){ $('#pwm').textContent=' updated'; cpw.value=''; npw.value=''; toast('Password updated','ok'); }
      else $('#pwm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

// ---- MoH register helpers ----------------------------------------------------
// A tick box on the paper register is a boolean. tick() renders it, tk() reads it.
function tick(id,label){ return `<label class="tick"><input type="checkbox" id="${id}"> ${label}</label>`; }
function tk(id){ const el=document.getElementById(id); return (el&&el.checked)?1:0; }

// ---- CORRECTING A RECORD -------------------------------------------------------------------
// A wrong BP, weight or GA recorded at a contact could not be corrected ANYWHERE in the tool. The
// server has always supported PATCH on anc_visits / pnc_visits / maternal_vitals — no screen called
// it. These three helpers re-fill a form from the row being corrected, using the SAME id map the
// save uses, so a field can never be shown but not saved (or saved but not shown).
//   fillVals: <input>/<select> by id            fillTicks: checkboxes by id
//   fillEcs : Ethiopian date pickers by id
function fillVals(row, map){                     // map: {elementId: 'column_name'}
  Object.keys(map).forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const v=row[map[id]];
    if(v===null||v===undefined) return;          // leave a not-recorded field blank
    el.value=String(v);
  });
}
function fillTicks(row, map){
  Object.keys(map).forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    el.checked = (row[map[id]]==1 || row[map[id]]==='1');
  });
}
function fillEcs(row, map){
  Object.keys(map).forEach(id=>{ const iso=row[map[id]]; if(iso) ecSet(id, String(iso).slice(0,10)); });
}
// RESTORE A COMMA-SEPARATED TICK GROUP ON A CORRECTION.
//
// The MoH multi-code fields (newborn problems 1-11, newborn treatments 1-6, substance use) are saved
// as a CSV of the codes ticked: `csv('np',[1..11])`. Nothing put them BACK when the provider pressed
// Correct, so the boxes re-rendered empty — and because the save sends the whole row, correcting a
// mistyped temperature silently overwrote nb_problems and nb_treatment with NULL. On a visit where a
// baby had died, it erased the recorded cause of death.
// map: { prefix: ['column_name', [codes...]] }  e.g. { np:['nb_problems',[1..11]] }
function fillCsvTicks(row, map){
  Object.keys(map).forEach(pre=>{
    const [col,codes]=map[pre];
    const have=String(row[col]==null?'':row[col]).split(',').map(s=>s.trim()).filter(Boolean);
    codes.forEach(c=>{ const el=document.getElementById(pre+c); if(el) el.checked = have.indexOf(String(c))>=0; });
  });
}

// Targeted population category — the 9-code list (A-I) from the MoH instruction page.
// (The register footer prints a contradictory 7-code list; MoH to confirm.)
const TARGET_POP=[['A','Female commercial sex workers'],['B','Long distance drivers'],['C','Mobile / daily labourers'],
  ['D','Prisoners'],['E','OVC'],['F','Children of PLHIV'],['G','Partners of PLHIV'],['H','Other MARPS'],['I','General population']];
function tpSel(id,label,val){ return `<label>${label}<select id="${id}"><option value="">-</option>`+
  TARGET_POP.map(([c,n])=>`<option value="${c}"${val===c?' selected':''}>${c}. ${n}</option>`).join('')+`</select></label>`; }
function selOpts(list,val){ return `<option value="">-</option>`+list.map(([v,n])=>`<option value="${v}"${String(val)===String(v)?' selected':''}>${n}</option>`).join(''); }

const IPPFP_METHODS=[['POP','POP — progestin-only pill'],['Imp','Implant'],['IUCD','IUCD'],['TL','Tubal ligation'],['Oth','Other']];
const ACCEPTOR=[['new','New acceptor'],['repeat','Repeat acceptor']];

// De-duplication: anything established once (at ANC or registration) is SHOWN at
// delivery and PNC rather than asked again. The MoH registers still require a
// per-encounter HIV test event, so that stays on each form — but blood group, Rh,
// target population, ART linkage and booking GA are asked once and carried forward.
// For a woman not followed at this facility these will read "—", and the provider
// fills them on her record.
function carryForward(w,rhNeg){
  const known=[w.blood_group?('Blood group <b>'+esc(w.blood_group)+(w.rh_factor?(' '+(rhNeg?'negative':'positive')):'')+'</b>'):'',
    w.ga_first_contact?('Booked <b>'+esc(w.ga_first_contact)+'w</b>'+(w.late_anc_initiation==1?' (late)':'')):'',
    (w.hiv_known_positive==1)?'HIV <b>known positive</b>':'',
    w.art_regimen?('ART <b>'+esc(w.art_regimen)+'</b>'):'',
    w.target_pop_code?('Target pop <b>'+esc(w.target_pop_code)+'</b>'):''].filter(Boolean);
  return `<div style="background:#e1f5ee;border:1px solid #5dcaa5;border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:13px;color:#04342c">
    <b>Known from her record</b> &mdash; not re-asked here. ${known.length?known.join(' &middot; '):'<span class="muted">nothing recorded yet &mdash; add it on her record</span>'}
    ${rhNeg?'<div style="margin-top:4px;color:#a32d2d"><b>Rh NEGATIVE</b> &mdash; Anti-D indicated postpartum if the baby is Rh positive.</div>':''}
   </div>`;
}

// Ethiopian-calendar date entry: 3 selects (day/month/year E.C.) -> stores Gregorian YYYY-MM-DD
// "Today" is the clinic's today, not the device's — otherwise a tablet in another zone offers the
// wrong default date across the midnight boundary. Noon avoids any edge in the EC conversion.
function ecToday(){ return (window.Ethiopian?Ethiopian.toEth(new Date(localDate()+'T12:00:00')):{year:2018,month:1,day:1}); }
// `def` = default to today. `iso` = pre-select an already-recorded Gregorian date, so that
// re-saving a form that shows an existing date does not silently blank it.
// PAGUME HAS 5 DAYS (6 in a leap year) — NOT 30. The picker offered 1..30 for every month, so a
// provider could pick "Pagume 20", which does not exist. It was accepted silently and resolved about
// three weeks into the NEXT Ethiopian year (Pagume 20, 2018 -> 25 Sep 2026, which is really
// Meskerem 15, 2019). A fortnight's error in an LNMP, an EDD or a delivery date, with no warning.
// The day list is now rebuilt from the month and year actually chosen.
function ecDayCount(ey,em){
  if(window.Ethiopian && Ethiopian.daysInMonth) return Ethiopian.daysInMonth(ey,em)||30;
  return (+em===13) ? ((+ey%4===3)?6:5) : 30;
}
// Called whenever the month or the year changes. Rebuilds the day options, keeping the chosen day
// if it still exists — and dropping it, visibly, if it does not.
function ecDays(id){
  const D=document.getElementById(id+'_d'), M=document.getElementById(id+'_m'), Y=document.getElementById(id+'_y');
  if(!D||!M||!Y) return;
  const em=+M.value, ey=+Y.value;
  if(!em||!ey) return;
  const n=ecDayCount(ey,em);
  const want=+D.value;
  D.innerHTML='<option value="">Day</option>'+Array.from({length:n},(_,i)=>i+1)
    .map(d=>`<option${d===want?' selected':''}>${d}</option>`).join('');
  if(want>n){ D.value=''; if(typeof toast==='function') toast((Ethiopian?Ethiopian.months[em-1]:'This month')+' has only '+n+' days — choose the day again.'); }
}
function ecPicker(id,label,def,iso){ const t=ecToday(); const mons=(window.Ethiopian?Ethiopian.months:[]);
  let s=null;
  if(iso && window.Ethiopian){ const dt=new Date(iso+'T00:00:00'); if(!isNaN(dt)) s=Ethiopian.toEth(dt); }
  const sel = s || (def ? t : null);                    // an existing date wins over "today"
  let years=Array.from({length:7},(_,i)=>t.year-4+i);
  if(sel && years.indexOf(sel.year)<0) years=years.concat([sel.year]).sort((a,b)=>a-b);  // don't lose an out-of-range year
  const dayN=ecDayCount(sel?sel.year:t.year, sel?sel.month:t.month);
  const days=Array.from({length:dayN},(_,i)=>i+1);
  return `<label>${label} <span class="muted" style="font-weight:400">(Ethiopian calendar)</span>
   <span style="display:flex;gap:6px;flex-wrap:wrap">
    <select id="${id}_d" style="min-width:80px"><option value="">Day</option>${days.map(d=>`<option${sel&&d===sel.day?' selected':''}>${d}</option>`).join('')}</select>
    <select id="${id}_m" style="min-width:135px" onchange="ecDays('${id}')"><option value="">Month</option>${mons.map((m,i)=>`<option value="${i+1}"${sel&&(i+1)===sel.month?' selected':''}>${m}</option>`).join('')}</select>
    <select id="${id}_y" style="min-width:90px" onchange="ecDays('${id}')"><option value="">Year</option>${years.map(y=>`<option${y===(sel?sel.year:t.year)?' selected':''}>${y}</option>`).join('')}</select>
   </span>
   <span class="muted" style="font-weight:400;font-size:11px">format: Day &middot; Month &middot; Year</span></label>`; }
function ecGet(id){ const d=($('#'+id+'_d')||{}).value, m=($('#'+id+'_m')||{}).value, y=($('#'+id+'_y')||{}).value;
  if(!(d&&m&&y&&window.Ethiopian)) return null;
  // toGreg now returns null for a date that does not exist, rather than quietly rolling it forward.
  const g=Ethiopian.toGreg(+y,+m,+d);
  if(!g && typeof toast==='function') toast('That date does not exist in the Ethiopian calendar — please check it.');
  return g; }
// Set an already-rendered EC picker from a Gregorian date (or clear it with null).
function ecSet(id,iso){ const D=$('#'+id+'_d'), M=$('#'+id+'_m'), Y=$('#'+id+'_y'); if(!D||!M||!Y) return;
  if(!iso||!window.Ethiopian){ D.value=''; M.value=''; return; }
  const dt=new Date(iso+'T00:00:00'); if(isNaN(dt)){ D.value=''; M.value=''; return; }
  const e=Ethiopian.toEth(dt);
  if(![...Y.options].some(o=>+o.value===e.year)) Y.add(new Option(e.year,e.year));
  D.value=String(e.day); M.value=String(e.month); Y.value=String(e.year); }
// ---- CLINIC WALL-CLOCK TIME --------------------------------------------------
// toISOString() emits UTC. Ethiopia is UTC+3, so every timestamp the tool wrote used to be
// three hours behind the clock on the wall:
//   - the monitoring schedule was permanently ~3h "overdue" the moment an observation saved;
//   - a birth between 00:00 and 03:00 was filed on the previous day (and, on the 1st, in the
//     previous month's MoH report);
//   - EDD came out a day early, because addDays() round-tripped through UTC.
// The Ethiopian-calendar picker has always produced local dates, so the record held UTC
// timestamps and local dates side by side.
//
// These write the CLINIC's clock (window.ADHERE_TZ), NOT the device's. Using the device's own
// zone would look identical in a correctly-configured facility and be quietly wrong everywhere
// else: a tablet set to the wrong country writes wrong clinical times, and since we store a
// wall-clock value rather than an offset, nothing downstream could ever detect it. Pinning the
// zone means the browser, PHP (APP_TZ) and the MySQL session agree no matter what the hardware
// thinks the time is. Ethiopia observes no DST, but Intl handles DST correctly anyway, so this
// stays right if ADHERE+ is deployed somewhere that does.
const p2=n=>String(n).padStart(2,'0');
const TZ=()=> (window.ADHERE_TZ || 'Africa/Addis_Ababa');
// Break an instant into the clinic zone's calendar fields.
function tzParts(d){
  d=d||new Date();
  try{
    const f=new Intl.DateTimeFormat('en-CA',{timeZone:TZ(),hour12:false,
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const o={}; for(const p of f.formatToParts(d)) if(p.type!=='literal') o[p.type]=p.value;
    if(o.hour==='24') o.hour='00';                       // some engines render midnight as 24
    return o;
  }catch(e){                                             // no Intl/zone data: fall back to the device
    return {year:d.getFullYear(),month:p2(d.getMonth()+1),day:p2(d.getDate()),
            hour:p2(d.getHours()),minute:p2(d.getMinutes()),second:p2(d.getSeconds())};
  }
}
function localDate(d){ const o=tzParts(d); return o.year+'-'+o.month+'-'+o.day; }
function localDateTime(d){ const o=tzParts(d); return o.year+'-'+o.month+'-'+o.day+' '+o.hour+':'+o.minute+':'+o.second; }
// The clinic zone's offset from UTC at a given instant, e.g. '+03:00'.
function tzOffset(d){
  d=d||new Date();
  const o=tzParts(d);
  const asUTC=Date.UTC(+o.year,+o.month-1,+o.day,+o.hour,+o.minute,+o.second);
  const mins=Math.round((asUTC-Math.floor(d.getTime()/1000)*1000)/60000);
  const s=mins<0?'-':'+', a=Math.abs(mins);
  return s+p2(Math.floor(a/60))+':'+p2(a%60);
}
// Parse a stored 'YYYY-MM-DD HH:MM:SS' — the counterpart of localDateTime(). The stored value is
// clinic wall-clock, so it must be read back against the CLINIC's offset, not the device's, or a
// tablet in another zone would compute the wrong age for an observation.
function parseLocal(s){
  if(!s) return null;
  const t=String(s).trim().replace(' ','T');
  const d0=new Date(t);                                  // provisional, to get the offset in force
  if(isNaN(d0)) return null;
  const d=new Date(t+tzOffset(d0));
  return isNaN(d)?d0:d;
}
// ---- RESOLVE ONE EPISODE ------------------------------------------------------------------
// Six clinical screens used to pull the LIMIT-200 episode list and .find() their patient in the
// browser. Past 200 episodes — one busy quarter — an older woman simply was not in the list, the
// find() returned undefined, and the screen carried on with an EMPTY object. Silently, and
// clinically: her Rh-negative / Anti-D banner disappeared, a woman on ART was offered an HIV test,
// her delivered partograph reopened for editing, and the risk model scored her on defaults —
// age 25, parity 1, no previous caesarean. Ask the server for the one episode instead.
async function epOne(id){
  try{ const r=await api('GET','episodes?ep='+id); const e=(Array.isArray(r)?r[0]:r)||null;
    if(!e) toast('Could not load this patient\'s record — please go back and open her again.');
    return e||{};
  }catch(err){ toast('Could not load this patient\'s record — '+(err.message||'')); return {}; }
}
// Hours since the membranes ruptured. Feeds the model's rom_hours feature.
function romHrs(s){ const d=parseLocal(s); if(!d) return null;
  return Math.max(0, Math.round(((Date.now()-d.getTime())/36e5)*10)/10); }
// Pure calendar arithmetic on a Y-M-D string. Deliberately does NOT touch a time zone: an EDD is
// "LNMP + 280 days" on the calendar, and routing it through any clock (device's or clinic's) is
// what made it land a day early. Date.UTC has no DST and no local offset, so it cannot drift.
function addDays(iso,n){
  if(!iso) return null;
  const m=String(iso).slice(0,10).split('-');
  if(m.length!==3) return null;
  const d=new Date(Date.UTC(+m[0], +m[1]-1, +m[2]));
  if(isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate()+n);
  return d.getUTCFullYear()+'-'+p2(d.getUTCMonth()+1)+'-'+p2(d.getUTCDate());
}

// ---- registration validation -------------------------------------------------
// MRN length follows the facility's paper numbering: 5 digits at a health centre,
// 6 at a hospital. Anything else is a transcription slip and is worth catching here.
function mrnRule(){ const t=String((ME&&ME.facility_type)||'').toLowerCase();
  if(t==='health_center') return {min:5,max:5,label:'5 digits (health centre)'};
  if(t==='primary_hospital'||t==='general_hospital') return {min:6,max:6,label:'6 digits (hospital)'};
  return {min:5,max:6,label:'5 or 6 digits'}; }
function mrnError(v){ const r=mrnRule(); const s=String(v||'').trim();
  if(!s) return 'MRN is required';
  if(!/^\d+$/.test(s)) return 'MRN must be digits only';
  if(s.length<r.min||s.length>r.max) return 'MRN must be '+r.label+' — you entered '+s.length;
  return ''; }
// Age extremes are a risk factor in their own right, so we stop and say so.
function ageError(v){ const n=+v; if(!v||isNaN(n)) return 'Age is required';
  if(n<10||n>60) return 'Age must be between 10 and 60'; return ''; }
// ---- National ANC Guideline (MoH, Feb 2022) clinical rules --------------------
// Table 4: high-risk age is <19 OR >35. Not <18/>=35 — an 18-year-old and a
// 36-year-old both qualify. "Teenage pregnancy" is the label used below 18.
function ageRisk(n){ n=+n;
  if(n>0&&n<18) return 'Age '+n+' — teenage pregnancy. High-risk group (National ANC Guideline, Table 4): she needs specialised ANC, closer monitoring, and screening for pre-eclampsia, anaemia and obstructed labour.';
  if(n===18)    return 'Age 18 — adolescent pregnancy (under 19). High-risk group (National ANC Guideline, Table 4): she needs specialised ANC and closer monitoring.';
  if(n>35)      return 'Age '+n+' — advanced maternal age (over 35). High-risk group (National ANC Guideline, Table 4): she needs specialised ANC and closer monitoring.';
  return ''; }
// Booking after the first trimester (>12 completed weeks) is late ANC initiation.
function lateAnc(ga){ return (+ga>12); }
function gaRisk(ga){ ga=+ga; if(!ga) return '';
  return lateAnc(ga) ? ('First ANC contact at '+ga+' weeks — late ANC initiation (after the first trimester). Screening and prophylaxis started late; treat as a risk factor and catch up on the missed ANC package.') : ''; }

// Anaemia — Guideline section 5.2.2 / Table 7 (the operative clinical table).
// NB the Annex 6 ANC card says "<11.5 g/dl or Hct <36%"; the guideline contradicts
// itself. We follow Table 7 (matches WHO). Flagged to MoH for correction.
function anaemiaGrade(hb){ hb=+hb; if(!hb) return '';
  if(hb>=11) return 'normal'; if(hb>=9) return 'mild'; if(hb>=7) return 'moderate'; return 'severe'; }
function anaemiaAction(g){ return ({
  normal:'Hb normal (≥11 g/dl) — continue prophylactic iron-folate.',
  mild:'MILD anaemia (Hb 9–10.9 g/dl) — start THERAPEUTIC iron (60 mg elemental iron BID) and request peripheral RBC morphology.',
  moderate:'MODERATE anaemia (Hb 7–8.9 g/dl) — start THERAPEUTIC iron (60 mg elemental iron BID) and request peripheral RBC morphology.',
  severe:'SEVERE anaemia (Hb <7 g/dl) — REFER. Consider blood transfusion, then continue therapeutic iron.'
})[g]||''; }
// Acute malnutrition — Guideline 5.2.2d
function muacFlag(m){ return (+m>0 && +m<23); }
// BMI — Table 4 / Annex 7. Derived from height + weight, never asked.
// BMI refuses to compute from an impossible height or weight. Three women in the live database carry
// heights of 65, 45 and 55 cm — at 55 cm a normal weight gives a BMI near 200, which was displayed as
// a straight-faced clinical finding and graded "overweight". Better to show nothing and say why than
// to show a number that is certainly wrong.
function bmiCalc(kg,cm){
  kg=+kg; cm=+cm;
  if(!kg||!cm) return null;
  if(cm<RANGES.height_cm[0] || cm>RANGES.height_cm[1]) return null;   // implausible height -> no BMI
  if(kg<RANGES.weight_kg[0] || kg>RANGES.weight_kg[1]) return null;   // implausible weight -> no BMI
  return Math.round((kg/Math.pow(cm/100,2))*10)/10;
}
function bmiFlag(b){ if(!b) return ''; if(b<18.5) return 'underweight'; if(b>25) return 'overweight'; return 'normal'; }
// A modal the user must acknowledge — a toast is too easy to miss for a risk flag.
// The safety modals - IMMINENT ECLAMPSIA, newborn danger signs, PPH - are the most important dialogs in
// the app, and every one passes formatting (<b>, <br>) in its body. modal() ran esc() over the whole
// thing, so the provider was shown the literal characters "<b>IMMINENT ECLAMPSIA</b><br>She has: ..."
// instead of a legible warning. Escape EVERYTHING (a patient's name can never inject markup), then
// re-enable only the handful of harmless formatting tags the callers actually use.
function safeHtml(s){
  return esc(String(s==null?'':s))
    .replace(/&lt;(\/?)(b|i|em|strong|br|ul|ol|li|p)\s*\/?&gt;/gi, (m,slash,tag)=>'<'+slash+tag.toLowerCase()+'>');
}
function modal(title,body,kind){ const old=document.getElementById('mdl'); if(old) old.remove();
  const c=(kind==='risk')?'#a32d2d':'#0f766e';
  const d=document.createElement('div'); d.id='mdl';
  d.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px';
  d.innerHTML=`<div style="background:#fff;border-radius:14px;max-width:420px;width:100%;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)">
    <h3 style="margin:0 0 8px;color:${c};font-size:16px">${esc(title)}</h3>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#334155">${safeHtml(body)}</p>
    <button class="act" id="mdlok" style="width:100%">Understood</button></div>`;
  document.body.appendChild(d);
  // NB: do NOT name this handler `esc` — that shadows the global HTML escaper for the
  // whole function scope, and esc(title) above then hits the temporal dead zone, so the
  // modal throws ReferenceError and every safety dialog in the app silently dies.
  const onKey=(e)=>{ if(e.key==='Escape') close(); };
  const close=()=>{ d.remove(); document.removeEventListener('keydown',onKey); };
  document.addEventListener('keydown',onKey);
  d.querySelector('#mdlok').onclick=close;
  d.onclick=(e)=>{ if(e.target===d) close(); };
  d.querySelector('#mdlok').focus();
}

async function register(){
  const r=mrnRule();
  app().innerHTML=nav()+`<div class="card"><h3>Register / admit</h3>
   <div class="grid">
    <label>MRN <span class="muted" style="font-weight:400">(${esc(r.label)})</span><input id="mrn" inputmode="numeric" maxlength="${r.max}" placeholder="${'0'.repeat(r.min)}"></label>
    <label>First name<input id="fn"></label>
    <label>Father name<input id="fa"></label><label>Grandfather<input id="gf"></label>
    <label>Age<input id="age" type="number" min="10" max="60"></label>
    <label>Height (cm) <span class="muted" style="font-weight:400">— for BMI</span><input id="ht" type="number" min="120" max="200"></label>
    <label>Marital status<select id="ms"><option value="married">Married</option><option value="single">Single</option><option value="divorced">Divorced</option><option value="widowed">Widowed</option></select></label>
    <label>Phone<input id="ph" placeholder="09..."></label><label>Kebele<input id="kb"></label>
    <label>Next of kin / husband<input id="nok"></label><label>Kin phone<input id="kph" placeholder="09..."></label>
    <label>Emergency contact address<input id="kad" placeholder="kebele, woreda, landmark"></label>
    <label>Why is she here?<select id="cat">
      <option value="pregtest">Pregnancy test</option>
      <option value="anc">Antenatal care (ANC)</option>
      <option value="labour" selected>Labour &amp; delivery</option>
      <option value="pnc">Postnatal care — including a birth at home or elsewhere</option>
      <option value="fp">Family planning</option>
      <option value="pmtct">PMTCT — HIV positive</option>
      <option value="td">Immunization — Td</option>
      <option value="hpv">Immunization — HPV</option>
    </select></label>
   </div>
   <p class="muted" style="font-size:12px;margin:-4px 0 8px">Every service the tool provides has a door here. Registering her for family planning, PMTCT or immunization creates that record <b>linked to her</b> — not a second, unconnected identity.</p>
   <div id="riskbox" style="display:none;background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"></div>

   <!-- The pregnancy test is the FRONT DOOR, so it lives here, at the front door. It used to be
        its own screen that could only test a woman who was already registered — which is backwards:
        a triage test happens before she is a maternity patient at all. Now one flow does both. -->
   <div id="ptbox" style="display:none">
    <div class="grid">
     <label>Test result<select id="ptr">
       <option value="pending" selected>Not back yet — she is going to the lab</option>
       <option value="negative">Negative</option>
       <option value="positive">Positive</option></select></label>
    </div>
    <div id="ptpend" style="background:#eef6f5;border:1px solid #dbe7e4;color:#0b3d3a;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
      She will appear on the <b>pregnancy-test worklist</b> as awaiting a result. Record the result there when it comes back, and she will be routed then &mdash; positive opens her ANC episode, negative opens her family-planning record.
    </div>
    <div id="ptpos" style="display:none;background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
      <b>Positive.</b> She needs antenatal care. Registering her opens her ANC episode straight away, so she is handed over to the ANC room rather than merely told to walk there.
    </div>
    <div id="ptneg" style="display:none;background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
      <div class="ticks">${tick('ptfp','Offer family planning now (open her family-planning record)')}</div>
      <div style="margin-top:4px">She is not pregnant &mdash; and she is in the building, thinking about her fertility, with a provider in front of her. This is the highest-yield moment to offer contraception. Without this she leaves with nothing.</div>
    </div>
    <label>Note<input id="ptn" placeholder="optional"></label>
   </div>

   <details class="moh" open><summary>Obstetric history <span class="muted">&mdash; ANC card, Annex 6</span></summary><div class="grid">
    <label>Gravida<input id="gr" type="number" min="0"></label>
    <label>Para<input id="pa" type="number" min="0"></label>
    <label>Abortion<input id="ab" type="number" min="0"></label>
    <label>Ectopic pregnancy<input id="ecp" type="number" min="0"></label>
    <label>GTD<input id="gtd" type="number" min="0"></label>
    <label>Children alive<input id="ca" type="number" min="0"></label>
    <label>Previous pregnancy outcome<select id="ppo">${selOpts([['first','First pregnancy'],['live_birth','Live birth'],['stillbirth','Stillbirth'],['abortion','Abortion / miscarriage'],['neonatal_death','Neonatal death'],['caesarean','Caesarean section']])}</select></label>
    <label>Is this pregnancy planned?<select id="pp">${selOpts([['1','Yes — planned'],['0','No — unplanned / unwanted']])}</select></label>
    <label>GA at first ANC contact (weeks) <span class="muted" style="font-weight:400">— booking GA</span><input id="gafc" type="number" min="4" max="42" placeholder="weeks"></label>
   </div>
   <div id="gabox" style="display:none;background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin-top:8px;font-size:13px"></div>
   <div id="ppbox" style="display:none;background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin-top:8px;font-size:13px"></div>
   <div class="muted" style="font-size:12px;margin-top:6px">If she booked ANC elsewhere or on paper, enter the booking GA here. When ANC contact 1 is recorded in ADHERE+, this fills itself.</div></details>

   <details class="moh"><summary>Blood group, residence &amp; occupation</summary><div class="grid">
    <label>Blood group<select id="bg">${selOpts([['A','A'],['B','B'],['AB','AB'],['O','O']])}</select></label>
    <label>Rh factor<select id="rh">${selOpts([['pos','Positive'],['neg','Negative']])}</select></label>
    <label>Residence<select id="res">${selOpts([['urban','Urban'],['rural','Rural']])}</select></label>
    <label>Occupation<input id="occ"></label>
    ${tpSel('tp','Targeted population category')}
   </div>
   <div class="muted" style="font-size:12px;margin-top:6px">Targeted population is a required column on the MoH ANC, Delivery and PNC registers. Captured once here, it fills itself in on every register row.</div>
   <div id="rhbox" style="display:none;background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin-top:8px;font-size:13px"></div>
   <div class="muted" style="font-size:12px;margin-top:6px">Blood group and Rh are required for every pregnant woman (Guideline 4.2.2a). Rh-negative women need Anti-D.</div>
   <div class="muted" style="font-size:12px;margin-top:6px">Full risk screening (previous C/S, PPH, pre-eclampsia, obstructed labour, chronic conditions) is done by the provider on the ANC screening screen.</div></details>

   <button class="act" id="save" style="margin-top:6px">Register</button> <span class="muted" id="m"></span>
   <p class="muted" style="font-size:12px;margin-top:10px">Already registered and needs a pregnancy test? <a class="nav" href="#pregtest" style="padding:0">Record it on her existing record</a> &mdash; no need to register her twice.</p></div>`;

  const showRisk=()=>{ const b=$('#riskbox'); const msg=ageRisk(age.value);
    if(msg){ b.style.display=''; b.textContent=msg; } else { b.style.display='none'; } };
  let lastWarned=null;
  age.addEventListener('input',showRisk);
  age.addEventListener('blur',()=>{ const e=ageError(age.value); if(e && age.value){ $('#m').textContent=' '+e; return; }
    const msg=ageRisk(age.value);
    if(msg && age.value!==lastWarned){ lastWarned=age.value; modal('High-risk group',msg,'risk'); } });
  mrn.addEventListener('blur',()=>{ const e=mrnError(mrn.value); $('#m').textContent=e?(' '+e):''; });

  const showGa=()=>{ const b=$('#gabox'); const msg=gaRisk(gafc.value);
    if(msg){ b.style.display=''; b.textContent=msg; } else { b.style.display='none'; } };
  let gaWarned=null;
  gafc.addEventListener('input',showGa);
  gafc.addEventListener('blur',()=>{ const msg=gaRisk(gafc.value);
    if(msg && gafc.value!==gaWarned){ gaWarned=gafc.value; modal('Late ANC initiation',msg,'risk'); } });
  // Unplanned/unwanted pregnancy is a high-risk condition (Guideline Table 4).
  pp.addEventListener('change',()=>{ const b=$('#ppbox');
    if(pp.value==='0'){ b.style.display=''; b.textContent='Unplanned or unwanted pregnancy — a high-risk condition (National ANC Guideline, Table 4). She will appear in the High Risk list.'; }
    else b.style.display='none'; });
  // Rh-negative drives Anti-D.
  rh.addEventListener('change',()=>{ const b=$('#rhbox');
    if(rh.value==='neg'){ b.style.display=''; b.textContent='Rh NEGATIVE — Anti-D prophylaxis is indicated (if indirect Coombs negative). This will be flagged at every ANC contact.'; }
    else b.style.display='none'; });

  // Show the test block only when she is here for a test, and route the messaging off the result.
  const ptShow=()=>{ const on=(cat.value==='pregtest');
    $('#ptbox').style.display=on?'':'none';
    if(!on){ $('#ptpos').style.display='none'; $('#ptneg').style.display='none'; } };
  const ptRes=()=>{ $('#ptpos').style.display=(ptr.value==='positive')?'':'none';
                    $('#ptneg').style.display=(ptr.value==='negative')?'':'none';
                    $('#ptpend').style.display=(ptr.value==='pending')?'':'none'; };
  cat.addEventListener('change',()=>{ ptShow(); ptRes(); }); ptr.addEventListener('change',ptRes); ptShow(); ptRes();

  $('#save').onclick=async()=>{
    const em=mrnError(mrn.value); if(em){ $('#m').textContent=' '+em; modal('Check the MRN',em); return; }
    const ea=ageError(age.value); if(ea){ $('#m').textContent=' '+ea; modal('Check the age',ea); return; }
    // Height is stored ONCE and drives BMI at every antenatal contact — a slip here follows her all
    // pregnancy. Gravida/para bound too: a typo there feeds the risk model.
    if(!checkRanges([['ht','height_cm'],['gr','gravida'],['pa','para']])) return;
    $('#m').textContent=' saving…';
    try{
      const w=await api('POST','women',{mrn:mrn.value.trim(),first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value||null,marital_status:ms.value,phone:ph.value,kebele:kb.value,next_of_kin:nok.value,kin_phone:kph.value,kin_address:(kad.value||null),sms_consent:1,
        gravida:numOrNull(gr.value),para:numOrNull(pa.value),children_alive:numOrNull(ca.value),prev_pregnancy_outcome:(ppo.value||null),
        abortions:(ab.value===''?null:+ab.value),ectopic:(ecp.value===''?null:+ecp.value),gtd:(gtd.value===''?null:+gtd.value),
        pregnancy_planned:(pp.value===''?null:+pp.value),
        blood_group:(bg.value||null),rh_factor:(rh.value||null),residence:(res.value||null),occupation:(occ.value||null),
        target_pop_code:(tp.value||null),   // required column on all three MoH registers
        height_cm:(+ht.value||null),   // without this, BMI (a Table 4 risk factor) can never be computed
        ga_first_contact:(+gafc.value||null),late_anc_initiation:(gafc.value?(lateAnc(gafc.value)?1:0):null)});
      // A woman registered offline now gets a LOCAL id and carries straight on into her episode —
      // this used to stop dead here with "saved (offline queued)", so in a facility with no signal
      // she could be registered and then nothing further could be recorded for her at all.
      const wid=w.id;
      if(!wid){ $('#m').textContent=' could not save'; return; }
      if(w.local) toast('Registered on this device — she will be sent when you are back online','ok');

      await routeNewClient(cat.value, wid, {name:(fn.value+' '+fa.value).trim(), mrn:mrn.value.trim(), age:(+age.value||null),
        result:ptr.value, note:(ptn.value||null), fp:tk('ptfp')});
    }catch(e){
      // SHE IS ALREADY ON FILE. This used to be a dead end: the server said "This MRN already
      // exists at your facility" and the recorder's only options were to invent a second MRN —
      // splitting her history in two — or give up. A woman returning pregnant after last year's
      // postnatal care simply could not be admitted.
      if(String(e.message||'').indexOf('already exists')>=0){
        const found=await api('GET','women?q='+encodeURIComponent(mrn.value.trim())).catch(()=>[]);
        const w=(found||[]).find(x=>String(x.mrn)===mrn.value.trim());
        if(w){ $('#m').textContent='';
          modal('She is already registered',
            '<b>'+esc(((w.first_name||'')+' '+(w.father_name||'')).trim())+'</b> (MRN '+esc(w.mrn)+', '+esc(w.age||'?')+' yrs) is already on file here.<br><br>'+
            'Do not register her again — that would split her history across two records. Open her existing record and start a new episode instead.',
            'risk');
          const mdl=document.getElementById('mdl');
          if(mdl){ const btn=document.createElement('button'); btn.className='act'; btn.style.marginTop='10px';
            btn.textContent='Open her record and admit her';
            btn.onclick=()=>{ document.getElementById('mdl')?.remove(); location.hash='#find/'+w.id; };
            mdl.querySelector('div')?.appendChild(btn); }
          return; }
      }
      $('#m').textContent=' '+(e.message||'could not register');
    }
  };
}

// ---- Find a woman already on file, and start a new episode ------------------------------
// THE MISSING SCREEN. A woman returning for a new pregnancy could not be admitted at all: the
// only intake path always created a NEW `women` row, and the server rejected her own MRN as a
// duplicate. The recorder's choices were to invent a second MRN — splitting her history in two —
// or turn her away. There was no way anywhere in the application to open an existing woman and
// start a new episode.
async function findWoman(arg){
  const preId=(arg&&/^\d+$/.test(arg))?+arg:null;
  app().innerHTML=nav()+`<div class="card"><h3>Find a woman already registered</h3>
   <p class="muted">She is on file from a previous pregnancy or visit. Open her record and start a new episode &mdash; do not register her again, or her history is split across two records.</p>
   <label>Search by MRN or name<input id="fq" placeholder="her name, her father&rsquo;s name, or her MRN" autofocus></label>
   <div id="fres" style="margin-top:10px"></div></div>
   <div id="fsel"></div>`;
  const render=(list)=>{
    $('#fres').innerHTML = (list&&list.length)
      ? `<table><tr><th>MRN</th><th>Name</th><th>Age</th><th></th></tr>`+list.map(w=>`<tr>
          <td>${esc(w.mrn||'')}</td><td>${esc(((w.first_name||'')+' '+(w.father_name||'')).trim())}</td>
          <td>${esc(w.age||'')}</td><td><button class="sec" data-pick="${w.id}">Open</button></td></tr>`).join('')+`</table>`
      : '<p class="muted">No match. If she has never been seen here, register her instead.</p>';
    document.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>openWoman(+b.dataset.pick,list));
  };
  let t=null;
  // A SINGLE LETTER IS A VALID SEARCH. The two-character minimum meant typing "D" did nothing at all,
  // which is exactly what a provider does first — and it looked like the search was broken.
  $('#fq').addEventListener('input',()=>{ clearTimeout(t); const q=fq.value.trim(); if(q.length<1){ $('#fres').innerHTML=''; return; }
    t=setTimeout(async()=>{ const r=await api('GET','women?q='+encodeURIComponent(q)).catch(()=>[]); render(r||[]); },250); });

  async function openWoman(wid,list){
    const w=(list||[]).find(x=>x.id==wid)||{};
    const eps=await api('GET','episodes?woman='+wid).catch(()=>[]);
    $('#fsel').innerHTML=`<div class="card">
      <h3>${esc(((w.first_name||'')+' '+(w.father_name||'')).trim())} <span class="muted" style="font-size:13px;font-weight:400">— MRN ${esc(w.mrn||'')} · ${esc(w.age||'?')} yrs</span></h3>
      <h4>Her episodes</h4>
      <table><tr><th>#</th><th>Service</th><th>Status</th><th></th></tr>
      ${(eps||[]).map(e=>`<tr><td>${esc(e.id)}</td><td>${esc(e.service_category)}</td><td>${esc(e.status)} ${referPill(e)}</td>
        <td><a class="nav" href="#patient/${e.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=4 class=muted>No episodes yet.</td></tr>'}
      </table>
      <h4 style="margin-top:14px">Start a new episode</h4>
      <div class="grid">
       <label>Why is she here now?<select id="nsvc">
        <option value="anc">Antenatal care (ANC)</option>
        <option value="labour">Labour &amp; delivery</option>
        <option value="pnc">Postnatal care</option>
        <option value="pregtest">Pregnancy test</option>
        <option value="fp">Family planning</option>
        <option value="pmtct">PMTCT — HIV positive</option>
        <option value="td">Immunization — Td</option>
        <option value="hpv">Immunization — HPV</option>
       </select></label>
      </div>
      <button class="act" id="nsave" style="margin-top:10px">Admit her</button> <span class="muted" id="nm"></span>
      <p class="muted" style="font-size:12px;margin-top:8px">This keeps her one record. Everything already known about her — her risk factors, blood group, Rh, HIV status — follows her into the new episode.</p>
    </div>`;
    $('#nsave').onclick=async()=>{ const b=$('#nsave'); if(b.disabled) return; b.disabled=true;
      try{ await routeNewClient(nsvc.value, wid, {name:((w.first_name||'')+' '+(w.father_name||'')).trim(), mrn:w.mrn, age:w.age, result:'pending', fp:0}); }
      catch(e){ b.disabled=false; $('#nm').textContent=' '+(e.message||'error'); } };
  }
  if(preId){ const r=await api('GET','women?q=').catch(()=>[]); const w=(r||[]).find(x=>x.id===preId); if(w){ render([w]); openWoman(preId,[w]); } }
}

// One front door, every service. Registration used to create an `episodes` row and nothing else,
// so family planning, immunization and PMTCT had NO way in from the front desk — their clients
// were typed in separately, under a second identity with no link back to the woman.
async function routeNewClient(cat, wid, d){
  const today=localDate();
  if(cat==='pregtest'){
    const res=d.result||'pending'; const pos=(res==='positive');
    const t=await api('POST','pregnancy_tests',{woman_id:wid,test_date:today,result:res,note:d.note,
      link_to_anc:(pos?1:0), link_to_fp:((res==='negative'&&d.fp)?1:0), fp_offered:(res==='negative'&&d.fp)?1:0});
    if(t&&t.episode_id){ toast('Positive — ANC episode opened','ok'); location.hash='#patient/'+t.episode_id; return; }
    if(t&&t.fp_client_id){ toast('Negative — family planning record opened','ok'); location.hash='#fpclient/'+t.fp_client_id; return; }
    toast('Registered — awaiting the test result','ok'); location.hash='#pregtest'; return;
  }
  if(cat==='fp'){
    const r=await api('POST','fp_clients',{woman_id:wid,mrn:d.mrn,name:d.name,age:d.age,sex:'F',reg_date:today,acceptor:'new'});
    if(r&&r.id){ toast('Family planning record opened','ok'); location.hash='#fpclient/'+r.id; return; }
    toast('Registered','ok'); location.hash='#fp'; return;
  }
  if(cat==='td'||cat==='hpv'){
    const prog=(cat==='td')?'Td':'HPV';
    const r=await api('POST','imm_clients',{woman_id:wid,programme:prog,mrn:d.mrn,name:d.name,age:d.age,
      pregnant:(prog==='Td'?1:null),reg_date:today});
    if(r&&r.id){ toast(prog+' record opened','ok'); location.hash='#immclient/'+r.id; return; }
    toast('Registered','ok'); location.hash='#imm'; return;
  }
  if(cat==='pmtct'){
    const r=await api('POST','pmtct',{woman_id:wid,name:d.name,mrn:d.mrn,age:d.age,booking_date:today,known_positive:2});
    if(r&&r.id){ toast('Enrolled in PMTCT — complete her ART details','ok'); location.hash='#pmtctclient/'+r.id; return; }
    toast('Registered','ok'); location.hash='#pmtct'; return;
  }
  // maternity: ANC, labour, PNC (PNC includes a birth at home or another facility)
  const ep=await api('POST','episodes',{woman_id:wid,service_category:cat,status:(cat==='labour'?'laboring':'active'),
    provider_id:(ME.role==='provider'?ME.id:null),admission_datetime:localDateTime()});
  if(ep&&ep.id){ location.hash='#patient/'+ep.id; return; }
  location.hash='#'+(cat==='anc'?'antenatal':cat==='pnc'?'pnc':'labour');
}

// ---- Why is she high risk? ---------------------------------------------------
// A flag with no reason is a dead end — the provider had to open her record and guess.
// Each code carries the reason, the action, AND WHERE THE ACTION COMES FROM.
//
// PROVENANCE IS NOT DECORATION. Every one of these conditions is listed as high-risk in the
// National ANC Guideline (MoH, Feb 2022) Table 4 — that part is sourced. But the guideline is
// about ANTENATAL care: for several conditions it names the risk and says nothing about how to
// manage the labour. Earlier versions of this file filled that gap with general obstetric
// practice and presented it in the same voice as the sourced advice. That is not acceptable in
// a tool a provider acts on, so the unsourced instructions have been REMOVED rather than
// dressed up as national protocol. Where the guideline is silent, the tool now says so.
// (See ADHERE+ audit, July 2026.)
// An entry carries an ACTION only where an MoH source actually specifies one. Where the guideline
// names the risk but says nothing about management (it is an ANTENATAL guideline; for several
// conditions it is silent on the birth), the entry carries the reason ALONE. Earlier versions
// filled that silence with general obstetric practice, written in the same confident voice as
// the sourced advice. That has been removed rather than dressed up as national protocol.
const G='National ANC Guideline (MoH, Feb 2022)';
const RISK_INFO={
 AGE_LT19:['Age under 19 — teenage/adolescent pregnancy','',''],
 AGE_GT35:['Age over 35 — advanced maternal age','',''],
 UNPLANNED:['Unplanned or unwanted pregnancy','Counsel and assess her support needs. Screen for mental health problems and intimate-partner violence. Offer postpartum family planning.',G],
 PRIOR_CS:['Previous caesarean section','',''],
 PRIOR_STILLBIRTH:['Previous stillbirth','',''],
 PRIOR_PPH:['Previous postpartum haemorrhage','',''],
 PRIOR_PREECLAMPSIA:['Previous pre-eclampsia or eclampsia','Calcium supplementation. Check blood pressure and urine protein at every contact.',G],
 PRIOR_OBSTRUCTED:['Previous obstructed or prolonged labour','',''],
 CHRONIC_HTN:['Chronic hypertension','Blood pressure at every contact. Calcium supplementation. Watch for superimposed pre-eclampsia.',G],
 DIABETES:['Diabetes mellitus','',''],
 CARDIAC_RENAL:['Cardiac or renal disease','Refer for specialist care. This may be a pregnancy that endangers her life.',G+', Annex 2'],
 RH_NEG:['Rh negative','Anti-D immunoglobulin 300 micrograms at 28 weeks for every Rh-negative, Coombs-negative woman, and again soon after birth if the newborn is Rh positive.',G],
 LATE_ANC:['Late ANC initiation (booked after 12 weeks)','Catch up on the missed ANC package: screening, iron-folic acid, calcium, Td and deworming.',G],
 HIV_POS:['Known HIV positive','Continue ART — do not re-test her. Check the viral load. Ensure PMTCT linkage, and plan infant ARV prophylaxis and DNA/PCR.','MoH PMTCT register'],
 ANAEMIA:['Anaemia on the last contact','Therapeutic iron (60 mg elemental iron). If severe (Hb &lt;7 g/dl): refer to hospital for investigation and possible blood transfusion, and continue therapeutic iron.',G+', §5.2.2'],
 MUAC_LOW:['Acute malnutrition (MUAC <23 cm)','Treat as recommended by the national guideline for the management of acute malnutrition, and counsel on nutrition.',G],
};
function riskReasons(e){
  const codes=[];
  String(e.risk_codes||'').split(',').filter(Boolean).forEach(c=>codes.push(c));
  String(e.screen_codes||'').split(',').filter(Boolean).forEach(c=>{
    const m={OBS_PREV_STILLBIRTH:'PRIOR_STILLBIRTH',OBS_PREV_PPH:'PRIOR_PPH',OBS_PREV_OBSTRUCTED:'PRIOR_OBSTRUCTED',
      OBS_PREV_PREECLAMPSIA:'PRIOR_PREECLAMPSIA',OBS_PREV_CS:'PRIOR_CS',CUR_AGE_LT19:'AGE_LT19',CUR_AGE_GT35:'AGE_GT35',
      CUR_UNPLANNED:'UNPLANNED',MED_CHRONIC_HTN:'CHRONIC_HTN',MED_DIABETES:'DIABETES',MED_CARDIAC_RENAL:'CARDIAC_RENAL',
      MED_RH_SENSITIZED:'RH_NEG',MED_ANAEMIA:'ANAEMIA'}[c];
    if(m) codes.push(m); else codes.push('SCREEN:'+c);
  });
  if(e.anaemia) codes.push('ANAEMIA');
  if(e.muac_low==1) codes.push('MUAC_LOW');
  const seen={}; const out=[];
  codes.forEach(c=>{ if(seen[c]) return; seen[c]=1;
    if(RISK_INFO[c]) out.push({code:c,why:RISK_INFO[c][0],action:RISK_INFO[c][1],src:RISK_INFO[c][2]||''});
    else if(c.startsWith('SCREEN:')){ const it=ANC_ITEMS.find(i=>i[0]===c.slice(7));
      if(it) out.push({code:c,why:it[2],action:'Flagged on the ANC risk screening — review the care plan.',src:'National ANC Guideline (MoH, Feb 2022), Table 4'}); }
  });
  return out;
}
// Clickable "Higher risk" pill that explains itself.
function riskPill(e){
  if(e.high_risk!=1) return '';
  const n=riskReasons(e).length;
  return ` <span class="pill amber riskx" data-ep="${e.id}" style="cursor:pointer" title="Click to see why">Higher risk${n?(' · '+n):''}</span>`;
}
function wireRisk(rows){
  document.querySelectorAll('span.riskx').forEach(s=>{ s.onclick=()=>{
    const e=(rows||[]).find(x=>x.id==s.dataset.ep); if(!e) return;
    const rs=riskReasons(e);
    const name=((e.first_name||'')+' '+(e.father_name||'')).trim()||('Episode '+e.id);
    const body=rs.length
      ? rs.map((r,i)=>`<div style="padding:8px 0;border-bottom:0.5px solid #eee">
           <div style="font-weight:600;color:#791f1f">${i+1}. ${esc(r.why)}</div>
           ${r.action?`<div style="font-size:13px;color:#334155;margin-top:2px"><b>Next:</b> ${r.action}</div>`:''}
           ${r.src?`<div style="font-size:11px;color:#8a9490;margin-top:3px">${esc(r.src)}</div>`:''}</div>`).join('')
      : '<div class="muted">Flagged, but no specific condition is recorded. Complete her ANC risk screening.</div>';
    const old=document.getElementById('mdl'); if(old) old.remove();
    const d=document.createElement('div'); d.id='mdl';
    d.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px';
    d.innerHTML=`<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25);max-height:80vh;overflow:auto">
      <h3 style="margin:0 0 2px;color:#a32d2d;font-size:16px">Why ${esc(name)} is high risk</h3>
      <p class="muted" style="margin:0 0 10px;font-size:12px">MRN ${esc(e.mrn||'')} &middot; ${rs.length} condition(s) &middot; from her record and ANC risk screening</p>
      ${body}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="act" id="mdlok" style="flex:1">Understood</button>
        <a class="sec" href="#anc/${e.id}" style="flex:1;text-align:center;padding:8px;border-radius:8px;text-decoration:none">Open risk screening</a>
      </div></div>`;
    document.body.appendChild(d);
    d.querySelector('#mdlok').onclick=()=>d.remove();
    d.onclick=(ev)=>{ if(ev.target===d) d.remove(); };
  }; });
}

function provOpts(provs,sel){ return '<option value="">— Not assigned —</option>'+(provs||[]).map(p=>`<option value="${p.id}"${sel==p.id?' selected':''}>${esc(p.full_name)}</option>`).join(''); }
function wireAssign(){ document.querySelectorAll('select.asgn').forEach(s=>{ s.onchange=async()=>{ const r=await api('PATCH','episodes/'+s.dataset.ep,{provider_id:+s.value||null}); if(r&&(r.ok||r.queued)) toast('Provider updated','ok'); }; }); }
async function labour(){
  const [rows,provs]=await Promise.all([api('GET','episodes?category=labour').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>Labour ward</h3><table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}${riskPill(r)}${syncPill(r)}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No women in labour. Register one.</td></tr>'}
   </table></div>`;
  wireAssign(); wireRisk(rows);   // the "Higher risk" pill explains itself on click
}

const OB={}; // per-episode in-memory observations for the chart
async function partograph(id){
  const [obs,W]=await Promise.all([api('GET','observations?episode='+id).catch(()=>[]),epOne(id)]);
  // GA now arrives ON the episode row (anc_ga_weeks / anc_ga_date), resolved BY WOMAN by the server.
  // It used to be fetched with `anc_visits?episode=<this episode>` - but her ANC contacts belong to her
  // ANC episode and labour is a DIFFERENT episode, so that always came back EMPTY and this fix never
  // actually fired for any woman who had booked ANC here. motherFeats() advances it to today.
  const MF=motherFeats(W);
  // A delivered — or closed — episode is a finished record. Read-only.
  const st=String(W.status||'').toLowerCase();
  const locked=(st==='delivered'||st==='closed');
  OB[id]=obs.map(o=>({hrs:+o.hours_since_active,cvx:+o.cervix_cm,fhr:+o.fetal_heart_rate,ctx:+o.contractions_per10,mld:+o.moulding,sbp:+o.bp_systolic,tmp:+o.temperature,dsc:(o.descent_head==null?null:+o.descent_head),amn:o.amniotic_fluid}));
  if(!BTS[id]) BTS[id]=new BayesTracker(0.15);
  app().innerHTML=nav()+`<div class="card"><h3>Partograph — episode ${esc(id)} <span id="band" class="pill"></span></h3>${locked?'<div class="pill amber" style="display:inline-block;margin:0 0 8px">Delivered - partograph is read-only</div>':''}
    <div class="grid">
     <label>Hours active<input id="hrs" type="number" step="0.5" placeholder="hours"></label>
     <label>Cervix cm<input id="cvx" type="number" step="0.5" placeholder="0–10"></label>
     <label>Fetal HR<input id="fhr" type="number" placeholder="bpm"></label>
     <label>Contractions/10<input id="ctx" type="number" placeholder="per 10 min"></label>
     <label>Moulding (0–3)<select id="mld"><option value="0">0</option><option value="1">+1</option><option value="2">+2</option><option value="3">+3</option></select></label>
     <label>Caput<select id="cap"><option value="">Not assessed</option><option value="0">0</option><option value="1">+1</option><option value="2">+2</option><option value="3">+3</option></select></label>
     <label>Descent — fifths palpable<input id="dsc" type="number" min="0" max="5" placeholder="5→0 (optional)"></label>
     <label>Amniotic fluid<select id="amn"><option value="">Not assessed</option><option value="I">Intact</option><option value="C">Clear</option><option value="M">Meconium</option><option value="B">Blood</option><option value="A">Absent</option></select></label>
     <label>Systolic BP<input id="sbp" type="number" placeholder="mmHg"></label>
     <label>Diastolic BP<input id="dbp" type="number" placeholder="mmHg"></label>
     <label>Pulse<input id="pls" type="number" placeholder="bpm"></label>
     <label>Temp °C<input id="tmp" type="number" step="0.1" placeholder="°C"></label>
     <label>Urine protein<select id="uprot"><option value="">Not done</option><option value="neg">Neg</option><option value="+">+</option><option value="++">++</option><option value="+++">+++</option></select></label>
     <label>Urine acetone<select id="uacet"><option value="">Not done</option><option value="neg">Neg</option><option value="+">+</option><option value="++">++</option><option value="+++">+++</option></select></label>
    </div><button class="act" id="rec" style="margin-top:10px">Record &amp; score</button>
    <svg id="pg" viewBox="0 0 640 300" width="100%" style="margin-top:10px"></svg>
    <div class="muted" style="font-size:12px">Cervicograph — X = cervical dilatation, O = descent (fifths palpable), with alert &amp; action lines.</div>
    <svg id="pgv" viewBox="0 0 640 220" width="100%" style="margin-top:8px"></svg>
    <div class="muted" style="font-size:12px">Fetal heart rate (normal band 110–160 bpm) and contractions per 10 min.</div>
    <div id="ai" style="display:none;border-top:0.5px solid #eee;padding-top:8px;margin-top:8px">
     <b class="muted">Intrapartum risk (AI)</b> estimate <b id="prob" style="font-size:20px"></b> <span class="muted" id="drv"></span>
     <div class="muted" id="why" style="font-size:12px;margin-top:3px"></div>
     <div id="nbrisk" style="font-size:12px;margin-top:4px;display:none"></div>
     <div class="muted" style="font-size:11px;margin-top:2px">Clinical decision support — an aid to the provider's judgement, not a diagnosis.</div>
     <div style="margin-top:6px"><button class="sec" id="ack">Acknowledge</button><button class="sec" id="ovr">Override</button> <span class="muted" id="hitl"></span></div>
    </div></div>
    <div class="card" id="monsched"></div>
    <div class="card"><b class="muted">Risk trajectory</b><div id="traj"></div></div>
    <div class="card"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div id="gauge"></div>
      <div style="flex:1"><b class="muted">Guideline adherence</b><div id="prompts" class="muted">record an observation to evaluate</div></div></div></div>`;
  drawPG(id); drawVitals(id); renderTraj(id); renderMonSched(id,obs);
  if(locked){ ['hrs','cvx','fhr','ctx','mld','dsc','amn','cap','sbp','tmp','uprot','uacet','rec'].forEach(k=>{const el=$('#'+k); if(el)el.disabled=true;}); const rb=$('#rec'); if(rb){ rb.textContent='Delivered - partograph closed'; rb.className='sec'; } }
  $('#rec').onclick=async()=>{
    if(locked) return;
    // NOTHING IS INVENTED. These fields used to be pre-filled with normal values (FHR 140,
    // BP 118/75, temp 37), so a provider who measured only the cervix and pressed save recorded
    // a fabricated fetal heart rate — which was then plotted on the cervicograph, fed to the AI
    // model, and stored as an observation indistinguishable from a measured one.
    const miss=[];
    if(hrs.value==='') miss.push('hours in active labour');
    if(cvx.value==='') miss.push('cervical dilatation');
    if(fhr.value==='') miss.push('fetal heart rate');
    if(miss.length){ $('#rec').disabled=false;
      modal('Not recorded yet','These have not been measured: <b>'+miss.map(esc).join(', ')+'</b>.<br><br>ADHERE+ will not fill them in for you. The fetal heart rate in particular drives both the cervicograph and the AI score — a value nobody measured is worse than no value at all.');
      return; }
    // These numbers are plotted on the cervicograph AND fed to the AI model. A slip of the finger
    // here does not just look wrong, it changes the score. (FHR 0 is allowed — it means no fetal
    // heart heard, and that is a red flag, not a typo.)
    if(!checkRanges([['hrs','hours_labour'],['cvx','cervix_cm'],['fhr','fetal_heart'],['ctx','contractions'],
                     ['sbp','bp_systolic'],['dbp','bp_diastolic'],['pls','pulse'],['tmp','temperature']])){
      $('#rec').disabled=false; return; }
    const btn=$('#rec'); btn.disabled=true;                         // guard against double-submit
    try{
    const o={hrs:+hrs.value,cvx:+cvx.value,fhr:+fhr.value,ctx:(ctx.value===''?null:+ctx.value),mld:+mld.value,
             sbp:(sbp.value===''?null:+sbp.value),dbp:(dbp.value===''?null:+dbp.value),tmp:(tmp.value===''?null:+tmp.value),
             pls:(pls.value===''?null:+pls.value),
             dsc:(dsc.value===''?null:+dsc.value),amn:(amn.value||null),uprot:(uprot.value||null)};
    const mld3=Math.max(0,Math.min(3,Math.round(o.mld)||0));
    // Save the observation FIRST — a failed save must never show a misleading chart/score.
    const obsRes=await api('POST','observations',{episode_id:+id,obs_datetime:localDateTime(),hours_since_active:o.hrs,cervix_cm:o.cvx,fetal_heart_rate:o.fhr,contractions_per10:o.ctx,moulding:['0','+1','+2','+3'][mld3],caput:(cap.value===''?null:['0','+1','+2','+3'][Math.max(0,Math.min(3,+cap.value||0))]),descent_head:o.dsc,amniotic_fluid:o.amn,bp_systolic:o.sbp,bp_diastolic:o.dbp,pulse:o.pls,temperature:o.tmp,urine_protein:(uprot.value||null),urine_acetone:(uacet.value||null)});
    OB[id].push(o); OB[id].sort((a,b)=>a.hrs-b.hrs); drawPG(id); drawVitals(id); obs.push({obs_datetime:localDateTime()}); renderMonSched(id,obs);
    const mecon=(o.amn==='M')?1:0;
    // THE PRE-ECLAMPSIA CLUSTER NOW REACHES THE MODEL. The danger-signs screen has always
    // collected headache, blurred vision, epigastric pain, clonus and bleeding — and none of
    // them were ever passed to the scorer, which kept them at their zero defaults. A woman with
    // the full imminent-eclampsia picture was scored as symptom-free. Same for urine protein.
    const DS=await api('GET','danger_signs?episode='+id).catch(()=>[]);
    const ds=(DS||[]).slice(-1)[0]||{};
    const up=o.uprot;
    const sym={
      headache:   (ds.headache==='yes'||ds.headache==1)?1:0,
      blurred:    (ds.blurred_vision==='yes'||ds.blurred_vision==1)?1:0,
      epigastric: (ds.epigastric_pain==='yes'||ds.epigastric_pain==1)?1:0,
      clonus:     (String(ds.dtr_grade||'').match(/3|4|clonus/i))?1:0,
      bleeding:   (ds.vaginal_bleeding==='yes'||ds.vaginal_bleeding==1)?1:0,
      urine_prot: (up==='+'?1:(up==='++'?2:(up==='+++'?3:0)))
    };
    // dbp is MEASURED, never fabricated. It used to be invented as sbp*0.65, which silently
    // disabled the DBP>=110 severe-hypertension red flag: a woman at 150/115 was graded amber.
    // Anything genuinely NOT MEASURED is left out entirely, so the model falls back to its own
    // trained defaults rather than being handed a number nobody took.
    // PULSE and ROM_HOURS were two more features the model consumed and the tool never supplied —
    // the same defect as prior_cs. Pulse is now measured (the database and API always accepted it;
    // only the form never asked). ROM hours is DERIVED from the rupture time already recorded on
    // the episode, rather than invented. Prolonged rupture is the main driver of intrapartum sepsis.
    const romH=romHrs(W.ruptured_datetime);
    // cvx_rate is cervical dilatation PROGRESS — it needs at least one prior point to exist. On the
    // FIRST observation (hrs===0) nothing whatever is known about progress, so it was handed the
    // model a fabricated 1.0 cm/h (reassuring, above-normal). cvx_rate is the model's #2 feature.
    // Leave it UNSET at admission so the model applies its trained default rather than a made-up rate.
    const cvxRate = o.hrs>0 ? (o.cvx-4)/o.hrs : null;
    const feat=Object.assign({},FEAT_DEFAULTS,MF,sym,{hrs:o.hrs,cvx:o.cvx,cvx_rate:cvxRate,fhr:o.fhr,
      ctx:o.ctx,mld:mld3,meconium:mecon,sbp:o.sbp,dbp:o.dbp,pulse:o.pls,temp:o.tmp,rom_hours:romH});
    Object.keys(feat).forEach(k=>{ if(feat[k]==null||Number.isNaN(feat[k])) delete feat[k]; });
    const r=RM?RM.predict(feat):{probability:0,band:'green'};
    const cf=clinicalFlags(o); const finalBand=escalate(r.band,cf.band);   // safety guardrail
    $('#ai').style.display='block'; $('#prob').textContent=Math.round(r.probability*100)+'%'; $('#prob').className=finalBand;
    const bd=$('#band'); bd.textContent=finalBand.toUpperCase()+(finalBand!==r.band?' (clinical override)':''); bd.className='pill '+finalBand;
    $('#drv').textContent=(cf.reasons.length?('red-flags: '+cf.reasons.join(', ')):'AI band '+r.band);
    const drv=riskDrivers(o,feat); $('#why').innerHTML=drv.length?('<b>Contributing findings:</b> '+drv.map(esc).join(' &middot; ')):'No abnormal intrapartum findings detected.';
    // Newborn — readiness for resuscitation, from the intrapartum picture
    if(NRM){ const nbf={ga:feat.ga,meconium:mecon,fhr:o.fhr,mld:mld3,cvx:o.cvx,hrs:o.hrs,ctx:o.ctx,sbp:o.sbp,temp:o.tmp,prior_cs:feat.prior_cs,age:feat.age,parity:feat.parity,rom_hours:feat.rom_hours};
      Object.keys(nbf).forEach(k=>{ if(nbf[k]==null||Number.isNaN(nbf[k])) delete nbf[k]; });   // never hand the model a value nobody measured
      const nb=NRM.predict(nbf);
      const nel=$('#nbrisk'); nel.style.display='block';
      const nmsg=nb.band==='green'?'low — routine newborn care':(nb.band==='amber'?'elevated — have bag-mask ready, call for help':'high — prepare resuscitation now (bag-mask, skilled attendant)');
      nel.innerHTML='<b>Newborn readiness</b> <span class="pill '+nb.band+'">'+Math.round(nb.probability*100)+'%</span> '+esc(nmsg); }
    let scored=true;   // the observation is already saved; the AI score is advisory and must not claim otherwise
    try{
      const sc=await api('POST','risk_scores',{episode_id:+id,model_version:MODEL&&MODEL.version,probability:r.probability.toFixed(4),band:finalBand,features_json:Object.assign({ml_band:r.band,clinical:cf.reasons},feat)});
      lastScoreId[id]=sc&&sc.id; lastAI[id]={p:r.probability,band:finalBand};
      // Module 3 — Bayesian update from findings
      const f=[]; if(feat.cvx_rate<0.7)f.push('slow_progress'); if(mld3>=2)f.push('moulding_ge2');
      if(o.fhr<110||o.fhr>170)f.push('fhr_abnormal'); if(o.sbp>=160)f.push('bp_ge160'); else if(o.sbp>=140)f.push('bp_ge140');
      if(o.tmp>=38)f.push('fever_ge38');
      if(!BTapplied[id])BTapplied[id]=new Set(); const nf=f.filter(x=>!BTapplied[id].has(x)); nf.forEach(x=>BTapplied[id].add(x)); const bx=BTS[id].update(nf,'h'+o.hrs); renderTraj(id);
      await api('POST','risk_scores',{episode_id:+id,model_version:'bayes-longitudinal-1.0',probability:bx.probability.toFixed(4),band:bx.band,features_json:{findings:f}});
    }catch(scoreErr){ scored=false; }
    // Module 2 — adherence for this labour encounter
    renderAdh(id,{encounter:'labour',cervix_cm:o.cvx,fhr:o.fhr,bp:o.sbp,contractions:o.ctx,partograph_started:true,past_action_line:(o.hrs>4&&o.cvx<o.hrs)});
    // Clear the hours box after a save — do NOT pre-fill previous+1. The monitoring schedule this
    // screen renders demands readings every 30 min, so previous+1 records the next reading an hour
    // ahead of reality, corrupting both hrs and the derived cvx_rate. The provider enters the actual
    // hours in active labour each time.
    $('#hitl').textContent=''; $('#hrs').value='';
    toast(scored?('Observation recorded'+(obsRes&&obsRes.queued?' (offline — will sync when online)':'')):'Observation saved. (The AI risk score could not be stored, but the reading is recorded.)', scored?'ok':'');
    }catch(err){ toast('Could not record the observation — '+(err.message||'error')+'. Nothing was saved.'); }
    finally{ $('#rec').disabled=false; }
  };
  $('#ack').onclick=async()=>{ if(lastScoreId[id]){ try{ await api('PATCH','risk_scores/'+lastScoreId[id]); $('#hitl').textContent='acknowledged (saved)'; }catch(e){ $('#hitl').textContent='acknowledged (queued)'; } } else $('#hitl').textContent='record a score first'; };
  $('#ovr').onclick=async()=>{ const la=lastAI[id]||{p:0,band:'green'}; await api('POST','risk_scores',{episode_id:+id,model_version:'override',probability:la.p.toFixed(4),band:la.band,override_reason:'clinician judgement',provider_ack:1}); $('#hitl').textContent='override logged'; };
}
function renderMonSched(id,obs){ const el=$('#monsched'); if(!el) return;
  const last=(obs&&obs.length)?obs[obs.length-1]:null;
  // parseLocal, not new Date(): the stored value is CLINIC wall-clock. Parsing it against the
  // device's zone is what made a just-saved observation read as hours old.
  const lt=last?parseLocal(last.obs_datetime||last.recorded_at||''):null;
  if(!lt||isNaN(lt.getTime())){ el.innerHTML='<b class="muted">Monitoring schedule</b><div class="muted" style="font-size:12px">Record the first reading to start the schedule.</div>'; return; }
  const mins=Math.max(0,Math.round((Date.now()-lt.getTime())/60000));
  const sched=[['Fetal heart rate',30],['Contractions',30],['Pulse',30],['Temperature',120],['Blood pressure',240],['Cervix / descent',240]];
  const rows=sched.map(function(s){ const over=mins-s[1]; const st=over>=0?('<span class="pill red">due now'+(over>0?(' (overdue '+over+'m)'):'')+'</span>'):('<span class="pill green">in '+(-over)+'m</span>'); return '<tr><td>'+esc(s[0])+'</td><td>every '+s[1]+'m</td><td>'+st+'</td></tr>'; }).join('');
  const win=mins<30?'30-minute':(mins<120?'2-hour':(mins<240?'4-hour':'overdue &mdash; escalate'));
  el.innerHTML='<b class="muted">Monitoring schedule</b> <span class="muted" style="font-size:12px">&mdash; '+mins+' min since last reading &middot; '+win+' assessment window (classic WHO partograph)</span><table style="margin-top:6px"><tr><th>Parameter</th><th>Frequency</th><th>Status</th></tr>'+rows+'</table>';
}
function renderTraj(id){ const h=(BTS[id]&&BTS[id].history)||[]; if(!h.length){ $('#traj').innerHTML='<span class="muted">no visits scored yet</span>'; return; }
  const series=h.map(p=>({x:p.at,y:p.probability,lo:p.ci[0],hi:p.ci[1]}));
  $('#traj').innerHTML=Charts.line(series,{yMax:1,pct:true,zones:true,band:true,stroke:'#26215c'}); }
function renderAdh(id,enc){ if(!RE){return;} const r=RE.evaluate(enc);
  $('#gauge').innerHTML=Charts.gauge(r.adherence,{label:'adherence'});
  $('#prompts').innerHTML = r.prompts.length? r.prompts.map(p=>`<div style="padding:3px 0"><span class="pill ${p.sev==='high'?'red':p.sev==='med'?'amber':'green'}">${p.sev}</span> ${p.msg}</div>`).join('') : '<span style="color:#0f6e56">all applicable steps recorded</span>'; }

// Minimal CSV parser (first row = lowercased headers). Assumes no quoted commas.
function parseCSV(text){ const lines=String(text).replace(/\r/g,'').split('\n').filter(l=>l.trim()!==''); if(!lines.length) return []; const head=lines[0].split(',').map(h=>h.trim().toLowerCase()); return lines.slice(1).map(l=>{ const c=l.split(','); const o={}; head.forEach((h,i)=>o[h]=(c[i]||'').trim()); return o; }); }

async function facilities(){
  if(!ADMIN()){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const list=await api('GET','facilities').catch(()=>[]);
  // The ESTATE is a super-admin's business. A facility administrator has no reason to create,
  // rename or delete the health centre next door; the server refuses it, and offering a form that
  // can only fail is worse than not offering it.
  const canEdit=SUPER();
  app().innerHTML=nav()+(canEdit?`<div class="card"><h3>Add a facility</h3>
    <div class="grid">
     <label>Name<input id="fnm" placeholder="Debre Tabor Health Center"></label>
     <label>Type<select id="fty"><option value="health_center">Health center</option><option value="primary_hospital">Primary hospital</option><option value="general_hospital">General hospital</option><option value="other">Other</option></select></label>
     <label>Kebele<input id="fke"></label><label>Woreda<input id="fwo"></label>
     <label>Zone<input id="fzo"></label><label>Region<input id="fre" value="Amhara"></label>
     <label>DHIS2 org-unit code<input id="fdh" placeholder="optional"></label>
    </div><button class="act" id="fadd" style="margin-top:10px">Create facility</button> <span class="muted" id="fm"></span></div>
    <div class="card"><h3>Bulk add facilities (CSV)</h3>
     <p class="muted">Columns (first row = headers): <code>name, facility_type, kebele, woreda, zone, region, dhis2_org_unit</code>. facility_type = health_center / primary_hospital / general_hospital / other.</p>
     <input type="file" id="fcsv" accept=".csv,text/csv"> <button class="sec" id="fcsvbtn">Upload CSV</button> <span class="muted" id="fcsvm"></span></div>`
    :`<div class="card"><p class="muted">Facilities are managed centrally. You can see the list below; creating or changing a facility is a super-admin action.</p></div>`)+`
    <div class="card"><h3>Facilities</h3><table><tr><th>ID</th><th>Name</th><th>Type</th><th>Woreda</th><th>Zone</th><th>Region</th><th>DHIS2</th><th></th></tr>
     ${list.map(f=>`<tr><td>${f.id}</td><td>${esc(f.name)}</td><td>${esc(f.facility_type||'')}</td>
       <td>${esc(f.woreda||'')}</td><td>${esc(f.zone||'')}</td><td>${esc(f.region||'')}</td><td>${esc(f.dhis2_org_unit||'')}</td><td>${canEdit?`<a class="nav" href="#facilityedit/${f.id}">Edit</a> <button class="sec" data-del="${f.id}" data-nm="${esc(f.name)}">Delete</button>`:'<span class="muted">—</span>'}</td></tr>`).join('')}
     </table><p class="muted">Each user and every patient belongs to a facility. Data is scoped per facility, and the dashboard/DHIS2 export roll up by facility.</p></div>`;
  if(!canEdit) return;                                  // read-only for a facility admin
  $('#fadd').onclick=async()=>{ const r=await api('POST','facilities',{name:fnm.value,facility_type:fty.value,kebele:fke.value,woreda:fwo.value,zone:fzo.value,region:fre.value,dhis2_org_unit:fdh.value}); if(r.id){ facilities(); } else $('#fm').textContent=' '+(r.error||'error'); };
  $('#fcsvbtn').onclick=async()=>{ const fl=$('#fcsv').files[0]; if(!fl){ $('#fcsvm').textContent=' choose a CSV file first'; return; } const rows=parseCSV(await fl.text()).filter(r=>r.name); if(!rows.length){ $('#fcsvm').textContent=' no rows with a name found'; return; } $('#fcsvm').textContent=' uploading '+rows.length+'…'; try{ const r=await api('POST','facilities',rows); const n=(r.created||[]).length, e=(r.errors||[]).length; $('#fcsvm').textContent=' added '+n+(e?(', '+e+' skipped'):''); setTimeout(()=>facilities(),1000); }catch(err){ $('#fcsvm').textContent=' '+(err.message||'error'); } };
  document.querySelectorAll('#app button[data-del]').forEach(b=>b.onclick=async()=>{ if(confirm('Delete facility "'+b.dataset.nm+'"? This only works if it has no users or patients.')){ const r=await api('DELETE','facilities/'+b.dataset.del); if(r&&r.ok){ facilities(); } else alert((r&&r.error)||'error'); } });
}

// ---- REMOVED RECORDS — the admin's review screen -------------------------------------------
// Everything that has been voided, who did it and why, with a way to put it back. And, separately,
// the notices raised when a PROVIDER removed something: a provider deleting a patient record is
// exactly what a supervisor should be told about, without blocking them from doing it.
async function voidedScreen(){
  if(!ADMIN()){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const [v,notices]=await Promise.all([
    api('GET','voided').catch(()=>({women:[],episodes:[]})),
    api('GET','void_notices').catch(()=>[])
  ]);
  const women=(v&&v.women)||[], episodes=(v&&v.episodes)||[];
  const unack=(notices||[]).filter(n=>n.acknowledged!=1);
  const who=r=>esc((r.voided_by_name||'')+(r.voided_by_role?(' ('+r.voided_by_role+')'):''));
  const when=r=>esc(String(r.voided_at||'').slice(0,16));

  app().innerHTML=nav()+`
   ${unack.length?`<div class="card" style="border-left:4px solid #a32d2d">
     <h3>${unack.length} record${unack.length===1?'':'s'} removed by a provider</h3>
     <p class="muted">A provider removed these. Check that each was right, then acknowledge it.</p>
     <table><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th><th></th></tr>
     ${unack.map(n=>`<tr><td>${esc(String(n.voided_at||'').slice(0,16))}</td><td>${esc(n.by_name||'')}</td>
        <td>${esc(n.entity)} &mdash; ${esc(n.label||'')}</td><td>${esc(n.reason||'')}</td>
        <td><button class="sm" data-ack="${n.id}">Acknowledge</button></td></tr>`).join('')}
     </table></div>`:''}

   <div class="card"><h3>Removed patients</h3>
    <p class="muted">Their records are kept in full. They appear on no worklist, register, count or export. Restoring puts everything back exactly as it was.</p>
    <table><tr><th>MRN</th><th>Name</th><th>Removed</th><th>By</th><th>Reason</th><th></th></tr>
    ${women.map(w=>`<tr><td>${esc(w.mrn||'')}</td><td>${esc(((w.first_name||'')+' '+(w.father_name||'')).trim())}</td>
      <td>${when(w)}</td><td>${who(w)}</td><td>${esc(w.void_reason||'')}</td>
      <td><button class="sm" data-restore="woman" data-id="${w.id}">Restore</button></td></tr>`).join('')
      ||'<tr><td colspan=6 class=muted>No patient records have been removed.</td></tr>'}
    </table></div>

   <div class="card"><h3>Removed episodes</h3>
    <p class="muted">The patient is still on file &mdash; only this episode of care was removed.</p>
    <table><tr><th>MRN</th><th>Name</th><th>Episode</th><th>Removed</th><th>By</th><th>Reason</th><th></th></tr>
    ${episodes.map(e=>`<tr><td>${esc(e.mrn||'')}</td><td>${esc(((e.first_name||'')+' '+(e.father_name||'')).trim())}</td>
      <td>${esc(e.service_category||'')} &middot; ${esc(e.status||'')}</td>
      <td>${when(e)}</td><td>${who(e)}</td><td>${esc(e.void_reason||'')}</td>
      <td><button class="sm" data-restore="episode" data-id="${e.id}">Restore</button></td></tr>`).join('')
      ||'<tr><td colspan=7 class=muted>No episodes have been removed.</td></tr>'}
    </table></div>`;

  document.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    const r=await api('POST','unvoid',{entity:b.dataset.restore, id:+b.dataset.id}).catch(e=>({error:e.message}));
    if(r&&r.ok){ toast('Restored','ok'); voidedScreen(); } else { b.disabled=false; toast((r&&r.error)||'Could not restore it'); }
  });
  document.querySelectorAll('[data-ack]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    const r=await api('POST','void_notices/'+b.dataset.ack,{}).catch(()=>null);
    if(r&&r.ok) voidedScreen(); else b.disabled=false;
  });
}

async function users(){
  if(!ADMIN()){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const [list,facs]=await Promise.all([api('GET','users').catch(()=>[]),api('GET','facilities').catch(()=>[])]);
  const facName=id=>{ const f=facs.find(x=>x.id==id); return f?f.name:(id||'—'); };
  app().innerHTML=nav()+`<div class="card"><h3>Add a user</h3>
    <div class="grid">
     <label>Username<input id="nu"></label><label>Full name<input id="nn"></label>
     <label>Password<input id="np" type="text"></label>
     <label>Role<select id="nr"><option value="recorder">Recorder</option><option value="provider">Provider</option><option value="observer">Observer</option><option value="supervisor">Supervisor</option><option value="admin">Admin (this facility)</option>${SUPER()?'<option value="super_admin">Super-admin (all facilities)</option>':''}</select></label>
     ${SUPER()
       ? `<label>Facility<select id="nf">${facs.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>`
       : `<label>Facility<input value="${esc(String(facName(ME.facility_id)))}" disabled>
            <span class="muted" style="font-size:11px">You can only create users at your own facility.</span></label>`}
     <label id="nsWrap" style="display:none">Supervisor scope<select id="ns"><option value="facility">This facility</option><option value="woreda">Woreda</option><option value="zone">Zone</option><option value="region">Region</option></select></label>
     <label>Cadre<input id="nc" placeholder="midwife / health officer / IESO"></label>
    </div><button class="act" id="add" style="margin-top:10px">Create user</button> <span class="muted" id="m"></span>
    <p class="muted" style="font-size:12px">Supervisor scope only applies to the Supervisor role — it sets how wide their cross-facility dashboard reads (their base facility's woreda/zone/region).</p>
    ${facs.length?'':'<p class="muted">No facilities yet — add one on the Facilities screen first.</p>'}</div>
    <div class="card"><h3>Bulk add users (CSV)</h3>
     <p class="muted">Columns (first row = headers): <code>username, full_name, password, role, cadre, facility, scope</code>. facility = exact facility name; scope (supervisors) = facility/woreda/zone/region.</p>
     <input type="file" id="ucsv" accept=".csv,text/csv"> <button class="sec" id="ucsvbtn">Upload CSV</button> <span class="muted" id="ucsvm"></span></div>
    <div class="card"><h3>Users</h3><table><tr><th>Username</th><th>Name</th><th>Role</th><th>Facility</th><th>Scope</th><th>Active</th><th>Actions</th></tr>
     ${list.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td>
       <td>${esc(String(facName(u.facility_id)))}</td><td>${esc(u.role==='supervisor'?(u.scope||'facility'):'—')}</td>
       <td>${u.is_active==1?'<span style="color:#0f6e56">yes</span>':'<span style="color:#a32d2d">no</span>'}</td>
       <td><button class="sec" data-act="toggle" data-id="${u.id}" data-a="${u.is_active}">${u.is_active==1?'Deactivate':'Activate'}</button>
           <button class="sec" data-act="pw" data-id="${u.id}">Reset password</button></td></tr>`).join('')}
     </table><p class="muted">Deactivating disables login but keeps the audit trail (safer than deleting).</p></div>`;
  const _rs=$('#nr'), _sw=$('#nsWrap'); const _tgl=()=>{ if(_sw) _sw.style.display=(_rs.value==='supervisor')?'':'none'; }; if(_rs){ _rs.onchange=_tgl; _tgl(); }
  $('#add').onclick=async()=>{ try{ const r=await api('POST','users',{username:nu.value,full_name:nn.value,password:np.value,role:nr.value,cadre:nc.value,scope:document.getElementById('ns')?ns.value:'facility',facility_id:document.getElementById('nf')?nf.value:null}); if(r.id){ users(); } else $('#m').textContent=' '+(r.error||'error'); }catch(e){ $('#m').textContent=' '+(e.message||'error'); } };
  $('#ucsvbtn').onclick=async()=>{ const fl=$('#ucsv').files[0]; if(!fl){ $('#ucsvm').textContent=' choose a CSV file first'; return; }
    let rows=parseCSV(await fl.text()).filter(r=>r.username&&r.password&&r.role);
    if(!rows.length){ $('#ucsvm').textContent=' no valid rows (need username, password, role)'; return; }
    const bad=[], good=[];
    rows.forEach(r=>{ const fn=String(r.facility||'').trim(); const f=fn?facs.find(x=>String(x.name).toLowerCase()===fn.toLowerCase()):null;
      if(fn && !f){ bad.push(r.username+' → "'+fn+'"'); return; }   // named a facility that doesn't exist: skip, don't silently reassign
      good.push({username:r.username,full_name:r.full_name,password:r.password,role:r.role,cadre:r.cadre,scope:r.scope||'facility',facility_id:f?f.id:null}); });
    if(!good.length){ $('#ucsvm').textContent=' nothing uploaded — unknown facility for: '+bad.join(', '); return; }
    $('#ucsvm').textContent=' uploading '+good.length+'…';
    try{ const r=await api('POST','users',good); const n=(r.created||[]).length,e=(r.errors||[]).length; $('#ucsvm').textContent=' added '+n+(e?(', '+e+' rejected'):'')+(bad.length?(', '+bad.length+' skipped (unknown facility)'):''); setTimeout(()=>users(),1200); }catch(err){ $('#ucsvm').textContent=' '+(err.message||'error'); } };
  document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{ const id=b.dataset.id;
    if(b.dataset.act==='toggle'){ await api('PATCH','users/'+id,{is_active:b.dataset.a=='1'?0:1}); users(); }
    else { const pw=prompt('New password for this user:'); if(pw){ await api('PATCH','users/'+id,{password:pw}); alert('Password reset.'); } } });
}

// ---- Themed facility overview ------------------------------------------------
// Answers: how many were high risk, what happened to them, how they delivered,
// and whether the process of care was actually followed.
const LBL={svd:'SVD',caesarean:'Caesarean',assisted:'Assisted (vacuum/forceps)',other:'Other',
 live_birth:'Live birth',fresh_stillbirth:'Fresh stillbirth',macerated_stillbirth:'Macerated stillbirth',neonatal_death:'Died after birth',
 stable:'Stable',unstable_referred:'Unstable — referred',died:'Died',
 POP:'POP',Imp:'Implant',IUCD:'IUCD',TL:'Tubal ligation',Oth:'Other'};
function ovBar(obj,goodKeys){
  const tot=Object.values(obj||{}).reduce((a,b)=>a+b,0);
  if(!tot) return '<p class="muted" style="font-size:12px">Nothing recorded yet.</p>';
  const col=k=>(goodKeys&&goodKeys.indexOf(k)>-1)?'#1d9e75':(/still|died|death|unstable/.test(k)?'#a32d2d':'#0f766e');
  return Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{
    const p=Math.round(100*v/tot);
    return `<div style="margin:5px 0">
      <div style="display:flex;justify-content:space-between;font-size:12px"><span>${esc(LBL[k]||k)}</span><span><b>${v}</b> · ${p}%</span></div>
      <div style="background:#eef2f1;border-radius:5px;height:7px;overflow:hidden"><div style="width:${p}%;height:100%;background:${col(k)}"></div></div>
    </div>`; }).join('');
}
function ovStat(v,l,sub){ return `<div style="background:#f5f9f8;border-radius:10px;padding:10px 12px">
  <div style="font-size:22px;font-weight:600;color:#0b3d3a">${v}</div>
  <div style="font-size:12px;color:#5b6663">${esc(l)}</div>${sub?`<div style="font-size:11px;color:#888">${esc(sub)}</div>`:''}</div>`; }

async function overviewSection(){
  const days=window._ovDays||0;
  let o; try{ o=await api('GET','overview'+(days?('?days='+days):'')); }catch(e){ return '<div class="card">Could not load overview: '+esc(e.message||'error')+'</div>'; }
  window._ov=o;
  const c=o.caseload||{}, pr=o.process||{}, nb=o.newborn_care||{}, cx=o.complications||{};
  const fp=o.fp||{}, im=o.immunization||{}, pt=o.pregnancy_test||{}, pm=o.pmtct||{};
  const pct=(a,b)=>b?Math.round(100*a/b)+'%':'—';
  const hrPct=c.total?Math.round(100*c.high_risk/c.total):0;
  return `<div class="card">
    <h3>Facility overview</h3>
    <p class="muted">Period: <select id="ovp" style="width:auto;display:inline-block">
      <option value="0"${days===0?' selected':''}>All time</option>
      <option value="30"${days===30?' selected':''}>Last 30 days</option>
      <option value="90"${days===90?' selected':''}>Last 90 days</option>
      <option value="365"${days===365?' selected':''}>Last 12 months</option></select>
      &nbsp; <button class="sec" id="ovcsv" style="padding:4px 10px;font-size:12px">Download CSV</button>
      <button class="sec" id="ovprint" style="padding:4px 10px;font-size:12px">Print</button></p>

    <h4>Caseload</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(c.anc||0,'ANC')}${ovStat(c.labour||0,'Labour')}${ovStat(c.deliveries||0,'Deliveries')}${ovStat(c.pnc||0,'PNC')}
      ${ovStat((c.high_risk||0)+' · '+hrPct+'%','High risk','of all episodes')}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:14px">
      <div><h4>Mode of delivery</h4>${ovBar(o.mode_of_delivery)}</div>
      <div><h4>Birth outcome</h4>${ovBar(o.birth_outcome,['live_birth'])}</div>
      <div><h4>Maternal outcome</h4>${ovBar(o.maternal_outcome,['stable'])}</div>
      <div><h4>Immediate postpartum FP</h4>${ovBar(o.ippfp)}</div>
    </div>

    <h4 style="margin-top:14px">Obstetric complications</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      ${ovStat(cx.pre_eclampsia||0,'Pre-eclampsia')}${ovStat(cx.eclampsia||0,'Eclampsia')}${ovStat(cx.aph||0,'APH')}${ovStat(cx.pph||0,'PPH')}${ovStat(cx.other||0,'Other')}
    </div>

    <h4 style="margin-top:14px">Process of care</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(pct(pr.partograph_used||0,c.deliveries||0),'Partograph used',(pr.partograph_used||0)+' of '+(c.deliveries||0))}
      ${ovStat(pct(pr.amtsl||0,c.deliveries||0),'AMTSL',(pr.amtsl||0)+' of '+(c.deliveries||0))}
      ${ovStat(pct(pr.checklist||0,c.labour||0),'Safe-birth checklist',(pr.checklist||0)+' of '+(c.labour||0))}
      ${ovStat(pr.referred||0,'Referred')}
      ${ovStat(pr.red_alerts||0,'Red AI alerts')}
    </div>

    <h4 style="margin-top:14px">Newborn care</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      ${ovStat(nb.lbw||0,'Low birth weight')}
      ${ovStat(pct(nb.kmc||0,nb.lbw||0),'KMC initiated',(nb.kmc||0)+' of '+(nb.lbw||0)+' LBW')}
      ${ovStat(nb.phototherapy||0,'Phototherapy')}
      ${ovStat(nb.nicu||0,'NICU / referred')}
      ${ovStat(nb.low_apgar||0,'APGAR <7 at 5 min')}
      ${ovStat(pct(nb.dbs_sent||0,nb.hiv_exposed||0),'DBS sent',(nb.dbs_sent||0)+' of '+(nb.hiv_exposed||0)+' exposed')}
    </div>

    <h4 style="margin-top:14px">Pregnancy test &mdash; the front door</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(pt.tested||0,'Women tested')}
      ${ovStat(pct(pt.positive||0,pt.tested||0),'HCG positive',(pt.positive||0)+' of '+(pt.tested||0))}
      ${ovStat(pct(pt.linked_anc||0,pt.positive||0),'Positive → ANC',(pt.linked_anc||0)+' of '+(pt.positive||0)+' positive')}
      ${ovStat(pct(pt.negative_to_fp||0,pt.negative||0),'Negative → FP',(pt.negative_to_fp||0)+' of '+(pt.negative||0)+' negative')}
    </div>
    <p class="muted" style="font-size:12px;margin-top:4px">A negative test is the highest-yield moment to offer contraception. <b>Negative → FP</b> is the share of those women who left with a family-planning record rather than nothing.</p>

    <h4 style="margin-top:14px">Family planning</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(fp.clients||0,'FP clients')}
      ${ovStat(fp.new_acceptor||0,'New acceptors')}
      ${ovStat(fp.repeat_acceptor||0,'Repeat acceptors')}
      ${ovStat(fp.lafp_removals||0,'LAFP removals')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:10px">
      <div><h4>Method mix</h4>${ovBar(o.fp_methods)}</div>
      <div><h4>Reason for LAFP removal</h4>${ovBar(o.lafp_reasons)}</div>
    </div>

    <h4 style="margin-top:14px">PMTCT &mdash; the cascade</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(pm.mothers||0,'Mothers enrolled')}
      ${ovStat(pct(pm.on_art||0,pm.mothers||0),'On ART',(pm.on_art||0)+' of '+(pm.mothers||0))}
      ${ovStat(pct(pm.vl_done||0,pm.on_art||0),'Viral load done',(pm.vl_done||0)+' of '+(pm.on_art||0)+' on ART')}
      ${ovStat(pct(pm.vl_suppressed||0,pm.vl_done||0),'Suppressed',(pm.vl_suppressed||0)+' of '+(pm.vl_done||0)+' tested')}
      ${ovStat(pm.vl_detectable||0,'Detectable','needs action')}
      ${ovStat(pm.ltf||0,'Lost to follow-up')}
    </div>
    <h4 style="margin-top:10px">PMTCT &mdash; the exposed infant</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(pm.infants||0,'Exposed infants')}
      ${ovStat(pct(pm.infant_arv||0,pm.infants||0),'ARV prophylaxis',(pm.infant_arv||0)+' of '+(pm.infants||0))}
      ${ovStat(pct(pm.pcr_done||0,pm.infants||0),'DNA/PCR done',(pm.pcr_done||0)+' of '+(pm.infants||0))}
      ${ovStat(pct(pm.pcr_by_8wk||0,pm.pcr_done||0),'Tested by 8 weeks',(pm.pcr_by_8wk||0)+' of '+(pm.pcr_done||0)+' tested')}
      ${ovStat(pct(pm.pcr_positive||0,pm.pcr_done||0),'PCR positive',(pm.pcr_positive||0)+' of '+(pm.pcr_done||0)+' tested')}
      ${ovStat(pm.discharged_neg||0,'Discharged negative')}
      ${ovStat(pm.infant_positive||0,'Infants HIV positive','transmissions')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:10px">
      <div><h4>How she entered PMTCT</h4>${ovBar(o.pmtct_entry)}</div>
      <div><h4>Infant feeding option</h4>${ovBar(o.pmtct_feeding,['EBF','ERF'])}</div>
    </div>
    <p class="muted" style="font-size:12px;margin-top:4px"><b>Tested by 8 weeks</b> is the one that matters: the DNA/PCR is due at 6 weeks, and every week of delay is a week an infected infant spends untreated. <b>PCR positive</b> is transmission that already happened &mdash; it is the number this whole module exists to drive to zero.</p>

    <h4 style="margin-top:14px">Immunization</h4>
    <div class="hubgrid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      ${ovStat(im.td_clients||0,'Td clients')}
      ${ovStat(pct(im.td2_plus||0,im.td_clients||0),'Td2+ protected',(im.td2_plus||0)+' of '+(im.td_clients||0))}
      ${ovStat(im.td_pregnant||0,'Td — pregnant')}
      ${ovStat(im.hpv_girls||0,'HPV girls')}
      ${ovStat(pct(im.hpv_complete||0,im.hpv_girls||0),'HPV complete',(im.hpv_complete||0)+' of '+(im.hpv_girls||0))}
    </div>
    <p class="muted" style="font-size:12px;margin-top:4px">Td-2 is the minimum that protects a newborn against tetanus (80% protection; Td-3 gives 95%).</p>
  </div>`;
}
function wireOverview(){
  const p=$('#ovp'); if(p) p.onchange=()=>{ window._ovDays=+p.value; dashboard(); };
  const pr=$('#ovprint'); if(pr) pr.onclick=()=>window.print();
  const cs=$('#ovcsv'); if(cs) cs.onclick=()=>{
    const o=window._ov||{}; const lines=[['Theme','Item','Value']];
    const push=(t,obj)=>Object.entries(obj||{}).forEach(([k,v])=>lines.push([t,LBL[k]||k,v]));
    push('Caseload',o.caseload); push('Mode of delivery',o.mode_of_delivery); push('Birth outcome',o.birth_outcome);
    push('Maternal outcome',o.maternal_outcome); push('Complications',o.complications); push('Process of care',o.process);
    push('IPPFP',o.ippfp); push('Newborn care',o.newborn_care);
    // the whole MCH continuum, not just the maternity half
    push('Pregnancy test',o.pregnancy_test); push('Family planning',o.fp); push('FP method mix',o.fp_methods);
    push('LAFP removal reason',o.lafp_reasons);
    push('PMTCT',o.pmtct); push('PMTCT entry point',o.pmtct_entry); push('PMTCT infant feeding',o.pmtct_feeding);
    push('Immunization',o.immunization);
    const csv=lines.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\n');
    const bl=new Blob([csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(bl); a.download='adhere_overview_'+(localDate())+'.csv'; a.click(); };
}

async function dashboard(){
  let d; try{ d=await api('GET','analytics'); }catch(e){ app().innerHTML=nav()+'<div class="card">Could not load dashboard: '+esc(e.message||'error')+'</div>'; return; }
  const ovHtml=await overviewSection();
  const I=d.indicators||{}; const g=k=>(I[k]||[]);
  const MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mo=(d.months||[]).map(m=>MN[(+String(m).slice(5))-1]||String(m).slice(5));
  const last=mo.length-1;
  const rateS=(num,den,scale=100)=>g(num).map((x,i)=>{const dd=g(den)[i]; return (dd>0)?Math.round(scale*(x||0)/dd):null;});
  const pgRate=rateS('partographs','labour'), ckRate=rateS('checklists','deliveries'), amRate=rateS('amtsl','deliveries'), pncRate=rateS('pnc','deliveries');
  const sbRate=g('births').map((b,i)=> b>0?Math.round(1000*(g('stillbirths')[i]||0)/b):null);
  // baseline-aware flag: needs >=4 points and >=3 non-zero prior months, then +/-2 SD (suppresses the cold-start roll-up)
  const anom=(series,bad)=>{ const v=series.filter(x=>x!=null); if(v.length<4) return null; const prior=v.slice(0,-1), lv=v[v.length-1]; if(prior.filter(x=>x>0).length<3) return null; const m=prior.reduce((a,b)=>a+b,0)/prior.length; const sd=Math.sqrt(prior.reduce((a,b)=>a+(b-m)*(b-m),0)/prior.length); if(sd<=0) return null; if(lv>m+2*sd) return {dir:'▲',bad:(bad==='up')}; if(lv<m-2*sd) return {dir:'▼',bad:(bad==='down')}; return null; };
  const rlast=a=>{for(let i=a.length-1;i>=0;i--) if(a[i]!=null) return a[i]; return null;};
  const cur=k=>{const a=g(k); return a.length?(a[a.length-1]||0):0;};
  const delta=k=>{const a=g(k); if(a.length<2) return ''; const dv=(a[a.length-1]||0)-(a[a.length-2]||0); return dv?(' <span class="muted" style="font-size:12px">'+(dv>0?'▲':'▼')+Math.abs(dv)+'</span>'):''; };
  const pct=v=>v==null?'—':v+'%';
  const kpi=(label,val,sub)=>`<div class="card" style="flex:1 1 120px;min-width:118px;margin:0"><div class="muted" style="font-size:11px">${label}</div><div style="font-size:22px;font-weight:600;line-height:1.15">${val}</div><div class="muted" style="font-size:11px">${sub||''}</div></div>`;
  const block=(series,label,bad)=>{ const a=anom(series,bad); const pill=a?`<span class="pill ${a.bad?'red':'amber'}">${a.dir} change vs baseline</span>`:''; 
    return `<div class="card"><b>${label}</b> ${pill}${Charts.bars(series.map((x,i)=>({x:mo[i],v:(x==null?0:x),flag:!!a&&i===series.length-1})))}</div>`; };
  app().innerHTML=nav()+`<div class="card"><h3>Facility dashboard</h3>
    <p class="muted">Care quality this month, with denominators. Flags mark a real change against an established baseline &mdash; not the initial roll-up when the system was new. Export: <a class="nav" href="${API_BASE}api/dhis2">DHIS2</a></p></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
      ${kpi('Deliveries', cur('deliveries')+delta('deliveries'), mo[last]||'')}
      ${kpi('Partograph rate', pct(rlast(pgRate)), 'of labours')}
      ${kpi('Checklist rate', pct(rlast(ckRate)), 'of deliveries')}
      ${kpi('AMTSL rate', pct(rlast(amRate)), 'uterotonic &lt;1 min')}
      ${kpi('PNC coverage', pct(rlast(pncRate)), 'of deliveries')}
      ${kpi('Red AI alerts', cur('red_alerts')+delta('red_alerts'), 'this month')}
      ${kpi('Referrals', cur('referrals')+delta('referrals'), 'this month')}
      ${kpi('Stillbirths', cur('stillbirths'), (rlast(sbRate)!=null?rlast(sbRate)+'/1,000 births':'this month'))}
    </div>
    ${ovHtml}
    <div class="card"><h3>Trends over time</h3><p class="muted">Monthly rates against their denominators. A flag marks a real change against an established baseline &mdash; not the initial roll-up when the system was new.</p></div>
    ${block(pgRate,'Partograph completion rate (%)','down')}
    ${block(ckRate,'Safe-birth checklist rate (%)','down')}
    ${block(g('deliveries'),'Deliveries (count)','neutral')}
    ${block(sbRate,'Fresh stillbirths per 1,000 births','up')}
    ${block(g('red_alerts'),'Red AI alerts (count)','up')}`;
  wireOverview();
}

function drawPG(id){
  const W=640,H=300,mL=48,mR=16,mT=16,mB=36,maxH=12,yMin=4,yMax=10;
  const x=h=>mL+(Math.min(h,maxH)/maxH)*(W-mL-mR), y=c=>mT+(1-(c-yMin)/(yMax-yMin))*(H-mT-mB);
  let s=`<rect x="${mL}" y="${mT}" width="${W-mL-mR}" height="${H-mT-mB}" fill="#e1f5ee"/>`;
  s+=`<polygon points="${x(0)},${y(4)} ${x(6)},${y(10)} ${x(maxH)},${y(10)} ${x(maxH)},${y(4)}" fill="#faeeda"/>`;
  s+=`<polygon points="${x(4)},${y(4)} ${x(10)},${y(10)} ${x(maxH)},${y(10)} ${x(maxH)},${y(4)}" fill="#fcebeb"/>`;
  for(let c=4;c<=10;c++){s+=`<line x1="${mL}" y1="${y(c)}" x2="${W-mR}" y2="${y(c)}" stroke="#e6e4dd"/><text x="${mL-8}" y="${y(c)+4}" text-anchor="end" font-size="11" fill="#8a8880">${c}</text>`;}
  for(let h=0;h<=maxH;h+=2){s+=`<text x="${x(h)}" y="${H-mB+18}" text-anchor="middle" font-size="11" fill="#8a8880">${h}</text>`;}
  s+=`<line x1="${x(0)}" y1="${y(4)}" x2="${x(6)}" y2="${y(10)}" stroke="#BA7517" stroke-width="2"/><text x="${x(3)+6}" y="${y(7.4)}" font-size="11" fill="#854F0B">Alert</text>`;
  s+=`<line x1="${x(4)}" y1="${y(4)}" x2="${x(10)}" y2="${y(10)}" stroke="#A32D2D" stroke-width="2"/><text x="${x(7)+6}" y="${y(7.4)}" font-size="11" fill="#791F1F">Action</text>`;
  const o=OB[id]||[]; const pts=o.map(p=>`${x(p.hrs)},${y(Math.max(4,Math.min(10,p.cvx)))}`);
  if(pts.length>1)s+=`<polyline points="${pts.join(' ')}" fill="none" stroke="#1a1a18" stroke-width="1.5"/>`;
  o.forEach(p=>s+=`<text x="${x(p.hrs)}" y="${y(Math.max(4,Math.min(10,p.cvx)))+5}" text-anchor="middle" font-size="14" font-weight="600">X</text>`);
  const yD=v=>mT+((5-Math.max(0,Math.min(5,v)))/5)*(H-mT-mB);
  const od=o.filter(p=>p.dsc!=null&&!isNaN(p.dsc)); const dpts=od.map(p=>`${x(p.hrs)},${yD(p.dsc)}`);
  if(dpts.length>1)s+=`<polyline points="${dpts.join(' ')}" fill="none" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  od.forEach(p=>s+=`<text x="${x(p.hrs)}" y="${yD(p.dsc)+5}" text-anchor="middle" font-size="13" font-weight="600" fill="#0d9488">O</text>`);
  $('#pg').innerHTML=s;
}
function drawVitals(id){
  const o=OB[id]||[]; const W=640,mL=48,mR=16;
  const x=h=>mL+(Math.min(h,12)/12)*(W-mL-mR);
  const fT=16,fB=120,fmin=80,fmax=200; const yF=v=>fT+(1-(Math.max(fmin,Math.min(fmax,v))-fmin)/(fmax-fmin))*(fB-fT);
  let s=`<rect x="${mL}" y="${yF(160)}" width="${W-mL-mR}" height="${yF(110)-yF(160)}" fill="#e4f7ef"/>`;
  [80,110,160,200].forEach(v=>{ s+=`<line x1="${mL}" y1="${yF(v)}" x2="${W-mR}" y2="${yF(v)}" stroke="#eee"/><text x="${mL-6}" y="${yF(v)+4}" text-anchor="end" font-size="10" fill="#8a8880">${v}</text>`; });
  const fp=o.filter(p=>p.fhr).map(p=>`${x(p.hrs)},${yF(p.fhr)}`);
  if(fp.length>1)s+=`<polyline points="${fp.join(' ')}" fill="none" stroke="#b3261e" stroke-width="1.6"/>`;
  o.filter(p=>p.fhr).forEach(p=>s+=`<circle cx="${x(p.hrs)}" cy="${yF(p.fhr)}" r="3" fill="#b3261e"/>`);
  s+=`<text x="${mL}" y="11" font-size="10" fill="#8a8880">FHR (bpm)</text>`;
  const cT=150,cB=210,cmax=5; const yC=v=>cB-(Math.min(cmax,v)/cmax)*(cB-cT);
  [0,5].forEach(v=>{ s+=`<line x1="${mL}" y1="${yC(v)}" x2="${W-mR}" y2="${yC(v)}" stroke="#eee"/><text x="${mL-6}" y="${yC(v)+4}" text-anchor="end" font-size="10" fill="#8a8880">${v}</text>`; });
  o.filter(p=>p.ctx!=null&&!isNaN(p.ctx)).forEach(p=>{ const yy=yC(p.ctx); s+=`<rect x="${x(p.hrs)-6}" y="${yy}" width="12" height="${cB-yy}" rx="2" fill="#0d9488"/>`; });
  s+=`<text x="${mL}" y="${cT-4}" font-size="10" fill="#8a8880">Contractions /10 min</text>`;
  $('#pgv').innerHTML=s;
}

const CHK={admission:['Referral needed?','Partograph started (≥4cm)?','Start antibiotics?','Start magnesium sulfate?','Start antihypertensive?','Supplies for clean hands/gloves?','Birth companion present?','Confirm call-for-help plan?'],
 before_birth:['Confirm ready supplies?','Assistant identified?','Uterotonic ready?','Baby resuscitation area ready?'],
 after_birth:['Uterotonic given <1min?','Bleeding controlled?','Baby breathing/warm/skin-to-skin?','Early breastfeeding started?'],
 before_discharge:['Bleeding controlled?','Danger signs counselled?','Follow-up scheduled?','Family planning discussed?']};
async function checklist(id){
  // THE CHECKLIST NEVER LOADED WHAT WAS SAVED.
  // It never called GET, so every item re-rendered as "No" each time the screen was opened, and
  // saving again inserted a SECOND full set of rows (the table had no unique key). A checklist done
  // at 02:00 could not be reviewed at 08:00 — so it was done again, and the record then held two
  // contradictory sets. In the live database this screen has ZERO rows: it has never once been used
  // successfully. Now it loads, it pre-fills, it shows what is still outstanding, and re-saving a
  // pause point CORRECTS it instead of duplicating it.
  const past=await api('GET','checklist?episode='+id).catch(()=>[]);
  const prev={};                                    // item_code -> the response already recorded
  (past||[]).forEach(r=>{ if(r&&r.item_code) prev[r.item_code]=r.response; });

  const done=k=>CHK[k].filter((_,i)=>prev[k+'_'+i]!==undefined).length;
  const tabLabel=k=>{ const d=done(k), n=CHK[k].length;
    return k.replace('_',' ')+(d? ' <span class="muted" style="font-size:11px">'+(d===n?'&#10003;':d+'/'+n)+'</span>' : ''); };

  app().innerHTML=nav()+`<div class="card"><h3>WHO Safe Childbirth Checklist — episode ${esc(id)}</h3>
    <p class="muted">Each pause point can be re-opened and corrected. What was already recorded is shown below — it is no longer re-asked from a blank sheet.</p>
    <div class="tabs" id="tabs">${Object.keys(CHK).map((k,i)=>`<button class="${i==0?'on':''}" data-k="${k}">${tabLabel(k)}</button>`).join('')}</div>
    <div id="items"></div>
    <div id="chknote" class="muted" style="font-size:12px;margin-top:6px"></div>
    <button class="act" id="save" style="margin-top:10px">Save pause point</button><span class="muted" id="m"></span></div>`;
  let cur='admission';
  const renderItems=()=>{
    $('#items').innerHTML=CHK[cur].map((t,i)=>{
      const code=cur+'_'+i, v=prev[code];            // pre-fill from what is on the record
      const opt=(val,lab)=>`<option value="${val}"${v===val?' selected':''}>${lab}</option>`;
      return `<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span>${t}</span>
      <select data-i="${i}" style="width:120px">${v===undefined?'<option value="" selected>— not asked —</option>':''}${opt('no','No')}${opt('yes','Yes')}${opt('na','N/A')}</select></label></div>`;
    }).join('');
    const d=done(cur), n=CHK[cur].length;
    $('#chknote').textContent = d===0 ? 'Nothing recorded at this pause point yet.'
                    : (d===n ? 'All '+n+' items recorded. Re-saving will correct them, not duplicate them.'
                             : d+' of '+n+' recorded — '+(n-d)+' still outstanding.');
  };
  renderItems();
  $('#tabs').onclick=e=>{ const b=e.target.closest('button'); if(!b||!b.dataset.k) return; cur=b.dataset.k;
    [...$('#tabs').children].forEach(x=>x.className=x.dataset.k===cur?'on':''); renderItems(); };

  $('#save').onclick=async()=>{ const b=$('#save'); if(b.disabled) return; b.disabled=true;
    try{
      // Only send items the provider actually answered. An untouched "— not asked —" is not a "No".
      const rows=[...document.querySelectorAll('#items select')]
        .map((s,i)=>({episode_id:+id,pause_point:cur,item_code:cur+'_'+i,response:s.value}))
        .filter(r=>r.response);
      if(!rows.length){ $('#m').textContent=' nothing to save'; return; }
      const r=await api('POST','checklist',rows);
      if(r&&(r.ids||r.queued)){
        rows.forEach(x=>{ prev[x.item_code]=x.response; });   // reflect it immediately
        $('#m').textContent=' saved';
        [...$('#tabs').children].forEach(x=>{ x.innerHTML=tabLabel(x.dataset.k); });
        renderItems();
      } else { $('#m').textContent=' '+((r&&r.error)||'error'); }
    } finally{ b.disabled=false; } };
}

async function danger(id){
  window._dgAck=false;                     // acknowledgement is per-open, never inherited from a prior patient
  app().innerHTML=nav()+`<div class="card"><h3>Warning-sign sheet — episode ${esc(id)}</h3>
   <p class="muted">Headache, visual disturbance, epigastric pain and brisk reflexes together are the warning that eclampsia is imminent. They are recorded here <b>and</b> passed to the intrapartum risk score.</p>
   <div class="grid">
   <label>Headache<select id="ha"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Blurred vision<select id="bv"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Epigastric pain<select id="ep"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>DTR/clonus<select id="dtr"><option>+2</option><option>0</option><option>+1</option><option>+3</option><option>+4</option></select></label>
   <label>Vaginal bleeding<select id="vb"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Remark<input id="rk"></label></div>
   <div id="dgalert"></div>
   <button class="act" id="s" style="margin-top:10px">Save</button><span class="muted" id="m"></span></div>`;

  // This sheet used to collect the entire imminent-eclampsia cluster and then simply save it:
  // no score, no warning, nothing. Now it says what it means.
  const dgAlerts=()=>{
    const A=[]; const n=[];
    if(ha.value==='1') n.push('headache');
    if(bv.value==='1') n.push('blurred vision');
    if(ep.value==='1') n.push('epigastric pain');
    const brisk=(dtr.value==='+3'||dtr.value==='+4');
    if(brisk) n.push('brisk reflexes / clonus ('+dtr.value+')');
    if(vb.value==='1') A.push(['red','Vaginal bleeding','Assess the amount and the source. Antepartum haemorrhage is an emergency — get help, secure IV access, and prepare to refer.']);
    if(n.length>=2 || brisk) A.push(['red','IMMINENT ECLAMPSIA','She has: <b>'+n.map(esc).join(', ')+'</b>.<br>These are the premonitory signs of an eclamptic fit. Check her blood pressure and urine protein <b>now</b>. If pre-eclampsia is confirmed, give magnesium sulphate and an antihypertensive and refer urgently.']);
    else if(n.length===1) A.push(['amber','Warning sign present','<b>'+esc(n[0])+'</b>. Check her blood pressure and urine protein, and look for the others. Do not leave her unobserved.']);
    return A;
  };
  const paint=()=>{ $('#dgalert').innerHTML=dgAlerts().map(a=>alertBox(a[0],a[1],a[2])).join(''); };
  ['ha','bv','ep','dtr','vb'].forEach(k=>{const el=$('#'+k); if(el) el.addEventListener('change',paint);});
  paint();

  $('#s').onclick=async()=>{ const b=$('#s'); if(b.disabled) return;
    const reds=dgAlerts().filter(a=>a[0]==='red');
    if(reds.length && !window._dgAck){ window._dgAck=true;
      modal(reds[0][1], reds.map(a=>'<b>'+a[1]+'</b><br>'+a[2]).join('<br><br>')+'<br><br><i>Press Save again to record this.</i>','risk');
      return; }
    window._dgAck=false; b.disabled=true;
    try{ const r=await api('POST','danger_signs',{episode_id:+id,obs_datetime:localDateTime(),headache:+ha.value,blurred_vision:+bv.value,epigastric_pain:+ep.value,dtr_grade:dtr.value,vaginal_bleeding:+vb.value,remark:rk.value});
      $('#m').textContent=(r&&(r.ids||r.queued))?' saved — these findings will now be included in the next intrapartum risk score':' saved';
      if(!(r&&r.queued)) b.disabled=false;
    } catch(e){ b.disabled=false; toast(e.message||'error'); } };
}

// CORRECTING A DELIVERY.
//
// The delivery screen refuses to open once a delivery exists — rightly, because saving it twice
// double-counts the birth, the AMTSL rate and every newborn in the MoH register. But that left the
// record PERMANENT: a blood loss typed as 50 instead of 500, a mode recorded as SVD when she had a
// caesarean, a cause of maternal death picked from the wrong line — none of it could ever be put
// right, in the one record the facility is audited on. The API has always supported the PATCH; no
// screen ever called it.
//
// So: the guard stays (you cannot save a second delivery), and CORRECT is a separate, explicit act.
let EDIT_DEL=null;
const DEL_VALS={ md:'mode', mot:'mode_other_text', mo:'maternal_outcome', mdc:'maternal_death_cause',
  ut1:'amtsl_uterotonic', utt:'amtsl_uterotonic_type', cct:'amtsl_cct', utn:'amtsl_uterine_tone',
  umsg:'amtsl_massage', plc:'amtsl_placenta', ebl:'blood_loss_ml',
  dhtr:'hiv_test_result', dacc:'ippfp_acceptor', dmth:'ippfp_method', dtim:'ippfp_timing', drmk:'remark' };
const DEL_TICKS={ epis:'episiotomy', cpe:'comp_preeclampsia', cec:'comp_eclampsia', cap:'comp_aph',
  cpp:'comp_pph', cot:'comp_other', cref:'referred', dhta:'hiv_test_accepted', dhrt:'hiv_retest_accepted',
  dcfo:'cnsl_feeding_options' };

async function delivery(id){
  window._pphAck=false;                    // acknowledgement is per-open, never inherited from a prior patient
  // MoH item 7 (Partograph used) is derived, not asked: Y only if maternal condition,
  // fetal condition AND progress of labour were all monitored.
  const obs=await api('GET','observations?episode='+id).catch(()=>[]);
  const pUsed=(obs||[]).some(o=>o.fetal_heart_rate) && (obs||[]).some(o=>o.cervix_cm!=null) &&
              (obs||[]).some(o=>o.bp_systolic||o.pulse||o.temperature) ? 'Y' : 'N';
  const [W,already,prevDel]=await Promise.all([
    epOne(id),
    api('GET','babies?episode='+id).catch(()=>[]),
    api('GET','delivery?episode='+id).catch(()=>[])]);
  const rhNegD=String(W.rh_factor||'').toLowerCase()==='neg';
  // Guard against saving the delivery twice — it double-counts deliveries, AMTSL and the
  // partograph rate, and duplicates every newborn row in the MoH register.
  if(prevDel&&prevDel.length && !EDIT_DEL){
    const D=prevDel[0];
    const canFix = (ME.role==='provider'||ADMIN());
    app().innerHTML=nav()+`<div class="card"><h3>Delivery already recorded — episode ${esc(id)}</h3>
      <p class="muted">A delivery has already been saved for this episode (${esc((D.delivery_datetime||'').slice(0,16))}, mode ${esc(D.mode||'?')}${D.blood_loss_ml!=null?(', blood loss '+esc(D.blood_loss_ml)+' ml'):''}). Saving it again would double-count it.</p>
      ${canFix?`<p style="margin:10px 0"><button id="delfix" class="sm">Correct this delivery record</button>
        <span class="muted" style="font-size:12px;margin-left:6px">If something was entered wrongly &mdash; the mode, the blood loss, the time of birth. It corrects the record; it does not create a second one.</span></p>`:''}
      <a class="nav" href="#baby/${id}">Record / view the newborn</a> &middot;
      <a class="nav" href="#pncvisit/${id}">PNC follow-up</a> &middot;
      <a class="nav" href="#report/${id}">Care summary</a></div>`;
    const fb=$('#delfix'); if(fb) fb.onclick=()=>{ EDIT_DEL=D; delivery(id); };
    return;
  }
  const DBORN = EDIT_DEL && EDIT_DEL.delivery_datetime ? String(EDIT_DEL.delivery_datetime) : null;
  app().innerHTML=nav()+`<div class="card"><h3>${EDIT_DEL?'Correcting the delivery record':'Delivery summary'} — episode ${esc(id)}</h3>
   ${EDIT_DEL?`<div class="alert amber" style="margin-bottom:10px"><b>You are correcting the delivery that is already recorded.</b> Saving updates that record &mdash; it does not create a second delivery, and it does not touch the newborn records.
     <button id="dcancel" class="sm" style="margin-left:8px">Cancel</button></div>`:''}
   ${carryForward(W,rhNegD)}

   <details class="moh" open><summary>Date &amp; time of birth</summary>
   <div class="muted" style="font-size:12px;margin-bottom:6px">This is the time <b>the baby was born</b>, not the time this form is filled in. ${EDIT_DEL?'It is filled in from the record you are correcting.':'It is pre-filled with now &mdash; change it if you are writing the birth up later.'}</div>
   <div class="grid">
    ${ecPicker('dd','Date of birth',!DBORN, DBORN?DBORN.slice(0,10):undefined)}
    <label>Time of birth<input id="dt" type="time" value="${esc(DBORN?DBORN.slice(11,16):localDateTime().slice(11,16))}"></label>
   </div>
   <div id="dtwarn"></div></details>

   <div class="grid">
   <label>Mode<select id="md"><option value="svd">SVD — spontaneous vaginal</option><option value="assisted">Forceps / vacuum assisted</option><option value="caesarean">Caesarean section</option><option value="other">Other</option></select></label>
   <label>If other, specify<input id="mot" placeholder="assisted breech, destructive…"></label>
   <label>Mother's status<select id="mo"><option value="well">Stable</option><option value="near_miss">Survived a near-miss</option><option value="referred">Unstable / deteriorated — referred</option><option value="death">Died</option></select></label>
   <label id="mdcw" style="display:none">Cause of maternal death<select id="mdc">${selOpts([['1','1. Haemorrhage'],['2','2. Pre-eclampsia / eclampsia'],['3','3. Obstructed labour'],['4','4. Sepsis'],['5','5. Anaemia'],['6','6. Other']])}</select></label>
   <label>Uterotonic within 1 min<select id="ut1"><option value="">-</option><option value="done">Done</option><option value="delayed">Delayed</option><option value="not">Not done</option></select></label>
   <label>Uterotonic type<select id="utt"><option value="">-</option><option value="oxytocin">Oxytocin</option><option value="misoprostol">Misoprostol</option><option value="ergometrine">Ergometrine</option><option value="other">Other</option></select></label>
   <label>Controlled cord traction<select id="cct"><option value="">-</option><option value="done">Done</option><option value="not">Not done</option><option value="noskill">Not done (no skilled attendant)</option></select></label>
   <label>Uterine tone<select id="utn"><option value="">Not assessed</option><option value="firm">Firm</option><option value="atonic">Atonic</option></select></label>
   <label>Massage if atony<select id="umsg"><option value="">-</option><option value="done">Done</option><option value="not_needed">Not needed</option><option value="not">Not done</option></select></label>
   <label>Placenta<select id="plc"><option value="">-</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option><option value="retained">Retained</option></select></label>
   <label>Est. blood loss (ml)<input id="ebl" type="number" min="0" placeholder="ml"></label>
   </div>
   <div id="pphwarn"></div>
   <div class="ticks" style="margin-top:8px">${tick('epis','Episiotomy performed')}</div>

   <details class="moh" open><summary>Obstetric complications <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('cpe','Pre-eclampsia')}${tick('cec','Eclampsia')}${tick('cap','APH')}${tick('cpp','PPH')}${tick('cot','Other (obstructed labour, sepsis…)')}${tick('cref','Referred')}
   </div></details>

   <details class="moh"><summary>HIV <span class="muted">&mdash; MoH Delivery register</span></summary><div class="grid">
    <label>HIV test result<select id="dhtr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
   </div><div class="ticks">${tick('dhta','HIV testing accepted')}${tick('dhrt','HIV re-testing accepted')}${tick('dcfo','Counselled on feeding options')}</div>
   <div class="muted" style="font-size:12px;margin-top:6px">Linkage to PMTCT, ART regimen, target population and partner testing are held on the woman&rsquo;s record.</div></details>

   <details class="moh" open><summary>Immediate postpartum family planning (IPPFP)</summary>
   <div class="muted" style="font-size:12px;margin-bottom:6px">IUCD is the method most facilities provide at delivery. Timing matters: post-placental insertion is within 10 minutes of placental delivery.</div>
   <div class="grid">
    <label>Acceptor type<select id="dacc">${selOpts(ACCEPTOR)}</select></label>
    <label>Method received<select id="dmth">${selOpts(IPPFP_METHODS)}</select></label>
    <label>Timing<select id="dtim">${selOpts([['post_placental','Post-placental (within 10 min)'],['within_48h','Within 48 hours'],['not_given','Not given']])}</select></label>
   </div></details>

   <label>Remark<input id="drmk"></label>
   <div class="muted" style="font-size:12px;margin-top:8px">Partograph used (MoH item 7): <b>${pUsed==='Y'?'Yes':'No'}</b> &mdash; derived from the partograph record (maternal + fetal + progress all monitored).</div>
   <div style="background:#eef6f5;border:1px solid #dbe7e4;border-radius:10px;padding:9px 12px;margin-top:8px;font-size:13px">
     This screen records the <b>mother</b>. The <b>newborn</b> is recorded on the next screen &mdash; one row per baby, so twins are handled properly and every newborn gets the full assessment (APGAR checks, Vitamin K timing, HIV exposure, KMC, phototherapy, NICU).
     ${already.length?`<div style="margin-top:4px;color:#0f766e"><b>${already.length} newborn record(s) already exist</b> for this delivery.</div>`:''}
   </div>
   <button class="act" id="s" style="margin-top:10px">Save &amp; record the newborn</button><span class="muted" id="m"></span></div>`;
  const syncDeath=()=>{ $('#mdcw').style.display=(mo.value==='death')?'':'none'; };
  mo.addEventListener('change',syncDeath); syncDeath();

  // TIME OF BIRTH — recorded, not assumed.
  // `delivery_datetime` used to be localDateTime() at the moment Save was pressed. So a 04:00 birth
  // written up at 07:30 was stamped 07:30, and a birth written up after midnight landed on the WRONG
  // DAY — and therefore in the wrong month of the MoH delivery register, the dashboard and DHIS2.
  const birthDT=()=>{
    const d=ecGet('dd');                                  // Ethiopian picker -> Gregorian ISO date
    const t=($('#dt')&&$('#dt').value)||'00:00';
    return d ? (d+' '+t+':00') : null;
  };
  const checkBirthTime=()=>{
    const s=birthDT(); const box=$('#dtwarn'); if(!box) return true;
    if(!s){ box.innerHTML=''; return true; }
    const when=parseLocal(s); const now=Date.now();
    if(!when){ box.innerHTML=''; return true; }
    if(when.getTime() > now + 60*60*1000){          // an hour's grace for a clock that is slightly off
      box.innerHTML=alertBox('red','The time of birth is in the future','You have entered '+esc(s.slice(0,16))+', which is later than now. Please check the date and the time.');
      return false;
    }
    const hrs=(now-when.getTime())/36e5;
    box.innerHTML = hrs>24
      ? alertBox('amber','This birth is recorded as '+Math.round(hrs/24)+' day(s) ago','Please confirm the date is right &mdash; a wrong date puts her in the wrong month of the MoH register.')
      : '';
    return true;
  };
  ['dd_d','dd_m','dd_y','dt'].forEach(k=>{ const el=$('#'+k); if(el){ el.addEventListener('change',checkBirthTime); el.addEventListener('input',checkBirthTime); } });
  checkBirthTime();

  // POSTPARTUM HAEMORRHAGE — the leading cause of maternal death, and until now the one emergency
  // the tool could not see. Blood loss >=500 ml (>=1000 for caesarean) OR an atonic uterus is PPH.
  // It fires a red banner, ticks the MoH complication automatically, and — like the ANC, PNC and
  // danger-sign screens — the record cannot be saved until the alert has been acknowledged once.
  const pphCheck=()=>{
    const ebl=numOrNull(ebl_el.value), atonic=(utn.value==='atonic');
    const thresh=(md.value==='caesarean')?1000:500;
    const heavy=(ebl!=null && ebl>=thresh);
    const pph=heavy||atonic;
    const box=$('#pphwarn');
    if(pph){
      box.innerHTML='<div style="background:#fcebeb;border:1px solid #d13b3b;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>POSTPARTUM HAEMORRHAGE</b> &mdash; '
        +(heavy?('blood loss '+ebl+' ml (&ge;'+thresh+')'):'')+(heavy&&atonic?' and ':'')+(atonic?'uterus atonic':'')
        +'. Call for help, uterotonic + uterine massage, IV access and fluids, weigh losses, and prepare to refer. This is an emergency.</div>';
    } else box.innerHTML='';
    // Keep the MoH PPH complication IN STEP with the criteria, in BOTH directions. It used to only ever
    // be ticked ON: type 1500 ml, notice the typo, correct it to 150 - and comp_pph=1 was still filed,
    // inflating the facility's PPH rate with a haemorrhage that never happened.
    const c=document.getElementById('cpp'); if(c) c.checked=pph;
    return pph;
  };
  const ebl_el=$('#ebl');
  [ebl_el, utn, md].forEach(el=>{ if(el){ el.addEventListener('input',pphCheck); el.addEventListener('change',pphCheck); } });

  const MOH_STATUS={well:'stable',near_miss:'stable',referred:'unstable_referred',death:'died'};

  // Prefill when correcting. (Done AFTER the listeners are wired above, so the PPH check and the
  // alerts reflect the values being corrected rather than an empty form.)
  const dcb=$('#dcancel'); if(dcb) dcb.onclick=()=>{ EDIT_DEL=null; delivery(id); };
  if(EDIT_DEL){
    fillVals(EDIT_DEL, DEL_VALS);
    fillTicks(EDIT_DEL, DEL_TICKS);
    if(typeof pphCheck==='function') pphCheck();
  }

  $('#s').onclick=async()=>{
    // Range check BEFORE the PPH gate — a blood loss typed as 90000 is a slip, and raising a
    // haemorrhage alert on it would teach the provider that the alert means nothing.
    if(!checkRanges([['ebl','blood_loss_ml']])) return;
    // The birth cannot have happened in the future.
    if(!checkBirthTime()){ modal('Check the time of birth','The date and time of birth you have entered is in the future. A delivery cannot be recorded before it has happened.','risk'); return; }
    if(!birthDT()){ modal('Date of birth is missing','Please enter the date the baby was born. It is what puts her on the right line of the MoH delivery register.','risk'); return; }
    // A red PPH alert must be SEEN before the delivery can be filed.
    if(pphCheck() && !window._pphAck){ window._pphAck=true; modal('Postpartum haemorrhage','This delivery meets the PPH criteria (blood loss threshold or atonic uterus). Manage the haemorrhage first. Press Save again to confirm you have seen this and to record it.','risk'); return; }
    const btn=$('#s'); btn.disabled=true;
    try{
      // Newborn data goes ONLY to the babies table (created just below) — it is the single
      // source of truth and the only one that supports twins. delivery_summary no longer
      // carries a shadow copy of weight/sex/APGAR/outcome.
      const _edD = EDIT_DEL && EDIT_DEL.id;
      await api(_edD?'PATCH':'POST', _edD?('delivery/'+EDIT_DEL.id):'delivery',
        {episode_id:+id,delivery_datetime:birthDT(),mode:md.value,maternal_outcome:mo.value,amtsl_uterotonic:(ut1.value||null),amtsl_uterotonic_type:(utt.value||null),amtsl_cct:(cct.value||null),amtsl_uterine_tone:(utn.value||null),amtsl_massage:(umsg.value||null),amtsl_placenta:(plc.value||null),blood_loss_ml:numOrNull(ebl.value),
        partograph_used:pUsed,episiotomy:tk('epis'),mode_other_text:(md.value==='other'?mot.value:null),
        maternal_status:MOH_STATUS[mo.value]||null,maternal_death_cause:(mo.value==='death'?(+mdc.value||null):null),
        comp_preeclampsia:tk('cpe'),comp_eclampsia:tk('cec'),comp_aph:tk('cap'),comp_pph:tk('cpp'),comp_other:tk('cot'),referred:tk('cref'),
        hiv_test_accepted:tk('dhta'),hiv_retest_accepted:tk('dhrt'),hiv_test_result:(dhtr.value||null),cnsl_feeding_options:tk('dcfo'),
        ippfp_acceptor:(dacc.value||null),ippfp_method:(dmth.value||null),ippfp_timing:(dtim.value||null),remark:drmk.value});
      // A CORRECTION ENDS HERE. She is already 'delivered', her newborns are already recorded, and
      // sending her back to the newborn screen would invite a phantom twin. Go back to her record.
      if(_edD){
        EDIT_DEL=null; window._pphAck=false;
        $('#m').textContent=' corrected'; toast('The delivery record was corrected','ok');
        setTimeout(()=>location.hash='#patient/'+id,700);
        $('#s').disabled=false;
        return;
      }
      await api('PATCH','episodes/'+id,{status:'delivered'});
      // The newborn is NOT created here. Previously this screen half-created baby #1 with only
      // weight/sex/APGAR — fields it could never complete (there is no babies PATCH), and if the
      // provider then used the Newborn screen it created a PHANTOM TWIN that inflated birth counts
      // and the MoH register. One place records a newborn: the Newborn screen, fully validated.
      window._pphAck=false;
      $('#m').textContent=' saved'; toast('Delivery recorded — now record the newborn','ok');
      setTimeout(()=>location.hash='#baby/'+id,700);
    }catch(e){ toast('Could not save delivery — '+(e.message||'error')+'. Not saved.'); }
    finally{ $('#s').disabled=false; } };
  const note=document.createElement('p'); note.className='muted'; note.style.cssText='font-size:12px;margin-top:6px'; note.textContent='For twins/multiples, save this (baby 1), then add the others on the Newborn screen.'; $('#app').querySelector('.card').appendChild(note);
}

async function pnc(){
  // THE POSTNATAL LIST MUST INCLUDE WOMEN WHO DID NOT DELIVER HERE. It used to query ONLY
  // labour episodes with status 'delivered' — so a woman who delivered at home or at another
  // facility and came in for postnatal care was registered as a PNC episode, redirected to this
  // screen, and told "No postnatal women yet." She was in no worklist at all, while the Home
  // tile cheerfully counted her. Home-delivered mothers are the highest-mortality postnatal
  // group; they were exactly the ones this dropped.
  const [lab,pncEps,provs]=await Promise.all([
    api('GET','episodes?category=labour').catch(()=>[]),
    api('GET','episodes?category=pnc').catch(()=>[]),
    api('GET','providers').catch(()=>[])]);
  const del=(lab||[]).filter(r=>r.status==='delivered');
  // De-duplicate by WOMAN. A woman who delivered here and then had a pnc episode opened for her
  // appeared on this list TWICE — once correctly, once tagged "delivered elsewhere", which was
  // false. The labour episode wins: it owns the delivery record and the babies, so it is the one
  // whose PNC visits can be tied to an actual infant.
  const seen=new Set(del.map(r=>String(r.woman_id)));
  const rows=del.concat((pncEps||[]).filter(r=>!seen.has(String(r.woman_id))));
  // "Delivered elsewhere" is a fact about the BIRTH, not about which table the episode sits in.
  const elsewhere=r=>{
    const p=String(r.place_of_delivery||'').toLowerCase();
    if(p==='home') return 'delivered at home';
    if(p==='other_facility'||p==='other') return 'delivered at another facility';
    if(r.service_category==='pnc' && !p) return 'delivered elsewhere';   // pnc episode, place not recorded
    return '';
  };
  const where=r=>{
    const el=elsewhere(r);
    return (el?`<span class="pill amber">${el}</span> `:'') + referPill(r);
  };
  app().innerHTML=nav()+`<div class="card"><h3>Postnatal care</h3>
   <p class="muted">Women after delivery — whether they delivered here, at another facility, or at home. WHO postnatal contacts: within 24 hours, day 3, day 7, and week 6. Open <b>PNC follow-up</b> to record the mother-and-newborn check.</p>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th></th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td>
    <td>${where(r)}${riskPill(r)}${syncPill(r)}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#pncvisit/${r.id}">PNC follow-up</a> &middot; <a class="nav" href="#baby/${r.id}">Newborn</a> &middot; <a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No postnatal women yet.</td></tr>'}
   </table></div>`;
  wireAssign(); wireRisk(rows);   // the "Higher risk" pill explains itself on click
}
const ANC_GROUPS={obstetric_history:'Obstetric history',current_pregnancy:'Current pregnancy',general_medical:'General medical'};
// Aligned to the National ANC Guideline (MoH, Feb 2022): Table 4 (high-risk conditions)
// and Annex 6 (the ANC card's past- and current-pregnancy history).
// Thresholds corrected: age <19 / >35 (was <16 / >40); macrosomia >=4000 g (was >4500 g).
const ANC_ITEMS=[
 ['OBS_PREV_STILLBIRTH','obstetric_history','Previous stillbirth'],
 ['OBS_NEONATAL_DEATH','obstetric_history','Previous early neonatal death'],
 ['OBS_3_ABORTIONS','obstetric_history','Three or more abortions (spontaneous or induced)'],
 ['OBS_CONGENITAL','obstetric_history','Previous baby with a congenital anomaly'],
 ['OBS_BW_LT2500','obstetric_history','Birth weight of previous baby < 2500 g'],
 ['OBS_BW_GTE4000','obstetric_history','Birth weight of previous baby ≥ 4000 g (macrosomia)'],
 ['OBS_PRETERM','obstetric_history','Previous preterm birth'],
 ['OBS_PROM','obstetric_history','Previous leakage of fluid per vagina (PROM)'],
 ['OBS_APH','obstetric_history','Previous vaginal bleeding after 7 months (antepartum haemorrhage)'],
 ['OBS_PREV_PREECLAMPSIA','obstetric_history','Previous hypertensive disease / pre-eclampsia or eclampsia'],
 ['OBS_PREV_CS','obstetric_history','Previous delivery by caesarean section'],
 ['OBS_PREV_ASSISTED','obstetric_history','Previous delivery by vacuum or forceps'],
 ['OBS_PREV_SURGERY','obstetric_history','Other surgery on the reproductive tract (myomectomy, LEEP, cerclage)'],
 ['OBS_PREV_PPH','obstetric_history','Previous postpartum haemorrhage (PPH)'],
 ['OBS_PREV_OBSTRUCTED','obstetric_history','Previous obstructed or prolonged labour'],
 ['CUR_AGE_LT19','current_pregnancy','Age under 19 years'],
 ['CUR_AGE_GT35','current_pregnancy','Age over 35 years'],
 ['CUR_UNPLANNED','current_pregnancy','Unplanned and/or unwanted pregnancy'],
 ['CUR_MULTIPLE','current_pregnancy','Suspected multiple pregnancy'],
 ['CUR_BLEEDING','current_pregnancy','Vaginal bleeding'],
 ['CUR_SHORT_STATURE','current_pregnancy','Short stature or severe physical deformity'],
 ['CUR_BMI','current_pregnancy','Underweight (BMI < 18.5) or overweight/obese (BMI > 25)'],
 ['CUR_MALARIA_AREA','current_pregnancy','From a malaria-endemic area'],
 ['MED_DIABETES','general_medical','Diabetes mellitus'],
 ['MED_CHRONIC_HTN','general_medical','Chronic hypertension'],
 ['MED_CARDIAC_RENAL','general_medical','Cardiac or renal disease'],
 ['MED_ANAEMIA','general_medical','Anaemia'],
 ['MED_RH_SENSITIZED','general_medical','Rh-sensitised mother'],
 ['MED_PSYCH','general_medical','Psychiatric illness'],
 ['MED_HIV_TB_SYPH','general_medical','HIV (high viral load), acute hepatitis, syphilis, TB, or other systemic infection'],
 ['MED_OTHER_SEVERE','general_medical','Any other severe or chronic medical condition']
];
async function ancScreen(id){
  const [existing,e]=await Promise.all([api('GET','anc_screening?episode='+id).catch(()=>[]),epOne(id)]);
  const prev={}; existing.forEach(r=>prev[r.item_code]=r.response);
  const notePrev=prev['PLAN_NOTE']||'';
  // Items we can answer from data already held — prefilled, but the provider may override.
  const derived={};
  if(e.age){ derived.CUR_AGE_LT19=(+e.age<19)?'yes':'no'; derived.CUR_AGE_GT35=(+e.age>35)?'yes':'no'; }
  if(e.pregnancy_planned!==null&&e.pregnancy_planned!==undefined&&e.pregnancy_planned!=='') derived.CUR_UNPLANNED=(+e.pregnancy_planned===0)?'yes':'no';
  // HER HISTORY IS ALREADY KNOWN — prefill it rather than asking her to say it again.
  // This form is episode-scoped, so in a second pregnancy it opened completely blank, and a
  // provider working down it answered "No" to "previous caesarean" — overwriting a recorded 'yes'
  // and handing the intrapartum model prior_cs = 0 for a scarred uterus. The server now refuses to
  // downgrade these, but the real fix is that she should never be asked to re-assert a permanent
  // fact: it arrives already answered, from her own record.
  const HIST={OBS_PREV_CS:'prior_cs', OBS_PREV_STILLBIRTH:'prior_stillbirth', OBS_PREV_PPH:'prior_pph',
              OBS_PREV_PREECLAMPSIA:'prior_preeclampsia', OBS_PREV_OBSTRUCTED:'prior_obstructed',
              MED_CHRONIC_HTN:'chronic_htn', MED_DIABETES:'diabetes', MED_CARDIAC_RENAL:'cardiac_renal'};
  const fromRecord={};
  Object.keys(HIST).forEach(code=>{ const v=e[HIST[code]]; if(v==='yes'||v==='no'){ derived[code]=v; fromRecord[code]=1; } });

  let html=nav()+`<div class="card"><h3>ANC risk screening — episode ${esc(id)} <span id="ancband" class="pill"></span></h3>
    <p class="muted">Risk conditions from the National ANC Guideline (MoH, Feb 2022), Table 4 and Annex 6. <b>Every item must be answered</b> — an unanswered item is not the same as "No". Prefilled items were derived from her record; change them if they are wrong.</p>
    <div id="ancreq" style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:8px 12px;margin:8px 0;font-size:13px"></div>`;
  Object.keys(ANC_GROUPS).forEach(gk=>{ html+=`<h4>${ANC_GROUPS[gk]}</h4>`;
    ANC_ITEMS.filter(it=>it[1]===gk).forEach(it=>{ const v=prev[it[0]]||derived[it[0]]||'';
      const auto=(!prev[it[0]]&&derived[it[0]])?' <span class="muted" style="font-size:11px">(from her record)</span>':'';
      html+=`<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span>${esc(it[2])}${auto}</span>
        <select data-code="${it[0]}" data-group="${it[1]}" style="width:132px"><option value=""${v===''?' selected':''}>— select —</option><option value="no"${v==='no'?' selected':''}>No</option><option value="yes"${v==='yes'?' selected':''}>Yes</option><option value="unknown"${v==='unknown'?' selected':''}>Unknown</option></select></label></div>`; }); });
  html+=`<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)"><h4>Care plan</h4>
    <label>Notes (clinician's plan)<textarea id="ancnote" rows="3" placeholder="Birth plan, monitoring, referral decision, or any notes...">${esc(notePrev)}</textarea></label></div>`;
  html+=`<button class="act" id="ancsave" style="margin-top:12px">Save screening</button> <span class="muted" id="ancm"></span></div>`;
  app().innerHTML=html;
  const sels=()=>[...document.querySelectorAll('#app select[data-code]')];
  const unanswered=()=>sels().filter(s=>!s.value);
  const evalBand=()=>{ const yes=sels().some(s=>s.value==='yes'); const b=$('#ancband');
    b.textContent=yes?'Higher-risk pregnancy':'Routine ANC'; b.className='pill '+(yes?'amber':'green');
    const u=unanswered(); const box=$('#ancreq');
    if(u.length){ box.style.display=''; box.textContent=u.length+' of '+sels().length+' items still unanswered. All items are required before this screening can be saved.';
      u.forEach(s=>s.style.borderColor='#ef9f27'); }
    else { box.style.display='none'; }
    sels().forEach(s=>{ if(s.value) s.style.borderColor=''; });
    $('#ancsave').textContent = u.length?('Save screening ('+u.length+' left)'):'Save screening';
  };
  sels().forEach(s=>s.onchange=evalBand); evalBand();
  $('#ancsave').onclick=async()=>{
    const u=unanswered();
    if(u.length){ modal('Screening incomplete', u.length+' item(s) are still unanswered. The National ANC Guideline requires every risk condition to be assessed — leaving an item blank is not the same as answering "No". Please complete them all.','risk');
      u[0].scrollIntoView({block:'center'}); return; }
    const rows=sels().map(s=>({episode_id:+id,item_code:s.dataset.code,item_group:s.dataset.group,response:s.value}));
    const nv=($('#ancnote').value||'').slice(0,255);
    if(nv) rows.push({episode_id:+id,item_code:'PLAN_NOTE',item_group:'care_plan',response:nv});
    const r=await api('POST','anc_screening',rows); $('#ancm').textContent=(r&&r.ids)?' saved ('+rows.length+' items)':' '+((r&&r.error)||'saved offline'); };
}

async function ancList(){
  const [rows,provs]=await Promise.all([api('GET','episodes?category=anc').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>Antenatal care</h3>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}${riskPill(r)}${syncPill(r)}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a> <button class="sec" data-w="${r.woman_id}" data-to="labour">&rarr; Labour</button></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No antenatal women yet. Register one with service = ANC.</td></tr>'}
   </table><p class="muted">"&rarr; Labour" admits the woman into the labour ward. Higher-risk women are flagged automatically from their ANC screening and gathered under the High risk tab.</p></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_anc'));
  wireAssign(); wireRisk(rows);   // the "Higher risk" pill explains itself on click
}

async function highriskList(){
  const [rows,provs]=await Promise.all([api('GET','episodes?flag=highrisk').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>High-risk worklist</h3>
   <p class="muted">Women in antenatal care or labour who carry a risk factor &mdash; flagged automatically from their ANC risk screening. A live worklist to help prioritise who to see first; risk is a status, not a separate ward.</p>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Pathway</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.service_category||'')}</td><td>${esc(r.status)}${riskPill(r)}${syncPill(r)}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=7 class=muted>No higher-risk women right now. Women are flagged here automatically from their ANC risk screening.</td></tr>'}
   </table></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_highrisk'));
  wireAssign(); wireRisk(rows);   // the "Higher risk" pill explains itself on click
}

async function transfer(womanId,cat,from){
  const r=await api('POST','episodes',{woman_id:womanId,service_category:cat,status:cat==='labour'?'laboring':'active',admitted_from:from,provider_id:ME.role==='provider'?ME.id:null,admission_datetime:localDateTime()});
  // The server hands back the episode she ALREADY has rather than opening a second one, and
  // closes her antenatal episode when she is admitted in labour — so she stops appearing on the
  // antenatal list and the labour ward at the same time.
  if(r&&r.reused) toast('She already has an open '+(cat==='labour'?'labour':cat)+' record — opening it.','ok');
  if(r&&r.id){ location.hash=cat==='labour'?'#labour':(cat==='highrisk'?'#highrisk':'#antenatal'); route(); }
  else if(r&&r.queued) toast('Saved — will be sent when you are back online','ok');
  else alert('Could not admit: '+((r&&r.error)||'error'));
}

// ================= workflow-parity modules =================
const nowStr=()=>localDateTime();
const today=()=>localDate();

async function referralScreen(id){
  const past=await api('GET','referrals?episode='+id).catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>Referral — episode ${esc(id)}</h3>
   <div class="grid">
    <label>Refer to (facility)<input id="rto" placeholder="e.g. Felege Hiwot Referral Hospital"></label>
    <label>Urgency<select id="rurg"><option value="urgent">Urgent</option><option value="emergency">Emergency</option><option value="routine">Routine</option></select></label>
    <label>Transport<input id="rtr" placeholder="ambulance / private"></label>
    <label>Reason<select id="rrsn"><option>Obstructed / prolonged labour</option><option>Postpartum haemorrhage (PPH)</option><option>Severe pre-eclampsia / eclampsia</option><option>Sepsis / infection</option><option>Birth asphyxia / newborn distress</option><option>Antepartum haemorrhage</option><option>Retained placenta</option><option>Uterine rupture</option><option>Other</option></select></label>
    <label>Details<input id="rdet" placeholder="optional"></label>
   </div><button class="act" id="rsave" style="margin-top:10px">Save referral</button> <span class="muted" id="rm"></span></div>
   <div class="card"><h3>Referral history</h3><table><tr><th>When</th><th>To</th><th>Urgency</th><th>Reason</th></tr>
    ${past.map(p=>`<tr><td>${esc((p.recorded_at||'').slice(0,16))}</td><td>${esc(p.referred_to||'')}</td><td>${esc(p.urgency||'')}</td><td>${esc(p.reason||'')}</td></tr>`).join('')||'<tr><td colspan=4 class=muted>No referrals yet.</td></tr>'}
   </table></div>`;
  $('#rsave').onclick=async()=>{ const _b=$('#rsave'); if(_b.disabled) return; _b.disabled=true;
    setTimeout(()=>{ if(_b) _b.disabled=false; },4000);
    const det=($('#rdet')||{}).value; const r=await api('POST','referrals',{episode_id:+id,referred_to:rto.value,reason:rrsn.value+(det?(' — '+det):''),urgency:rurg.value,transport:rtr.value});
    if(r&&(r.ids||r.queued)){ try{ await api('PATCH','episodes/'+id,{status:'referred'}); }catch(e){} $('#rm').textContent=' referred'; setTimeout(()=>referralScreen(id),500); } else $('#rm').textContent=' '+((r&&r.error)||'error'); };
}

// Guideline Table 2: contacts at <=12, 20, 26, 30, 34, 36, 38, 40 weeks.
const ANC_SCHEDULE={1:12,2:20,3:26,4:30,5:34,6:36,7:38,8:40};
// Guideline Table 5: what each contact specifically requires.
const ANC_CONTACT_ACTIONS={
 1:['Full history and physical examination','Hb/Hct, blood group + Rh, urine analysis','HIV, syphilis, HBV','Td-1','Counsel on danger signs and lifestyle'],
 2:['Ultrasound (before 24 weeks)','Initiate IFA <b>and calcium</b>','Deworming','Assess mental health and intimate partner violence','MUAC and weight'],
 3:['Urinalysis for proteinuria + urine gram stain','OGTT if high risk','No ultrasound needed'],
 4:['<b>Repeat syphilis and HIV</b> if earlier result was negative','<b>Repeat Hb</b>','Counsel on birth preparedness (BPCR)','Counsel on breastfeeding'],
 5:['<b>Determine fetal presentation</b>','Repeat syphilis/HIV if not done at 30 weeks','Urine protein if high risk','Counsel on immunisation and early childhood development'],
 6:['All 34-week activities','<b>Assess mental health</b>'],
 7:['<b>Repeat Hb</b>','Ask about fears and worries about labour','Advise fetal movement counting'],
 8:['Ultrasound for fetal wellbeing','Review fetal movement counting']
};
const LAB_TESTS=[['HGB','Haemoglobin / haematocrit'],['BLOOD_GROUP_RH','Blood group and Rh'],['URINE_DIP','Urine dipstick (protein)'],
 ['URINE_GRAM','Urine microscopy / gram stain'],['HIV','HIV test'],['SYPHILIS','Syphilis (RPR/VDRL)'],['HBV','Hepatitis B (HBsAg)'],
 ['OGTT','OGTT (75g, 2-hour)'],['USS','Obstetric ultrasound'],['OTHER','Other']];

// ---- THE FIRST-CONTACT LABORATORY PANEL ---------------------------------------------------------
// A clinician in the field asked for this: the tests that are MANDATORY at the first ANC contact
// were nowhere in the tool, so whether they had been done was a matter of memory. These six decide
// what happens for the rest of the pregnancy — a reactive syphilis to be treated, an HIV result that
// opens PMTCT, a Rh-negative blood group that needs anti-D at 28 weeks, an anaemia to treat before
// she reaches labour. Missing one is not a paperwork failure; it is the failure the guideline exists
// to prevent.
//
// It PROMPTS, it does not BLOCK. The lab is sometimes shut, the reagent is sometimes out, and a
// provider who cannot save a contact because a test she cannot do is missing will simply stop using
// the tool. So: show what is outstanding, offer to send it to the lab in one tap, and let her save.
const FIRST_LABS=[
  ['BLOOD_GROUP_RH','Blood group and Rh'],
  ['HGB','Haemoglobin'],
  ['HIV','HIV test'],
  ['SYPHILIS','Syphilis (RPR/VDRL)'],
  ['HBV','Hepatitis B (HBsAg)'],
  ['URINE_DIP','Urine dipstick (protein)'],
];
// done = a result exists · sent = a request is with the lab · missing = neither
function firstLabState(W, anc, labs){
  const c1=(anc||[]).find(v=>String(v.contact_no)==='1')||null;
  const has=v=>v!==null&&v!==undefined&&v!=='';
  const done={
    BLOOD_GROUP_RH: has(W.blood_group)||has(W.rh_factor),
    HGB:            !!(c1&&has(c1.hgb)),
    HIV:            !!(c1&&has(c1.hiv_test_result)) || String(W.hiv_known_positive||'')==='1',
    SYPHILIS:       !!(c1&&has(c1.syphilis_result)),
    HBV:            !!(c1&&has(c1.hepb_result)),
    URINE_DIP:      !!(c1&&has(c1.urine_protein)),
  };
  const sent=code=>(labs||[]).some(l=>l.test_code===code);
  return FIRST_LABS.map(([code,label])=>({code,label,
    state: done[code] ? 'done' : (sent(code) ? 'sent' : 'missing')}));
}

// The HIV result on a past contact. If it is recorded, show it. If it is not — because the sample
// went to the lab and the result was not back on the day — offer the control that records it.
//
// P and N ONLY. anc_visits.hiv_test_result is CHAR(1) (MoH coding: P/N), so a two-letter value like
// "NT" would be silently TRUNCATED to "N" — turning "not tested" into "negative" in a woman's HIV
// record. Never offer a value the column cannot hold.
function hivCell(p){
  const r=String(p.hiv_test_result||'');
  if(r==='P') return '<span class="pill red">Positive</span>';
  if(r==='N') return '<span class="pill green">Negative</span>';
  if(r)       return esc(r);
  return `<select data-hiv="${p.id}" style="width:auto;min-width:118px">
      <option value="">— result pending —</option>
      <option value="N">Negative</option>
      <option value="P">Positive</option>
    </select>`;
}

// The ANC contact currently being CORRECTED (null when recording a new one). Same pattern as the
// newborn screen's EDIT_BABY, which already works.
let EDIT_ANC=null;
// The id map, declared ONCE and used by BOTH the prefill and the save, so the two can never drift.
const ANC_VALS={ cno:'contact_no', ga:'ga_weeks', wt:'weight_kg', bps:'bp_systolic', bpd:'bp_diastolic',
  fh:'fundal_height_cm', fhr:'fetal_heart_rate', pres:'presentation', up:'urine_protein', hb:'hgb',
  muac:'muac', fm:'fetal_movement', mal:'malaria_assessed', dn:'danger_note', us:'ultrasound_lt24w',
  syr:'syphilis_result', hbr:'hepb_result', tdn:'td_dose_no', ift:'ifa_tabs', htr:'hiv_test_result',
  vl:'viral_load', ifc2:'ifa_tabs_consumed', pal:'pallor', ugs:'urine_gramstain', ogt:'ogtt_result',
  mh:'mental_health', ipv:'ipv_screen', rmk:'remark' };
const ANC_TICKS={ syt:'syphilis_treated', hbt:'hepb_treated', hbp:'hepb_prophylaxis', dw:'deworming',
  hta:'hiv_test_accepted', hpc:'hiv_posttest_counselled', artc:'art_continued', artcl:'art_clinic_linked',
  cal:'calcium_given', and:'anti_d_given', c1:'cnsl_danger_signs', c2:'cnsl_nutrition', cl:'cnsl_lifestyle',
  cb:'cnsl_bpcr', c3:'cnsl_ecd', c4:'cnsl_infant_feeding', c5:'cnsl_family_planning' };
const ANC_ECS={ vd:'visit_date', na:'next_appointment', vld:'viral_load_date' };
// The one CSV tick group on the ANC contact. Saved as e.g. "alcohol,khat"; the ids are su_alcohol etc,
// so the "codes" here are the words, not numbers.
const ANC_CSVS={ su_:['substance_use',['none','alcohol','tobacco','khat','caffeine','other']] };

async function ancVisits(id){
  window._ancAck=false;                    // acknowledgement is per-open, never inherited from a prior patient
  const [past,e,labs]=await Promise.all([
    api('GET','anc_visits?episode='+id).catch(()=>[]),
    epOne(id),
    api('GET','labs?episode='+id).catch(()=>[])]);
  const nextNo=Math.min(8,(past||[]).filter(p=>/^\d+$/.test(String(p.contact_no||''))).length+1);
  const rhNeg=String(e.rh_factor||'').toLowerCase()==='neg';
  // "She was already on ART and then became pregnant" — she is not a testing candidate.
  const onART=(e.hiv_known_positive==1);
  const opt=(v,n,sel)=>`<option value="${v}"${String(sel)===String(v)?' selected':''}>${n}</option>`;

  app().innerHTML=nav()+`<div class="card"><h3>ANC contact — episode ${esc(id)}</h3>

   <div style="background:#e1f5ee;border:1px solid #5dcaa5;border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:13px;color:#04342c">
     <b>Carried forward from her record</b> &mdash; not re-asked here.
     Blood group: <b>${esc(e.blood_group||'—')}${e.rh_factor?(' '+(rhNeg?'negative':'positive')):''}</b> &middot;
     Booking GA: <b>${e.ga_first_contact?esc(e.ga_first_contact)+'w':'—'}</b>${e.late_anc_initiation==1?' <span style="color:#a32d2d">(late)</span>':''} &middot;
     HIV: <b>${e.hiv_known_positive==1?'known positive':'—'}</b> &middot; Target pop: <b>${esc(e.target_pop_code||'—')}</b>
     ${rhNeg?' <div style="margin-top:4px;color:#a32d2d"><b>Rh NEGATIVE</b> — Anti-D indicated if indirect Coombs negative.</div>':''}
     ${!e.blood_group?' <div style="margin-top:4px;color:#854f0b">Blood group / Rh not yet recorded — request it below and enter it on her record.</div>':''}
   </div>

   <div class="grid">
    ${ecPicker('vd','Visit date',true)}
    <label>ANC contact <span style="color:#a32d2d">*</span><select id="cno"><option value="">— select —</option>${[1,2,3,4,5,6,7,8].map(i=>opt(i,i+(['st','nd','rd'][i-1]||'th')+' contact (~'+ANC_SCHEDULE[i]+' wks)',nextNo)).join('')}<option value="unscheduled">Unscheduled</option></select></label>
    <label>GA (weeks) <span style="color:#a32d2d">*</span><input id="ga" type="number" min="4" max="45"></label>
    <label>Weight (kg) <span style="color:#a32d2d">*</span><input id="wt" type="number" step="0.1"></label>
    <label>BP systolic <span style="color:#a32d2d">*</span><input id="bps" type="number"></label>
    <label>BP diastolic <span style="color:#a32d2d">*</span><input id="bpd" type="number"></label>
    <label>MUAC (cm) <span style="color:#a32d2d">*</span><input id="muac" type="number" step="0.1"></label>
    <label>Fundal height (cm)<input id="fh" type="number"></label>
    <label>Fetal HR<input id="fhr" type="number"></label>
    <label>Presentation<input id="pres" placeholder="cephalic / breech / transverse"></label>
    <label>Pallor (palm &amp; conjunctiva)<select id="pal"><option value="">-</option><option value="pink">Pink</option><option value="pale">Pale</option></select></label>
    <label>Urine protein<select id="up"><option value="">Not done</option><option value="nil">Nil</option><option value="+">+</option><option value="++">++</option><option value="+++">+++</option></select></label>
    <label>Hgb (g/dl)<input id="hb" type="number" step="0.1"></label>
    <label>Fetal movement<select id="fm"><option value="">Not assessed</option><option value="normal">Normal</option><option value="reduced">Reduced</option><option value="absent">Absent</option></select></label>
    <label>Malaria assessed<select id="mal"><option value="">Not assessed</option><option value="no">No symptoms/risk</option><option value="yes">Symptoms/risk - test</option></select></label>
    ${ecPicker('na','Next appointment')}
   </div>
   <div id="ancderived"></div>
   <div id="ancdue" style="background:#eef6f5;border:1px solid #dbe7e4;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"></div>
   <label>Danger signs / note<input id="dn"></label>

   <details class="moh" open><summary>Tests, prophylaxis &amp; supplementation</summary><div class="grid">
    <label>Ultrasound within 24 wks GA<select id="us"><option value="">-</option><option value="Y">Yes</option><option value="N">No</option></select></label>
    <label>Syphilis test result<select id="syr"><option value="">-</option><option value="R">Reactive</option><option value="NR">Non-reactive</option><option value="ND">Not done</option></select></label>
    <label>Hepatitis B test result<select id="hbr"><option value="">-</option><option value="R">Reactive</option><option value="NR">Non-reactive</option><option value="ND">Not done</option></select></label>
    <label>Urine gram stain<select id="ugs"><option value="">-</option><option value="negative">Negative</option><option value="positive">Positive</option><option value="not_done">Not done</option></select></label>
    <label>OGTT (if high risk)<select id="ogt"><option value="">-</option><option value="normal">Normal</option><option value="gdm">Gestational diabetes</option><option value="not_done">Not done</option></select></label>
    <label>Td dose number<input id="tdn" type="number" min="1" max="5" placeholder="1-5"></label>
    <label>IFA tablets <b>provided</b><input id="ift" type="number" min="0" placeholder="tablets"></label>
    <label>IFA tablets <b>consumed</b> <span class="muted" style="font-weight:400">(adherence)</span><input id="ifc2" type="number" min="0" placeholder="tablets"></label>
   </div><div class="ticks">
    ${tick('cal','Calcium supplement given (1.5–2.0 g/day)')}${tick('syt','Syphilis treatment given')}${tick('hbt','Hep B treatment given')}${tick('hbp','Hep B prophylaxis given')}${tick('dw','Deworming given (after 1st trimester)')}${tick('and','Anti-D given (Rh negative)')}
   </div></details>

   ${e.hiv_known_positive==1?`
   <details class="moh" open><summary>HIV — <b>already on ART</b> <span class="muted">&mdash; no re-testing</span></summary>
    <div style="background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:9px 12px;margin-bottom:8px;font-size:13px">
      She is a <b>known HIV positive already on ART</b> (transferred from the ART clinic). She is not a testing candidate &mdash;
      this contact records <b>ART continuation and viral load</b>. Regimen: <b>${esc(e.art_regimen||'not recorded')}</b>.
    </div>
    <div class="grid">
     <label>Viral load<select id="vl">${selOpts([['suppressed','Suppressed'],['unsuppressed','Unsuppressed'],['pending','Pending'],['not_done','Not done']])}</select></label>
     ${ecPicker('vld','Viral load date')}
    </div>
    <div class="ticks">${tick('artc','ART continued at this contact')}</div>
    <div id="vlbox" style="display:none">
      <div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>UNSUPPRESSED viral load</b> &mdash; link her back to the ART clinic for adherence support and regimen review.</div>
      <div class="ticks">${tick('artcl','Linked back to ART clinic')}</div>
    </div></details>`:`
   <details class="moh"><summary>HIV</summary><div class="grid">
    <label>HIV test result<select id="htr"><option value="">-</option><option value="P">Positive</option><option value="N">Negative</option></select></label>
   </div><div class="ticks">
    ${tick('hta','HIV test accepted')}${tick('hpc','Result received with post-test counselling')}
   </div>
   <div class="muted" style="font-size:12px;margin-top:6px">If she is already known positive and on ART, mark that on her record &mdash; this block will then switch to ART continuation instead of testing.</div></details>`}

   <details class="moh"><summary>Mental health, safety &amp; substance use <span class="muted">&mdash; Guideline Box 3</span></summary><div class="grid">
    <label>Mental health<select id="mh"><option value="">Not assessed</option><option value="normal">No concern</option><option value="concern">Concern identified</option><option value="referred">Referred</option><option value="declined">Declined</option></select></label>
    <label>Intimate partner violence<select id="ipv"><option value="">Not assessed</option><option value="no">No</option><option value="disclosed">Disclosed</option><option value="referred">Referred</option><option value="declined">Declined to answer</option></select></label>
   </div>
   <div class="muted" style="font-size:12px;margin-top:6px">Substance use — tick all that apply:</div>
   <div class="ticks">${tick('su_none','None')}${tick('su_alcohol','Alcohol')}${tick('su_tobacco','Tobacco')}${tick('su_khat','Khat')}${tick('su_caffeine','Heavy caffeine')}${tick('su_other','Other')}</div>
   <div class="muted" style="font-size:12px;margin-top:6px">Ask these in private. If IPV is disclosed, follow the facility referral pathway &mdash; do not record details here.</div></details>

   <details class="moh"><summary>Counselling provided at this contact</summary><div class="ticks">
    ${tick('c1','Danger signs')}${tick('c2','Maternal nutrition')}${tick('cl','Lifestyle modification')}${tick('cb','Birth preparedness &amp; complication readiness')}${tick('c3','Early childhood development')}${tick('c4','Breast / infant feeding')}${tick('c5','Family planning')}
   </div></details>

   <div id="firstlabs"></div>

   <details class="moh"><summary>Laboratory — requests &amp; results</summary>
    <div class="muted" style="font-size:12px;margin-bottom:6px">Request a test now; enter the result here or at a later contact.</div>
    <div class="grid">
     <label>Request test<select id="labt"><option value="">— select —</option>${LAB_TESTS.map(t=>`<option value="${t[0]}">${t[1]}</option>`).join('')}</select></label>
     <label>&nbsp;<button class="sec" id="labadd" type="button">Add request</button></label>
    </div>
    <table id="labtbl" style="font-size:12px"><tr><th>Test</th><th>Requested</th><th>Result</th><th></th></tr>
    ${(labs||[]).map(l=>`<tr><td>${esc((LAB_TESTS.find(t=>t[0]===l.test_code)||[,l.test_code])[1])}</td><td>${esc(l.requested_date||'')}</td>
      <td><input data-lab="${l.id}" value="${esc(l.result||'')}" placeholder="enter result" style="font-size:12px"></td>
      <td><button class="sec" data-labsave="${l.id}" type="button" style="font-size:12px;padding:3px 8px">Save</button></td></tr>`).join('')
      ||'<tr><td colspan=4 class=muted>No tests requested yet.</td></tr>'}
    </table></details>

   <label>Remark<input id="rmk" placeholder="appointment or anything not covered above"></label>
   <div id="ancreqbox" style="display:none;background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"></div>
   <button class="act" id="asave" style="margin-top:10px">${EDIT_ANC?'Save the correction':'Save contact'}</button>
   ${EDIT_ANC?'<button class="sec" id="acancel" style="margin-top:10px;margin-left:6px">Cancel</button>':''}
   <span class="muted" id="am"></span></div>
   <div class="card"><h3>Previous contacts</h3><table><tr><th>Date</th><th>#</th><th>GA</th><th>Wt</th><th>BP</th><th>MUAC</th><th>Hb</th><th>Anaemia</th><th>HIV result</th><th>Next</th><th></th></tr>
    ${past.map(p=>`<tr${EDIT_ANC&&String(EDIT_ANC.id)===String(p.id)?' style="background:#fff8e6"':''}><td>${esc(p.visit_date||'')}</td><td>${esc(p.contact_no||'')}</td><td>${esc(p.ga_weeks||'')}</td><td>${esc(p.weight_kg||'')}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.muac||'')}${p.muac_flag==1?' <span class="pill amber">&lt;23</span>':''}</td><td>${esc(p.hgb||'')}</td><td>${p.anaemia_grade&&p.anaemia_grade!=='normal'?('<span class="pill amber">'+esc(p.anaemia_grade)+'</span>'):esc(p.anaemia_grade||'')}</td>
      <td>${hivCell(p)}</td>
      <td>${esc(p.next_appointment||'')}</td>
      <td>${canDo('anc')?`<button class="sm" data-editanc="${p.id}">Correct</button>`:''}</td></tr>`).join('')||'<tr><td colspan=11 class=muted>No contacts yet.</td></tr>'}
   </table>
   <p class="muted" style="font-size:12px">A test sent to the lab has no result on the day. Record it here when it comes back &mdash; it updates <b>this</b> contact, and a positive result puts her on the high-risk worklist and into PMTCT.<br>
   Use <b>Correct</b> to fix a value that was written down wrong. It updates the contact &mdash; it does not create a second one.</p></div>`;

  // ---- THE MANDATORY FIRST-CONTACT LABORATORY PANEL ----------------------------------------
  // Rendered from what is STORED (her blood group, contact 1, the lab requests), and refreshed when
  // the provider fills a result in on this screen, so it always reflects the truth in front of her.
  const paintFirstLabs=()=>{
    const box=$('#firstlabs'); if(!box) return;
    // fold the values being typed right now into the picture — she should not be told a test is
    // missing while she is looking at the result she has just entered.
    const liveC1 = (+((cno||{}).value)===1) ? {
      contact_no:'1', hgb:(hb||{}).value, hiv_test_result:(htr||{}).value,
      syphilis_result:(syr||{}).value, hepb_result:(hbr||{}).value, urine_protein:(up||{}).value
    } : null;
    const rows=(past||[]).slice();
    if(liveC1){ const i=rows.findIndex(v=>String(v.contact_no)==='1'); if(i>=0) rows[i]={...rows[i],...liveC1}; else rows.push(liveC1); }
    const st=firstLabState(e||{}, rows, labs||[]);   // `e` is the episode row, which carries her woman-level fields
    const missing=st.filter(s=>s.state==='missing');
    const isFirst = (+((cno||{}).value)===1) || !(past||[]).some(v=>String(v.contact_no)==='1');
    if(!isFirst && !missing.length){ box.innerHTML=''; return; }   // nothing to say at a later contact once they are done
    const pill=s=> s.state==='done' ? '<span class="pill green">Result recorded</span>'
                 : s.state==='sent' ? '<span class="pill amber">Sent to the lab</span>'
                 : '<span class="pill red">Not done</span>';
    box.innerHTML=`<div class="card" style="margin:10px 0;padding:12px 14px;${missing.length?'border-left:4px solid #a32d2d':''}">
      <h4 style="margin:0 0 4px;font-size:14px">First-contact laboratory panel</h4>
      <p class="muted" style="font-size:12px;margin:0 0 8px">The National ANC Guideline requires these at the first contact. They decide the rest of her pregnancy &mdash; a reactive syphilis to treat, an HIV result that opens PMTCT, a Rh-negative blood group that needs anti-D at 28 weeks, an anaemia to correct before she reaches labour.</p>
      <div class="rec-g">${st.map(s=>`<div class="rec-f"><span class="rec-l">${esc(s.label)}</span><span>${pill(s)}</span></div>`).join('')}</div>
      ${missing.length?`<div style="margin-top:8px">
        <button class="sec" id="labsendall" type="button">Send the ${missing.length} outstanding test${missing.length===1?'':'s'} to the lab</button>
        <span class="muted" style="font-size:12px;margin-left:6px">Records the request now; enter the result here when it comes back.</span>
      </div>`:''}
    </div>`;
    const sb=$('#labsendall');
    if(sb) sb.onclick=async()=>{
      sb.disabled=true;
      const today=new Date().toISOString().slice(0,10);
      for(const m of missing){
        await api('POST','labs',{episode_id:+id,test_code:m.code,requested:1,requested_date:today}).catch(()=>{});
      }
      toast('Requested: '+missing.map(m=>m.label).join(', '),'ok');
      setTimeout(()=>ancVisits(id),600);
    };
  };
  ['hb','htr','syr','hbr','up','cno'].forEach(k=>{ const el=$('#'+k); if(el){ el.addEventListener('change',paintFirstLabs); el.addEventListener('input',paintFirstLabs); } });
  paintFirstLabs();

  // ---- CORRECT A PAST CONTACT --------------------------------------------------------------
  // Until now a wrong BP, weight, GA, Td dose or counselling tick recorded at contact 2 could not be
  // corrected anywhere in the tool. The only editable thing on this whole screen was the HIV result.
  document.querySelectorAll('#app button[data-editanc]').forEach(b=>b.onclick=()=>{
    EDIT_ANC=(past||[]).find(x=>String(x.id)===String(b.dataset.editanc))||null;
    ancVisits(id);
  });
  const ac=$('#acancel'); if(ac) ac.onclick=()=>{ EDIT_ANC=null; ancVisits(id); };
  if(EDIT_ANC){
    fillVals(EDIT_ANC, ANC_VALS);
    fillTicks(EDIT_ANC, ANC_TICKS);
    fillEcs(EDIT_ANC, ANC_ECS);
    // substance_use is a CSV tick group and was NOT restored — so correcting any other field on the
    // contact silently erased a recorded alcohol / tobacco / khat disclosure.
    fillCsvTicks(EDIT_ANC, ANC_CSVS);
    const box=$('#ancreqbox');
    if(box){ box.style.display=''; box.style.background='#fff8e6'; box.style.borderColor='#ef9f27'; box.style.color='#633806';
      box.innerHTML='<b>Correcting the contact of '+esc(EDIT_ANC.visit_date||'')+'.</b> Saving will UPDATE that contact, not add a new one.'; }
  }

  // ---- LATE RESULTS -------------------------------------------------------------------------
  // An HIV test sent to the lab does not come back the same day in most facilities. The result was
  // recorded on the visit row and NOTHING happened: the linkage that sets women.hiv_known_positive
  // ran on POST only, so a result entered later never reached it. She stayed off the high-risk
  // worklist, was re-offered a test at her next contact, and no PMTCT prompt fired. She could not
  // even be corrected — no screen called the PATCH route at all.
  document.querySelectorAll('#app select[data-hiv]').forEach(sel=>sel.onchange=async()=>{
    const vid=sel.dataset.hiv, val=sel.value;
    if(!val) return;
    if(val==='P' && !confirm('Record a POSITIVE HIV result for this contact?\n\nShe will be flagged high-risk and enrolled in the PMTCT pathway.')){ sel.value=''; return; }
    sel.disabled=true;
    const r=await api('PATCH','anc_visits/'+vid,{hiv_test_result:val});
    if(r&&(r.ok||r.queued)){
      toast(val==='P' ? 'Positive recorded — she is now flagged high-risk and linked to PMTCT' : 'Result recorded','ok');
      ancVisits(id);
    } else { sel.disabled=false; toast((r&&r.error)||'Could not save the result'); }
  });

  // ---- derived clinical classification, shown live and stored on save ----
  const showDerived=()=>{
    const hb=+hb_.value||null, mu=+muac.value||null, wtv=+wt.value||null;
    const bmi=bmiCalc(wtv,e.height_cm); const g=anaemiaGrade(hb);
    let out='';
    if(g&&g!=='normal') out+=`<div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">${esc(anaemiaAction(g))}</div>`;
    else if(g==='normal') out+=`<div style="background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">${esc(anaemiaAction(g))}</div>`;
    if(muacFlag(mu)) out+=`<div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">MUAC ${mu} cm — ACUTE MALNUTRITION (&lt;23 cm). Treat per the national protocol and counsel on nutrition.</div>`;
    // BMI IS COMPUTED, NEVER TYPED — from THIS visit's weight and the height on her record. Show it
    // the moment both exist, and say plainly when it cannot be computed. Previously a missing height
    // just made the BMI box silently absent, so the provider had no idea why, and no idea that the
    // BMI risk factor was going unassessed at every single contact.
    if(bmi){ const f=bmiFlag(bmi);
      out+=`<div style="background:${f==='normal'?'#e1f5ee':'#faeeda'};border:1px solid ${f==='normal'?'#5dcaa5':'#ef9f27'};color:${f==='normal'?'#04342c':'#633806'};border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">BMI <b>${bmi}</b> &mdash; ${f}${f!=='normal'?' (a high-risk condition, Guideline Table 4)':''}. <span class="muted">Calculated from this weight (${wtv} kg) and her recorded height (${e.height_cm} cm).</span></div>`; }
    else if(wtv && !e.height_cm)
      out+=`<div style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">BMI cannot be calculated &mdash; <b>her height is not on her record</b>. BMI is a high-risk condition (Guideline Table 4) and is going unassessed at every contact. Add her height on her record (Edit her details).</div>`;
    else if(wtv && e.height_cm && rangeError('height_cm', e.height_cm))
      // Her stored height is impossible (there are such rows in the live data). Say so, rather than
      // printing a BMI of 198 as though it were a finding.
      out+=`<div style="background:#fcebeb;border:1px solid #d13b3b;color:#791f1f;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">BMI cannot be calculated &mdash; <b>her recorded height of ${esc(e.height_cm)} cm is not possible</b>, so it was almost certainly mistyped. Please correct it on her record (Edit her details). Until then her BMI risk factor cannot be assessed.</div>`;
    // ---- THE ALERTS THIS SCREEN NEVER HAD ----
    // Until now the ANC contact screen warned about anaemia, MUAC and BMI and NOTHING ELSE.
    // A blood pressure of 170/115 with ++ proteinuria was written to the database in silence:
    // no warning here, and no entry on the high-risk worklist either.
    ancAlerts().forEach(a=>{ out+=alertBox(a[0],a[1],a[2]); });
    $('#ancderived').innerHTML=out;
  };
  // Returns [tone,title,text] for everything dangerous on this form.
  const ancAlerts=()=>{
    const A=[];
    const s=+bps.value||null, d=+bpd.value||null, up=(upEl?upEl.value:'')||'';
    // ANY dipstick positive (+, ++, +++) is proteinuria. Diagnostic pre-eclampsia is BP >=140/90
    // WITH proteinuria >=1+. The old test (/\+\+/) required ++, so a woman at 148/96 with a single +
    // showed only "raised BP" and never reached the high-risk worklist — pre-eclampsia missed.
    const proteinuria = up==='+' || up==='++' || up==='+++';
    const sev = (s&&s>=160) || (d&&d>=110);
    const raised = (s&&s>=140) || (d&&d>=90);
    if(sev && proteinuria) A.push(['red','SEVERE PRE-ECLAMPSIA','BP '+(s||'?')+'/'+(d||'?')+' with '+esc(up)+' proteinuria. This is an obstetric emergency. Give magnesium sulphate and an antihypertensive per protocol, and refer to a facility that can deliver her — <b>today</b>.']);
    else if(sev) A.push(['red','SEVERE HYPERTENSION','BP '+(s||'?')+'/'+(d||'?')+' — at or above 160/110. Treat and refer urgently. Check for proteinuria and for symptoms of imminent eclampsia (headache, visual disturbance, epigastric pain).']);
    else if(raised && proteinuria) A.push(['red','PRE-ECLAMPSIA','BP '+(s||'?')+'/'+(d||'?')+' with '+esc(up)+' proteinuria. Refer for assessment and plan delivery. Monitor closely.']);
    else if(raised) A.push(['amber','Raised blood pressure','BP '+(s||'?')+'/'+(d||'?')+'. Repeat after rest, check urine protein, and review at every contact. Calcium supplementation is indicated.']);
    else if(proteinuria) A.push(['amber','Proteinuria','Urine protein '+esc(up)+' with a normal BP. Recheck the BP, exclude urinary infection, and review at the next contact.']);
    // FHR 0 means NO FETAL HEART HEARD. `+fhr.value||null` turned that into "not assessed" and the
    // `if(f && ...)` guard then skipped the alert entirely - the single most important thing this screen
    // can find, and it was silent.
    const f=numOrNull(fhr.value);
    if(f===0) A.push(['red','NO FETAL HEART HEARD','No fetal heart rate detected. Confirm now with a second method (Doppler/ultrasound if available). If the fetal heart is genuinely absent this may be an intrauterine fetal death — refer urgently and do not send her home.']);
    else if(f && (f<110||f>160)) A.push([(f<100||f>180)?'red':'amber','Abnormal fetal heart rate',f+' bpm (normal 110–160). '+((f<100||f>180)?'This is severely abnormal — reassess immediately and refer.':'Reassess after rest and repeat. If it persists, refer.')]);
    const fmv=(fmEl?fmEl.value:'');
    if(fmv==='absent') A.push(['red','No fetal movement','She reports NO fetal movements. Confirm the fetal heart immediately. If absent, refer urgently.']);
    else if(fmv==='reduced') A.push(['amber','Reduced fetal movement','Reduced fetal movement — check the fetal heart rate and arrange further assessment. Do not send her home without a plan.']);
    return A;
  };
  const hb_=$('#hb'), upEl=$('#up'), fmEl=$('#fm');
  ['hb','muac','wt','bps','bpd','fhr'].forEach(k=>{const el=$('#'+k); if(el){el.addEventListener('input',showDerived);}});
  ['up','fm'].forEach(k=>{const el=$('#'+k); if(el){el.addEventListener('change',showDerived); el.addEventListener('input',showDerived);}});

  // ---- what this contact requires (Guideline Table 5) ----
  const showDue=()=>{ const n=+cno.value; const box=$('#ancdue');
    if(!n||!ANC_CONTACT_ACTIONS[n]){ box.style.display='none'; return; }
    box.style.display='';
    box.innerHTML='<b>Contact '+n+' (~'+ANC_SCHEDULE[n]+' weeks) — the guideline requires:</b><ul style="margin:4px 0 0;padding-left:18px">'+ANC_CONTACT_ACTIONS[n].map(a=>'<li>'+a+'</li>').join('')+'</ul>';
  };
  cno.addEventListener('change',showDue); showDue(); showDerived();
  // Unsuppressed viral load must trigger linkage back to the ART clinic.
  if(onART){ const vlEl=$('#vl'); if(vlEl) vlEl.addEventListener('change',()=>{ $('#vlbox').style.display=(vlEl.value==='unsuppressed')?'':'none'; }); }

  // ---- laboratory requests & results ----
  $('#labadd').onclick=async()=>{ if(!labt.value) return;
    const r=await api('POST','labs',{episode_id:+id,test_code:labt.value,requested:1,requested_date:ecGet('vd')||localDate()});
    if(r&&(r.ids||r.queued)){ toast('Test requested','ok'); ancVisits(id); } };
  document.querySelectorAll('[data-labsave]').forEach(b=>{ b.onclick=async()=>{ const lid=b.dataset.labsave;
    const inp=document.querySelector('[data-lab="'+lid+'"]');
    const r=await api('PATCH','labs/'+lid,{result:inp.value,result_date:localDate()});
    if(r&&(r.ok||r.queued)) toast('Result saved','ok'); }; });

  // ---- MANDATORY fields (collaborator request; guideline requires these every contact) ----
  const REQ=[['vd','Visit date'],['cno','ANC contact number'],['ga','Gestational age'],['wt','Weight'],['bps','BP systolic'],['bpd','BP diastolic'],['muac','MUAC']];
  const missing=()=>REQ.filter(([k])=> k==='vd' ? !ecGet('vd') : !($('#'+k)&&$('#'+k).value));

  $('#asave').onclick=async()=>{
    const miss=missing();
    if(miss.length){ $('#ancreqbox').style.display='';
      $('#ancreqbox').textContent='Required: '+miss.map(m=>m[1]).join(', ')+'. The guideline requires blood pressure, weight and MUAC at every contact.';
      modal('Contact incomplete','These required fields are missing: '+miss.map(m=>m[1]).join(', ')+'.\n\nThe National ANC Guideline requires blood pressure, weight and MUAC to be measured at every contact.','risk');
      return; }
    $('#ancreqbox').style.display='none';

    // THE FIRST-CONTACT LABS. She is told once, and then she may save. The lab is sometimes shut and
    // the reagent is sometimes out — a provider who cannot record the contact because of a test she
    // cannot do today will go back to paper, and then the tool has cost the woman her record.
    if(+cno.value===1 && !window._ancLabAck){
      const st=firstLabState(e||{}, [{contact_no:'1',hgb:hb.value,hiv_test_result:htr.value,syphilis_result:syr.value,hepb_result:hbr.value,urine_protein:up.value}], labs||[]);
      const missLab=st.filter(s=>s.state==='missing');
      if(missLab.length){
        window._ancLabAck=true;
        modal('First-contact tests outstanding',
          'These are required at the first contact and are not recorded: <b>'+missLab.map(m=>esc(m.label)).join(', ')+'</b>.<br><br>'+
          'If the lab can do them, send them now — the button on the panel records the request in one tap. If it cannot, save the contact and record the results when they come back.<br><br>'+
          '<i>Press Save again to record the contact.</i>','risk');
        return;
      }
    }
    // RANGE CHECK BEFORE THE CLINICAL ALERTS. A mistyped number must not be allowed to raise a red
    // flag — a BP of 1480/96 is a slip, not severe hypertension, and alerting on it teaches the
    // provider to dismiss alerts.
    if(!checkRanges([['ga','ga_weeks'],['wt','weight_kg'],['bps','bp_systolic'],['bpd','bp_diastolic'],
                     ['fh','fundal_height'],['fhr','fetal_heart'],['hb','hgb'],['muac','muac'],
                     ['ift','ifa_tabs'],['ifc2','ifa_tabs'],['tdn','td_dose']])) return;
    // A RED FLAG MUST BE SEEN. This contact used to save silently, whatever the numbers were.
    // The record still saves — refusing to save clinical data would be worse — but the provider
    // cannot get past it without reading it.
    const reds=ancAlerts().filter(a=>a[0]==='red');
    if(reds.length && !window._ancAck){
      window._ancAck=true;
      modal(reds[0][1], reds.map(a=>'<b>'+a[1]+'</b><br>'+a[2]).join('<br><br>')+'<br><br><i>Press Save again to record this contact.</i>','risk');
      return; }
    window._ancAck=false;
    const b=$('#asave'); b.disabled=true;
    try{
      const su=['none','alcohol','tobacco','khat','caffeine','other'].filter(s=>tk('su_'+s)).join(',')||null;
      const hbv=+hb_.value||null, muv=+muac.value||null, wtv=+wt.value||null;
      // CORRECTING an existing contact PATCHes it. Recording a new one POSTs. Without this, fixing a
      // wrong BP meant adding a SECOND contact for the same day — inflating the ANC contact count and
      // leaving both the wrong value and the right one on her record.
      const editing = EDIT_ANC && EDIT_ANC.id;
      const r=await api(editing?'PATCH':'POST', editing?('anc_visits/'+EDIT_ANC.id):'anc_visits',
        {episode_id:+id,visit_date:ecGet('vd'),contact_no:(cno.value||null),ga_weeks:+ga.value||null,weight_kg:wtv,bp_systolic:+bps.value||null,bp_diastolic:+bpd.value||null,fundal_height_cm:+fh.value||null,fetal_heart_rate:numOrNull(fhr.value),presentation:pres.value,urine_protein:up.value,hgb:hbv,muac:muv,fetal_movement:(fm.value||null),malaria_assessed:(mal.value||null),danger_note:dn.value,next_appointment:ecGet('na'),
    ultrasound_lt24w:(us.value||null),syphilis_result:(syr.value||null),syphilis_treated:tk('syt'),hepb_result:(hbr.value||null),hepb_treated:tk('hbt'),hepb_prophylaxis:tk('hbp'),td_dose_no:(+tdn.value||null),ifa_tabs:numOrNull(ift.value),deworming:tk('dw'),
    // A woman already on ART is not re-tested — that block is replaced by ART continuation.
    hiv_test_accepted:(onART?null:tk('hta')),hiv_test_result:(onART?null:(htr.value||null)),hiv_posttest_counselled:(onART?null:tk('hpc')),
    art_continued:(onART?tk('artc'):null),viral_load:(onART?(vl.value||null):null),viral_load_date:(onART?(ecGet('vld')||null):null),
    art_clinic_linked:((onART&&vl.value==='unsuppressed')?tk('artcl'):null),
    calcium_given:tk('cal'),ifa_tabs_consumed:numOrNull(ifc2.value),anti_d_given:tk('and'),pallor:(pal.value||null),urine_gramstain:(ugs.value||null),ogtt_result:(ogt.value||null),
    mental_health:(mh.value||null),ipv_screen:(ipv.value||null),substance_use:su,
    cnsl_danger_signs:tk('c1'),cnsl_nutrition:tk('c2'),cnsl_lifestyle:tk('cl'),cnsl_bpcr:tk('cb'),cnsl_ecd:tk('c3'),cnsl_infant_feeding:tk('c4'),cnsl_family_planning:tk('c5'),remark:rmk.value,
    bmi:bmiCalc(wtv,e.height_cm),anaemia_grade:(anaemiaGrade(hbv)||null),muac_flag:(muv?(muacFlag(muv)?1:0):null)});
    // Contact 1 IS the booking contact: its GA is the booking GA. Store it once on the
    // woman so it survives even when later contacts are entered out of order.
    // NOTE the success test: a PATCH returns {ok:true} and NO ids, so keying this on `r.ids` alone
    // would mean CORRECTING contact 1's GA silently left her booking GA — and therefore her
    // late-initiation flag, and the GA fed to the model — on the old, wrong value.
    if(r&&(r.ids||r.ok)&&String(cno.value)==='1'&&+ga.value){
      const ep=await epOne(id);
      if(ep&&ep.woman_id){ await api('PATCH','women/'+ep.woman_id,{ga_first_contact:+ga.value,first_contact_date:ecGet('vd'),late_anc_initiation:lateAnc(ga.value)?1:0}).catch(()=>{}); }
      const msg=gaRisk(ga.value); if(msg) modal('Late ANC initiation',msg,'risk');
    }
    // A PATCH returns {ok:true}, a POST returns {ids:[...]} — accept either as success.
    const ok = r && (r.ids || r.ok || r.queued);
    $('#am').textContent = ok ? (editing?' corrected':' saved') : (' '+((r&&r.error)||'error'));
    if(ok && !r.queued){ EDIT_ANC=null; setTimeout(()=>ancVisits(id),500); }
    } finally{ b.disabled=false; } };
}

let EDIT_PNC=null;                         // the PNC visit being corrected, or null when recording a new one
const PNC_VALS={ mt:'m_temp', bps:'m_bp_systolic', bpd:'m_bp_diastolic', pl:'m_pulse', bl:'bleeding',
  br:'breast', md:'mood', ut:'uterine_tone', pw:'perineum', mbf:'mother_breastfeeding', ppf:'pp_fp',
  ifc:'ifa_continued', nt:'nb_temp', nf:'nb_feeding', cd:'cord', ncv:'nb_convulsions',
  nfb:'nb_fast_breathing', nci:'nb_chest_indrawing', nlt:'nb_lethargy', njd:'nb_jaundice',
  nkmc:'nb_kmc', nimm:'nb_immunization', neid:'nb_eid', dn:'danger_note', pbaby:'baby_id',
  vp:'visit_period', mc:'maternal_condition', ooc:'other_obs_complication', phtr:'hiv_test_result',
  nwt:'nb_weight_g', npo:'nb_problem_other', nto:'nb_treatment_outcome',
  // THESE FIVE WERE MISSING, AND THE SAVE SENDS THE WHOLE ROW. So pressing Correct to fix a mistyped
  // temperature re-rendered them blank and wrote NULL over them — including, on a visit where the
  // baby had died, the recorded cause of death. Correcting a record must never destroy the rest of it.
  ndd:'nb_death_age_days', ndc:'nb_death_cause',
  pacc:'ippfp_acceptor', pmth:'ippfp_method', prmk:'remark' };
const PNC_TICKS={ ppph:'pph', phta:'hiv_test_accepted', phrt:'hiv_retest_accepted',
  pc1:'cnsl_danger_signs', pc2:'cnsl_breastfeeding', pc3:'cnsl_newborn_care',
  pc4:'cnsl_family_planning', pc5:'cnsl_epi', pc6:'cnsl_ecd' };
const PNC_ECS={ vd:'visit_date' };
// The comma-separated MoH tick groups, which a correction also used to wipe.
const PNC_CSVS={ np:['nb_problems',[1,2,3,4,5,6,7,8,9,10,11]], nt:['nb_treatment',[1,2,3,4,5,6]] };

async function pncVisits(id){
  window._pncAck=false;                    // acknowledgement is per-open, never inherited from a prior patient
  const [past,delv,bbs,WP]=await Promise.all([api('GET','pnc_visits?episode='+id).catch(()=>[]),api('GET','delivery?episode='+id).catch(()=>[]),api('GET','babies?episode='+id).catch(()=>[]),epOne(id)]);
  const dv=(delv&&delv[0])||null;
  app().innerHTML=nav()+`<div class="card"><h3>PNC follow-up visit — episode ${esc(id)}</h3>
   ${carryForward(WP,String(WP.rh_factor||'').toLowerCase()==='neg')}
   <div style="background:#e9f8f4;border-radius:10px;padding:8px 12px;margin-bottom:10px">
     <b>Delivery report</b> ${dv?('&middot; '+esc(dv.delivery_datetime||'')+' &middot; mode '+esc(dv.mode||'?')+' &middot; outcome '+esc(((bbs||[]).map(b=>b.outcome).filter(Boolean).join(', '))||'—')+' &middot; mother '+esc(dv.maternal_status||dv.maternal_outcome||'?')):'<span class="muted">no delivery recorded yet</span>'}
     <div style="margin-top:4px"><b>Newborn record(s)</b> ${(bbs&&bbs.length)?bbs.map(b=>('#'+esc(b.birth_order||'?')+' '+esc(b.sex||'')+' '+esc(b.weight_g||'?')+'g Apgar '+esc(b.apgar_1min||'?')+'/'+esc(b.apgar_5min||'?')+' '+esc(b.outcome||''))).join(' &middot; '):'<span class="muted">no newborn record yet</span>'}</div>
   </div>
   <details class="moh" ${(WP.place_of_delivery&&WP.infant_dob)?'':'open'}><summary>PNC identification <span class="muted">&mdash; MoH PNC register items 6 &amp; 7</span></summary>
    <div class="muted" style="font-size:12px;margin-bottom:6px">${dv?'She delivered in this facility — both are filled in from the delivery record. Change them only if she delivered elsewhere.':'No delivery recorded here — record where she gave birth and the infant&rsquo;s date of birth.'}</div>
    <div class="grid">
     <label>Place of delivery<select id="pod">${selOpts([['1','1. Same facility'],['2','2. Other facility'],['3','3. Home']], WP.place_of_delivery || (dv?'1':''))}</select></label>
     ${ecPicker('idob','Infant&rsquo;s date of birth', false, (WP.infant_dob || (dv&&dv.delivery_datetime ? String(dv.delivery_datetime).slice(0,10) : null)) || undefined)}
    </div></details>

   <h4>Mother</h4><div class="grid">
    ${ecPicker('vd','Visit date',true)}
    <label>Visit period <span class="muted" style="font-weight:400">(MoH)</span><select id="vp">${selOpts([['24h','Within 24 hrs'],['25-48h','25-48 hrs'],['49-72h','49-72 hrs'],['73h-7d','73 hrs - 7 days'],['8-42d','8-42 days']])}</select></label>
    <label>Maternal condition<select id="mc">${selOpts([['1','1. Normal'],['2','2. Complicated and managed'],['3','3. Complicated and referred'],['4','4. Died']])}</select></label>
    <label>Other obstetric complication<select id="ooc">${selOpts([['PE','PE — pre-eclampsia'],['E','E — eclampsia'],['SEP','SEP — sepsis'],['OTH','OTH — other']])}</select></label>
    <label>Temp °C<input id="mt" type="number" step="0.1"></label>
    <label>BP systolic<input id="bps" type="number"></label>
    <label>BP diastolic<input id="bpd" type="number"></label>
    <label>Pulse<input id="pl" type="number"></label>
    <label>Lochia<select id="bl"><option value="normal">Normal</option><option value="heavy">Heavy</option><option value="offensive">Offensive / foul-smelling</option></select></label>
    <label>Breasts<select id="br"><option value="normal">Normal</option><option value="engorged">Engorged</option><option value="cracked">Cracked nipples</option><option value="mastitis">Mastitis</option></select></label>
    <label>Mood<select id="md"><option value="normal">Normal</option><option value="low">Low mood</option><option value="support">Needs support</option></select></label>
    <label>Uterine tone<select id="ut"><option value="">Not assessed</option><option value="firm">Firm</option><option value="atonic">Atonic</option></select></label>
    <label>Perineum / wound<select id="pw"><option value="">Not assessed</option><option value="normal">Normal</option><option value="infected">Infected</option></select></label>
    <label>Breastfeeding (mother)<select id="mbf"><option value="">-</option><option value="exclusive">Exclusive</option><option value="mixed">Mixed</option><option value="none">Not breastfeeding</option></select></label>
    <label>Postpartum FP<select id="ppf"><option value="">-</option><option value="method">Method chosen</option><option value="counselled">Counselled</option><option value="declined">Declined</option></select></label>
    <label>Iron-folic acid continued<select id="ifc"><option value="">-</option><option value="yes">Yes</option><option value="no">No</option></select></label>
   </div><h4>Newborn</h4>
   <div class="muted" style="font-size:12px;margin-bottom:6px">PNC is for the mother <b>and</b> the newborn. Each assessment below is recorded against a specific baby, so every infant (including each twin) can be followed across the five contacts.</div>
   <div class="grid">
    <label>Which newborn?<select id="pbaby"><option value="">— select the baby —</option>${(bbs||[]).map(b=>`<option value="${b.id}">#${esc(b.birth_order||'?')} ${esc(b.sex||'')} ${esc(b.weight_g||'?')}g${b.prob_lbw==1?' (LBW)':''}</option>`).join('')}</select></label>
    <label>Temp °C<input id="nt" type="number" step="0.1"></label>
    <label>Breastfeeding<select id="nf"><option value="well">Feeding well</option><option value="difficulty">Difficulty</option><option value="none">Not feeding</option></select></label>
    <label>Cord<select id="cd"><option value="clean">Clean &amp; dry</option><option value="infected">Red / discharging</option><option value="bleeding">Bleeding</option></select></label>
    <label>Convulsions<select id="ncv"><option value="no">No</option><option value="yes">Yes</option></select></label>
    <label>Fast breathing<select id="nfb"><option value="no">No</option><option value="yes">Yes</option></select></label>
    <label>Chest indrawing<select id="nci"><option value="no">No</option><option value="yes">Yes</option></select></label>
    <label>Lethargic<select id="nlt"><option value="no">No</option><option value="yes">Yes</option></select></label>
    <label>Severe jaundice<select id="njd"><option value="no">No</option><option value="yes">Yes</option></select></label>
    <label>KMC (if LBW)<select id="nkmc"><option value="">N/A</option><option value="initiated">Initiated</option><option value="not">Not</option></select></label>
    <label>Birth immunisation<select id="nimm"><option value="">-</option><option value="given">BCG/OPV-0 given</option><option value="not">Not given</option></select></label>
    <label>EID (HIV-exposed)<select id="neid"><option value="">N/A</option><option value="taken">Sample taken</option><option value="not">Not taken</option></select></label>
    <label>Newborn weight (g)<input id="nwt" type="number" placeholder="grams"></label>
   </div><label>Danger signs / note<input id="dn"></label>
   <div id="pncalerts"></div>

   <details class="moh" open><summary>Newborn assessment <span class="muted">&mdash; MoH PNC register</span></summary>
    <div class="muted" style="font-size:12px;margin-bottom:6px">Problem identified &mdash; tick all that apply.</div>
    <div class="ticks">
     ${[[1,'Normal'],[2,'Prematurity'],[3,'Sepsis / VSD'],[4,'Respiratory distress'],[5,'Perinatal asphyxia'],[6,'Low birth weight'],[7,'Congenital malformation'],[8,'Absence of reflex'],[9,'Jaundice'],[10,'Head circumference &lt;33cm'],[11,'Other']].map(([c,n])=>tick('np'+c,n)).join('')}
    </div>
    <label>If other, specify<input id="npo"></label>
    <div class="muted" style="font-size:12px;margin:8px 0 6px">Treatment given &mdash; tick all that apply.</div>
    <div class="ticks">
     ${[[1,'Oxygen resuscitation'],[2,'KMC'],[3,'Antibiotic'],[4,'Chlorhexidine'],[5,'Blood transfusion'],[6,'Other']].map(([c,n])=>tick('nt'+c,n)).join('')}
    </div>
    <div class="grid" style="margin-top:8px">
     <label>Treatment outcome<select id="nto">${selOpts([['1','1. Improved'],['2','2. No change'],['3','3. Died'],['4','4. Referral'],['5','5. Unknown'],['6','6. Resuscitated and survived']])}</select></label>
     <label>If died — age at death (days)<input id="ndd" type="number"></label>
     <label>If died — cause<select id="ndc">${selOpts([['1','1. Prematurity'],['2','2. Infection'],['3','3. Asphyxia'],['4','4. Other']])}</select></label>
    </div></details>

   <details class="moh"><summary>HIV <span class="muted">&mdash; MoH PNC register</span></summary><div class="grid">
    <label>HIV test result<select id="phtr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
   </div><div class="ticks">${tick('phta','HIV test accepted')}${tick('phrt','HIV re-testing accepted')}${tick('ppph','PPH')}</div>
   <div class="muted" style="font-size:12px;margin-top:6px">Linkage to ART, target population and partner testing are held on the woman&rsquo;s record.</div></details>

   <details class="moh"><summary>Counselling provided at this visit <span class="muted">&mdash; MoH PNC register</span></summary><div class="ticks">
    ${tick('pc1','Danger signs')}${tick('pc2','Breast feeding / nutrition')}${tick('pc3','Newborn care (incl. cord care)')}${tick('pc4','Family planning')}${tick('pc5','EPI')}${tick('pc6','Early childhood development')}
   </div></details>

   <details class="moh"><summary>Immediate postpartum family planning (0&ndash;48 hrs)</summary><div class="grid">
    <label>Acceptor type<select id="pacc">${selOpts(ACCEPTOR)}</select></label>
    <label>Method received<select id="pmth">${selOpts(IPPFP_METHODS)}</select></label>
   </div></details>

   <label>Remark<input id="prmk"></label>
   <button class="act" id="psave" style="margin-top:10px">${EDIT_PNC?'Save the correction':'Save PNC visit'}</button>
   ${EDIT_PNC?'<button class="sec" id="pcancel" style="margin-top:10px;margin-left:6px">Cancel</button>':''}
   <span class="muted" id="pm"></span></div>
   <div class="card"><h3>Previous PNC visits</h3><table><tr><th>Date</th><th>Period</th><th>M temp</th><th>M BP</th><th>Condition</th><th>NB feeding</th><th></th></tr>
    ${past.map(p=>`<tr${EDIT_PNC&&String(EDIT_PNC.id)===String(p.id)?' style="background:#fff8e6"':''}><td>${esc(p.visit_date||'')}</td><td>${esc(p.visit_period||p.pnc_day||'')}</td><td>${esc(p.m_temp||'')}</td><td>${esc((p.m_bp_systolic||'')+'/'+(p.m_bp_diastolic||''))}</td><td>${esc(({'1':'Normal','2':'Complicated, managed','3':'Complicated, referred','4':'Died'})[String(p.maternal_condition||'')]||'')}</td><td>${esc(p.nb_feeding||'')}</td>
      <td>${canDo('anc')?`<button class="sm" data-editpnc="${p.id}">Correct</button>`:''}</td></tr>`).join('')||'<tr><td colspan=7 class=muted>No PNC visits yet.</td></tr>'}
   <p class="muted" style="font-size:12px">Use <b>Correct</b> to fix a value written down wrong. It updates that visit &mdash; it does not add a second one.</p>
   </table></div>`;

  // ---- CORRECT A PAST PNC VISIT ------------------------------------------------------------
  document.querySelectorAll('#app button[data-editpnc]').forEach(b=>b.onclick=()=>{
    EDIT_PNC=(past||[]).find(x=>String(x.id)===String(b.dataset.editpnc))||null;
    pncVisits(id);
  });
  const pc=$('#pcancel'); if(pc) pc.onclick=()=>{ EDIT_PNC=null; pncVisits(id); };
  if(EDIT_PNC){
    fillVals(EDIT_PNC, PNC_VALS);
    fillTicks(EDIT_PNC, PNC_TICKS);
    fillEcs(EDIT_PNC, PNC_ECS);
    fillCsvTicks(EDIT_PNC, PNC_CSVS);      // newborn problems + treatments — a correction used to erase both
  }                                        // (paintPnc() runs below, after the listeners, so the alerts
                                           //  already reflect the values we have just restored)

  // ---- THE ALERTS THIS SCREEN NEVER HAD ----
  // PNC used to collect newborn convulsions, fast breathing, chest indrawing, lethargy and
  // jaundice, plus the mother's BP, temperature, pulse and lochia — and fire NOTHING. A newborn
  // with a possible serious bacterial infection was written to the database in silence, on the
  // very screen where sick babies actually present.
  const pncAlerts=()=>{
    const A=[]; const V=id=>{const el=$('#'+id); return el?el.value:'';};
    // --- newborn: WHO / IMNCI danger signs ---
    const nb=[];
    if(V('ncv')==='yes') nb.push('convulsions');
    if(V('nfb')==='yes') nb.push('fast breathing');
    if(V('nci')==='yes') nb.push('chest indrawing');
    if(V('nlt')==='yes') nb.push('lethargy / not moving');
    if(V('nf')==='none') nb.push('not feeding');
    const ntv=+V('nt')||null;
    if(ntv && (ntv>=37.5||ntv<35.5)) nb.push(ntv>=37.5?('fever '+ntv+'°C'):('hypothermia '+ntv+'°C'));
    if(nb.length) A.push(['red','Newborn danger signs — POSSIBLE SERIOUS BACTERIAL INFECTION',
      'This baby has: <b>'+nb.map(esc).join(', ')+'</b>.<br>Any one of these is a WHO danger sign. Give the first dose of antibiotic and <b>refer urgently</b> — do not send this baby home.']);
    if(V('njd')==='yes') A.push(['red','Severe jaundice','Severe jaundice in a newborn can cause permanent brain injury. Start phototherapy if available and refer urgently for bilirubin assessment.']);
    if(V('cd')==='infected') A.push(['amber','Infected cord','Red or discharging cord — a source of neonatal sepsis. Treat per protocol and reassess for danger signs.']);
    else if(V('cd')==='bleeding') A.push(['red','Cord bleeding','Control the bleeding, check the tie, and refer if it does not stop.']);
    // --- mother ---
    const ms=meowsScore({sbp:+V('bps')||null,dbp:+V('bpd')||null,pulse:+V('pl')||null,temp:+V('mt')||null});
    if(ms.band==='red') A.push(['red','MEOWS RED — she is deteriorating','Score '+ms.total+' ('+ms.parts.map(p=>esc(p.label)).join(', ')+'). Call for senior help now and start emergency management.']);
    else if(ms.band==='amber') A.push(['amber','MEOWS amber','Score '+ms.total+' ('+ms.parts.map(p=>esc(p.label)).join(', ')+'). Increase the frequency of observation and review her.']);
    const s=+V('bps')||null, d=+V('bpd')||null;
    if((s&&s>=160)||(d&&d>=110)) A.push(['red','Severe postpartum hypertension','BP '+(s||'?')+'/'+(d||'?')+'. Eclampsia can occur AFTER delivery. Treat and refer.']);
    // MATERNAL FEVER / PUERPERAL SEPSIS — a standalone alert, because MEOWS alone cannot reach a band
    // on temperature: a genuine 39°C fever scores only 2 (green) unless the pulse is also up. Puerperal
    // sepsis is a top-three cause of maternal death and this is the screen it presents on.
    const mt=+V('mt')||null;
    if(mt && mt>=38.5) A.push(['red','Maternal fever — POSSIBLE PUERPERAL SEPSIS','Temperature '+mt+'°C. Look for the source (uterus, breast, wound, urine, chest), take cultures if you can, start antibiotics per protocol, and refer if she does not stabilise.']);
    else if(mt && mt>=38) A.push(['amber','Maternal fever','Temperature '+mt+'°C. Reassess for a source of infection (endometritis, mastitis, wound, UTI) and monitor closely — a rising fever after delivery is puerperal sepsis until proven otherwise.']);
    if(V('bl')==='heavy') A.push(['red','Heavy lochia — possible secondary PPH','Assess the uterine tone, rub up a contraction, give a uterotonic and refer if bleeding continues.']);
    else if(V('bl')==='offensive') A.push(['amber','Offensive lochia — possible puerperal sepsis','Check her temperature, examine for tenderness, and treat or refer per protocol.']);
    if(V('ut')==='atonic') A.push(['red','Atonic uterus','A soft uterus after delivery is the commonest cause of postpartum haemorrhage. Rub up a contraction and give a uterotonic now.']);
    if(V('pw')==='infected') A.push(['amber','Infected perineum / wound','Treat per protocol and review. Watch for sepsis.']);
    if(V('mc')==='4') A.push(['red','Maternal death recorded','Ensure this is reported and reviewed through the maternal death surveillance and response process.']);
    return A;
  };
  const paintPnc=()=>{ $('#pncalerts').innerHTML=pncAlerts().map(a=>alertBox(a[0],a[1],a[2])).join(''); };
  ['ncv','nfb','nci','nlt','njd','nf','cd','bl','br','ut','pw','mc'].forEach(k=>{const el=$('#'+k); if(el) el.addEventListener('change',paintPnc);});
  ['nt','bps','bpd','pl','mt'].forEach(k=>{const el=$('#'+k); if(el) el.addEventListener('input',paintPnc);});
  paintPnc();

  const csv=(pre,codes)=>codes.filter(c=>tk(pre+c)).join(',')||null;   // MoH multi-code fields are comma-separated
  // MoH PNC items 6 & 7 live on the episode, not the visit. Derive them from the delivery
  // record when she delivered here; otherwise take what the provider entered. Without this
  // both columns came out permanently blank in the PNC register.
  // NEVER SEND A NULL OVER A VALUE THAT IS ALREADY THERE.
  //
  // The date-of-birth picker was rendered with no prefill, so it was EMPTY on every visit after the
  // first. `pod` is prefilled and therefore truthy, so this PATCH fired on visit 2 with
  // infant_dob: null — and the episodes PATCH wrote that null straight through. For a woman who gave
  // birth at HOME there is no delivery record to fall back on, so the infant's date of birth, entered
  // carefully at visit 1, was silently erased at visit 2 and every visit after it.
  //
  // Now: the picker is prefilled from the episode (see ecPicker below), and we only send a field we
  // actually have a value for. A blank box means "I did not touch this", never "delete it".
  const savePncId=async()=>{
    const pod=(+($('#pod')||{}).value||null);
    const dob=ecGet('idob') || (dv&&dv.delivery_datetime ? String(dv.delivery_datetime).slice(0,10) : null) || WP.infant_dob || null;
    const body={};
    if(pod) body.place_of_delivery=pod;
    if(dob) body.infant_dob=String(dob).slice(0,10);
    if(Object.keys(body).length) await api('PATCH','episodes/'+id,body).catch(()=>{});
  };
  $('#psave').onclick=async()=>{
    // Range check first: a mistyped number must not raise a clinical alert.
    if(!checkRanges([['bps','bp_systolic'],['bpd','bp_diastolic'],['pl','pulse'],['mt','temperature'],['nt','temperature']])) return;
    // A RED FLAG MUST BE SEEN. The visit still saves — refusing to store clinical data would be
    // worse — but the provider cannot walk past a newborn danger sign without reading it.
    const reds=pncAlerts().filter(a=>a[0]==='red');
    if(reds.length && !window._pncAck){ window._pncAck=true;
      modal(reds[0][1], reds.map(a=>'<b>'+a[1]+'</b><br>'+a[2]).join('<br><br>')+'<br><br><i>Press Save again to record this visit.</i>','risk');
      return; }
    window._pncAck=false;
    const b=$('#psave'); b.disabled=true; try{ await savePncId();
    const editingP = EDIT_PNC && EDIT_PNC.id;
    const r=await api(editingP?'PATCH':'POST', editingP?('pnc_visits/'+EDIT_PNC.id):'pnc_visits',
      {episode_id:+id,visit_date:ecGet('vd'),m_temp:+mt.value||null,m_bp_systolic:+bps.value||null,m_bp_diastolic:+bpd.value||null,m_pulse:+pl.value||null,bleeding:bl.value,breast:br.value,mood:md.value,uterine_tone:(ut.value||null),perineum:(pw.value||null),mother_breastfeeding:(mbf.value||null),pp_fp:(ppf.value||null),ifa_continued:(ifc.value||null),nb_temp:+nt.value||null,nb_feeding:nf.value,cord:cd.value,nb_convulsions:(ncv.value||null),nb_fast_breathing:(nfb.value||null),nb_chest_indrawing:(nci.value||null),nb_lethargy:(nlt.value||null),nb_jaundice:(njd.value||null),nb_kmc:(nkmc.value||null),nb_immunization:(nimm.value||null),nb_eid:(neid.value||null),danger_note:dn.value,
    baby_id:(+pbaby.value||null),
    visit_period:(vp.value||null),maternal_condition:(+mc.value||null),pph:tk('ppph'),other_obs_complication:(ooc.value||null),
    hiv_test_accepted:tk('phta'),hiv_retest_accepted:tk('phrt'),hiv_test_result:(phtr.value||null),
    cnsl_danger_signs:tk('pc1'),cnsl_breastfeeding:tk('pc2'),cnsl_newborn_care:tk('pc3'),cnsl_family_planning:tk('pc4'),cnsl_epi:tk('pc5'),cnsl_ecd:tk('pc6'),
    nb_weight_g:numOrNull(nwt.value),nb_problems:csv('np',[1,2,3,4,5,6,7,8,9,10,11]),nb_problem_other:(npo.value||null),nb_treatment:csv('nt',[1,2,3,4,5,6]),
    nb_treatment_outcome:(+nto.value||null),nb_death_age_days:numOrNull(ndd.value),nb_death_cause:(+ndc.value||null),
    ippfp_acceptor:(pacc.value||null),ippfp_method:(pmth.value||null),remark:prmk.value});
    const okP = r && (r.ids || r.ok || r.queued);
    $('#pm').textContent = okP ? (editingP?' corrected':' saved') : (' '+((r&&r.error)||'error'));
    if(okP && !r.queued){ EDIT_PNC=null; setTimeout(()=>pncVisits(id),500); }
    } finally{ b.disabled=false; } };
}

// Which baby (if any) we are EDITING rather than adding. Module-scoped so the Edit button in the
// table can re-render the form prefilled.
let EDIT_BABY=null;

// The form controls, mapped to their columns. Used to prefill an existing baby for editing, so a
// late DBS result is a CORRECTION and not a second newborn.
const BABY_FIELDS={bo:'birth_order',sx:'sex',wg:'weight_g',a1:'apgar_1min',a5:'apgar_5min',rs:'resuscitated',
  oc:'outcome',dr:'enc_dried',brb:'enc_breathing',vkt:'vitamin_k_time',eo:'enc_eye_ointment',cc:'enc_cord_care',
  cco:'cord_care_other',nmrn:'mrn',bfi:'breastfeed_initiated',hex:'hiv_exposed',arvp:'arv_prophylaxis',
  dbss:'dbs_sample',dbsr:'dbs_result',kmc:'kmc',pht:'phototherapy',abx:'antibiotics',oxy:'oxygen',
  nicu:'nicu',nicuf:'nicu_facility',bpot:'prob_other_text',bdd:'death_age_days',bdh:'death_age_hours',bdc:'death_cause'};
const BABY_TICKS={artl:'art_linked',vbcg:'vacc_bcg',vopv:'vacc_opv0',vhbv:'vacc_hbv',bpre:'prob_prematurity',
  bsep:'prob_sepsis_vsd',brds:'prob_resp_distress',bjau:'prob_jaundice',bcon:'prob_congenital',both:'prob_other',
  brsv:'resuscitated_survived',bnot:'birth_notification'};

async function babiesScreen(id){
  const past=await api('GET','babies?episode='+id).catch(()=>[]);
  const nextOrder=(past.length||0)+1;
  const ed=EDIT_BABY;                       // the baby being corrected, or null when adding
  app().innerHTML=nav()+`<div class="card"><h3>Newborn record — episode ${esc(id)}</h3>
   ${ed
     ? `<div style="background:#e8f3f0;border:1px solid #0f766e;color:#0f5c55;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">
          <b>Correcting baby #${esc(ed.birth_order||'')}</b> — this updates the existing record. It does not add another newborn.
          <button class="sm" id="bcancel" style="margin-left:8px">Cancel</button></div>`
     : `<p class="muted">Add one row per baby (supports twins and multiples). A result that comes back later &mdash; a DBS, a corrected weight &mdash; should be recorded with <b>Correct</b> on the baby below, not by adding a second one.</p>`}
   <div class="grid">
    <label>Birth order<input id="bo" type="number" value="${nextOrder}"></label>
    <label>Sex<select id="sx"><option value="female">Female</option><option value="male">Male</option><option value="ambiguous">Ambiguous</option></select></label>
    <label>Weight (g)<input id="wg" type="number" placeholder="grams"></label>
    <label>APGAR 1<input id="a1" type="number" min="0" max="10" placeholder="0–10"></label>
    <label>APGAR 5<input id="a5" type="number" min="0" max="10" placeholder="0–10"></label>
    <label>Resuscitated<select id="rs"><option value="0">No</option><option value="1">Yes</option></select></label>
    <label>Outcome<select id="oc"><option value="live_birth">Live birth</option><option value="fresh_stillbirth">Fresh stillbirth</option><option value="macerated_stillbirth">Macerated stillbirth</option><option value="neonatal_death">Neonatal death</option></select></label>
    <label>Dried &amp; stimulated<select id="dr"><option value="">-</option><option value="done">Done</option><option value="not">Not done</option></select></label>
    <label>Breathing at birth<select id="brb"><option value="">-</option><option value="normal">Normal</option><option value="stimulation">Needed stimulation</option><option value="resus">Needed resuscitation</option></select></label>
    <label>Vitamin K — <b>timing</b> <span class="muted" style="font-weight:400">(timing is critical)</span><select id="vkt">${selOpts([['within_1h','Given within 1 hour'],['1_24h','Given 1–24 hours'],['after_24h','Given after 24 hours'],['not_given','Not given']])}</select></label>
    <label>Eye ointment (TTC)<select id="eo"><option value="">-</option><option value="given">Given</option><option value="not">Not given</option></select></label>
    <label>Cord care<select id="cc"><option value="">-</option><option value="chlorhexidine">Chlorhexidine</option><option value="dry">Dry</option><option value="other">Other</option></select></label>
    <label id="ccow" style="display:none">If other, specify<input id="cco" placeholder="specify"></label>
    <label>Newborn MRN<input id="nmrn" placeholder="infant's MRN"></label>
    <label>Breastfeeding initiated<select id="bfi">${selOpts([['1','1. Within 1 hour'],['2','2. 1-2 hours'],['3','3. After 3 hours'],['4','4. Not at all'],['5','5. Other milk']])}</select></label>
   </div>
   <div id="nbwarn"></div>

   <details class="moh" open><summary>HIV exposure &amp; early infant diagnosis</summary>
    <div class="grid">
     <label>Is the newborn HIV-exposed? <span class="muted" style="font-weight:400">(mother HIV positive)</span><select id="hex">${selOpts([['1','Yes — exposed'],['0','No — not exposed']])}</select></label>
    </div>
    <div id="hexblock" style="display:none">
     <div class="muted" style="font-size:12px;margin:6px 0">Exposed infant pathway: <b>ARV prophylaxis &rarr; DBS for early infant diagnosis &rarr; if positive, link to the ART clinic.</b></div>
     <div class="grid">
      <label>ARV prophylaxis<select id="arvp">${selOpts([['given','Given'],['not_given','Not given'],['declined','Declined']])}</select></label>
      <label>DBS sample (early infant diagnosis)<select id="dbss">${selOpts([['sent','Sent'],['pending','Pending'],['not_sent','Not sent']])}</select></label>
      <label>DBS result<select id="dbsr">${selOpts([['pending','Pending'],['negative','Negative'],['positive','Positive']])}</select></label>
     </div>
     <div id="dbspos" style="display:none">
      <div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>DBS POSITIVE</b> — the infant must be linked to the ART clinic.</div>
      <div class="ticks">${tick('artl','Infant linked to ART clinic')}</div>
     </div>
    </div></details>

   <details class="moh" open><summary>Newborn care pathways <span class="muted">&mdash; prompted by the problems recorded</span></summary>
    <div id="pathprompt" class="muted" style="font-size:12px;margin-bottom:6px">Record the newborn's problems below; the care indicated will be prompted here.</div>
    <div class="grid">
     <label id="kmcw" style="display:none">KMC <span class="muted" style="font-weight:400">(low birth weight / preterm)</span><select id="kmc">${selOpts([['initiated','Initiated'],['not_initiated','Not initiated'],['not_indicated','Not indicated']])}</select></label>
     <label id="phw" style="display:none">Phototherapy <span class="muted" style="font-weight:400">(jaundice)</span><select id="pht">${selOpts([['given','Given'],['not_given','Not given'],['referred','Referred for phototherapy'],['not_indicated','Not indicated']])}</select></label>
     <label id="abw" style="display:none">Antibiotics <span class="muted" style="font-weight:400">(sepsis / VSD)</span><select id="abx">${selOpts([['given','Given'],['not_given','Not given'],['not_indicated','Not indicated']])}</select></label>
     <label id="oxw" style="display:none">Oxygen <span class="muted" style="font-weight:400">(respiratory distress)</span><select id="oxy">${selOpts([['given','Given'],['not_given','Not given'],['not_indicated','Not indicated']])}</select></label>
     <label>NICU / referral<select id="nicu">${selOpts([['not_indicated','Not indicated'],['admitted','Admitted to NICU here'],['referred_out','Referred out to NICU'],['referred_declined','Referral declined by family']])}</select></label>
     <label id="nfw" style="display:none">Referred / admitted to<input id="nicuf" placeholder="facility name"></label>
    </div></details>

   <details class="moh" open><summary>Vaccinated at birth <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('vbcg','BCG')}${tick('vopv','OPV 0')}${tick('vhbv','HBV')}
   </div></details>

   <details class="moh" open><summary>Newborn problems identified <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('bpre','Prematurity')}${tick('bsep','Sepsis / VSD')}${tick('brds','Respiratory distress / asphyxia')}${tick('bjau','Jaundice')}${tick('bcon','Congenital malformation')}${tick('both','Other')}
   </div>
   <label>If other, specify<input id="bpot"></label>
   <div class="muted" style="font-size:12px;margin-top:6px">Low birth weight is derived automatically from the weight (&lt;2500 g). Ticking a problem will prompt the care indicated for it.</div></details>

   <details class="moh"><summary>Outcome &amp; notification</summary><div class="ticks">
    ${tick('brsv','Resuscitated and survived')}${tick('bnot','Birth notification given to mother')}
   </div><div class="grid" style="margin-top:8px">
    <label>If died — age (days)<input id="bdd" type="number"></label>
    <label>If died — age (hours)<input id="bdh" type="number"></label>
    <label>If died — cause<select id="bdc">${selOpts([['1','1. Prematurity'],['2','2. Infection'],['3','3. Asphyxia'],['4','4. Other']])}</select></label>
   </div></details>

   <button class="act" id="bsave" style="margin-top:10px">${ed?'Save the correction':'Add baby'}</button> <span class="muted" id="bm"></span></div>
   <div class="card"><h3>Babies</h3><table><tr><th>#</th><th>Sex</th><th>Weight</th><th>APGAR</th><th>Resus</th><th>Outcome</th><th>DBS</th><th></th></tr>
    ${past.map(p=>`<tr><td>${esc(p.birth_order||'')}</td><td>${esc(p.sex||'')}</td><td>${esc(p.weight_g||'')}</td><td>${esc((p.apgar_1min||'')+'/'+(p.apgar_5min||''))}</td><td>${p.resuscitated==1?'yes':'no'}</td><td>${esc(p.outcome||'')}</td>
      <td>${p.hiv_exposed==1?esc(p.dbs_result||'pending'):'<span class="muted">—</span>'}</td>
      <td><button class="sm" data-edit="${p.id}">Correct</button></td></tr>`).join('')||'<tr><td colspan=8 class=muted>No babies recorded yet.</td></tr>'}
   </table>
   <p class="muted" style="font-size:12px">Use <b>Correct</b> to record a result that came back later. Adding a second row for the same baby creates a phantom twin &mdash; it double-counts the birth and prints twice in the MoH delivery register.</p></div>`;
  document.querySelectorAll('#app button[data-edit]').forEach(b=>b.onclick=()=>{
    EDIT_BABY=(past||[]).find(x=>String(x.id)===String(b.dataset.edit))||null;
    babiesScreen(id);
  });
  const bc=$('#bcancel'); if(bc) bc.onclick=()=>{ EDIT_BABY=null; babiesScreen(id); };
  // Prefill the form from the baby being corrected.
  if(ed){
    Object.keys(BABY_FIELDS).forEach(k=>{ const el=$('#'+k); if(!el) return;
      const v=ed[BABY_FIELDS[k]]; if(v!==null&&v!==undefined) el.value=String(v); });
    Object.keys(BABY_TICKS).forEach(k=>{ const el=$('#'+k); if(el) el.checked=(+ed[BABY_TICKS[k]]===1); });
  }
  // ---- live consistency + validation ------------------------------------------
  // Collaborator caught this: "Resuscitated: No" was accepted alongside
  // "Breathing at birth: Needed resuscitation". Contradictory data must be blocked.
  const nbIssues=()=>{ const out=[];
    const a1v=a1.value===''?null:+a1.value, a5v=a5.value===''?null:+a5.value;
    if(a1v!==null&&(a1v<0||a1v>10)) out.push({t:'APGAR at 1 minute must be between 0 and 10.',block:true});
    if(a5v!==null&&(a5v<0||a5v>10)) out.push({t:'APGAR at 5 minutes must be between 0 and 10.',block:true});
    if(brb.value==='resus' && rs.value!=='1') out.push({t:'Contradiction: breathing at birth is "Needed resuscitation", but Resuscitated is "No". Set Resuscitated to Yes, or change the breathing assessment.',block:true});
    if(String(oc.value).indexOf('stillbirth')>-1 && (a1v>0||a5v>0)) out.push({t:'Contradiction: a stillbirth cannot have an APGAR above 0.',block:true});
    if(a5v!==null&&a5v<7) out.push({t:'APGAR '+a5v+' at 5 minutes is LOW (<7) — this newborn needs close monitoring and may need resuscitation, oxygen or referral.',block:false});
    if((+wg.value||0)>0&&(+wg.value)<2500) out.push({t:'Low birth weight ('+wg.value+' g) — KMC is indicated.',block:false});
    return out; };
  const showNb=()=>{
    const iss=nbIssues();
    $('#nbwarn').innerHTML=iss.map(i=>`<div style="background:${i.block?'#fcebeb':'#faeeda'};border:1px solid ${i.block?'#f09595':'#ef9f27'};color:${i.block?'#791f1f':'#633806'};border-radius:10px;padding:8px 12px;margin:6px 0;font-size:13px">${esc(i.t)}</div>`).join('');
    // conditional care pathways — a recorded problem must get a recorded response
    const lbw=((+wg.value||0)>0&&(+wg.value)<2500)||tk('bpre');
    $('#kmcw').style.display=lbw?'':'none';
    $('#abw').style.display=tk('bsep')?'':'none';
    $('#oxw').style.display=(tk('brds')||( a5.value!==''&&+a5.value<7))?'':'none';
    $('#phw').style.display=tk('bjau')?'':'none';
    $('#nfw').style.display=(nicu.value==='admitted'||nicu.value==='referred_out')?'':'none';
    $('#ccow').style.display=(cc.value==='other')?'':'none';
    $('#hexblock').style.display=(hex.value==='1')?'':'none';
    $('#dbspos').style.display=(hex.value==='1'&&dbsr.value==='positive')?'':'none';
    const any=lbw||tk('bsep')||tk('brds')||tk('bjau');
    $('#pathprompt').style.display=any?'none':'';
  };
  ['a1','a5','wg','rs','brb','oc','cc','hex','dbsr','nicu','bpre','bsep','brds','bjau'].forEach(k=>{const el=$('#'+k); if(el){el.addEventListener('change',showNb); el.addEventListener('input',showNb);}});
  showNb();

  $('#bsave').onclick=async()=>{
    // APGAR 0 and a blood loss of 0 are REAL values and must pass — the ranges start at 0 for exactly
    // that reason. What is rejected is a birth weight of 40 g or an APGAR of 80.
    if(!checkRanges([['wg','birth_weight_g'],['a1','apgar'],['a5','apgar']])) return;
    const blocking=nbIssues().filter(i=>i.block);
    if(blocking.length){ modal('Check the newborn record',blocking.map(i=>i.t).join('\n\n'),'risk'); return; }
    const b=$('#bsave'); b.disabled=true; try{
    // CORRECT the existing baby, or add a new one. Until now the screen could only ADD — so a DBS
    // result that came back a week later could only be recorded by saving the form again, which
    // inserted a SECOND baby at birth_order = past.length + 1. A phantom twin: it inflated births
    // and stillbirths and printed a duplicate line in the MoH delivery register.
    const editing = EDIT_BABY && EDIT_BABY.id;
    const r=await api(editing?'PATCH':'POST', editing?('babies/'+EDIT_BABY.id):'babies',
    {episode_id:+id,birth_order:+bo.value||1,sex:sx.value,weight_g:numOrNull(wg.value),apgar_1min:numOrNull(a1.value),apgar_5min:numOrNull(a5.value),resuscitated:+rs.value,outcome:oc.value,enc_dried:(dr.value||null),enc_breathing:(brb.value||null),enc_eye_ointment:(eo.value||null),enc_cord_care:(cc.value||null),
    mrn:(nmrn.value||null),breastfeed_initiated:(+bfi.value||null),
    vitamin_k_time:(vkt.value||null),cord_care_other:(cc.value==='other'?(cco.value||null):null),
    apgar_flag:(a5.value!==''?((+a5.value<7)?'low':'normal'):null),
    hiv_exposed:(hex.value===''?null:+hex.value),
    arv_prophylaxis:(hex.value==='1'?(arvp.value||null):null),
    dbs_sample:(hex.value==='1'?(dbss.value||null):null),
    dbs_result:(hex.value==='1'?(dbsr.value||null):null),
    art_linked:(hex.value==='1'&&dbsr.value==='positive')?tk('artl'):null,
    kmc:(kmc.value||null),phototherapy:(pht.value||null),antibiotics:(abx.value||null),oxygen:(oxy.value||null),
    nicu:(nicu.value||null),nicu_facility:((nicu.value==='admitted'||nicu.value==='referred_out')?(nicuf.value||null):null),
    vacc_bcg:tk('vbcg'),vacc_opv0:tk('vopv'),vacc_hbv:tk('vhbv'),
    prob_prematurity:tk('bpre'),prob_sepsis_vsd:tk('bsep'),prob_resp_distress:tk('brds'),prob_jaundice:tk('bjau'),prob_congenital:tk('bcon'),prob_other:tk('both'),prob_other_text:(bpot.value||null),
    prob_lbw:((+wg.value||0)>0&&(+wg.value)<2500)?1:0,   // MoH item 55 — derived, never asked
    resuscitated_survived:tk('brsv'),birth_notification:tk('bnot'),
    death_age_days:numOrNull(bdd.value),death_age_hours:numOrNull(bdh.value),death_cause:(+bdc.value||null)});
    const ok = r && (r.ids || r.ok || r.queued);
    $('#bm').textContent = ok ? (editing?' correction saved':' added') : ' '+((r&&r.error)||'error');
    if(ok && !r.queued){ EDIT_BABY=null; setTimeout(()=>babiesScreen(id),400); }
    } finally{ b.disabled=false; } };
}

let EDIT_VITAL=null;                       // the vitals row being corrected, or null when recording new
const VIT_VALS={ bps:'bp_systolic', bpd:'bp_diastolic', pl:'pulse', tp:'temperature',
                 rr:'resp_rate', sp:'spo2', ntt:'note' };

async function vitalsScreen(id){
  const past=await api('GET','maternal_vitals?episode='+id).catch(()=>[]);
  const hist=past.map(p=>{ const ms=meowsScore({sbp:p.bp_systolic,dbp:p.bp_diastolic,pulse:p.pulse,temp:p.temperature,rr:p.resp_rate,spo2:p.spo2}); return `<tr${EDIT_VITAL&&String(EDIT_VITAL.id)===String(p.id)?' style="background:#fff8e6"':''}><td>${esc((p.obs_datetime||p.recorded_at||'').slice(0,16))}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.pulse||'')}</td><td>${esc(p.temperature||'')}</td><td>${esc(p.resp_rate||'')}</td><td>${esc(p.spo2||'')}</td><td><span class="pill ${ms.band}">${ms.total}</span></td><td>${canDo('anc')?`<button class="sm" data-editvit="${p.id}">Correct</button>`:''}</td></tr>`; }).join('')||'<tr><td colspan=8 class=muted>No vitals yet.</td></tr>';
  app().innerHTML=nav()+`<div class="card"><h3>Maternal vital signs — episode ${esc(id)}</h3>
   <div class="grid">
    <label>BP systolic<input id="bps" type="number" placeholder="mmHg"></label>
    <label>BP diastolic<input id="bpd" type="number" placeholder="mmHg"></label>
    <label>Pulse<input id="pl" type="number" placeholder="bpm"></label>
    <label>Temp °C<input id="tp" type="number" step="0.1" placeholder="°C"></label>
    <label>Resp rate<input id="rr" type="number" placeholder="per min"></label>
    <label>SpO2 %<input id="sp" type="number" placeholder="%"></label>
   </div>
   <p class="muted" style="font-size:12px;margin:-4px 0 6px">Leave blank anything you have not measured. A normal value that nobody took would score green on MEOWS &mdash; which is worse than an empty box.</p>
   <label>Note<input id="ntt"></label>
   <div id="meows" style="margin-top:10px"></div>
   <button class="act" id="vsave" style="margin-top:10px">${EDIT_VITAL?'Save the correction':'Record vitals'}</button>
   ${EDIT_VITAL?'<button class="sec" id="vcancel" style="margin-top:10px;margin-left:6px">Cancel</button>':''}
   <span class="muted" id="vm"></span></div>
   <div class="card"><h3>Vitals history</h3><table><tr><th>When</th><th>BP</th><th>Pulse</th><th>Temp</th><th>RR</th><th>SpO2</th><th>MEOWS</th><th></th></tr>
    ${hist}
   </table>
   <p class="muted" style="font-size:12px">Use <b>Correct</b> to fix a value written down wrong. It updates that reading &mdash; it does not add a second one.</p></div>`;

  // ---- CORRECT A PAST SET OF VITALS ---------------------------------------------------------
  document.querySelectorAll('#app button[data-editvit]').forEach(b=>b.onclick=()=>{
    EDIT_VITAL=(past||[]).find(x=>String(x.id)===String(b.dataset.editvit))||null;
    vitalsScreen(id);
  });
  const vc=$('#vcancel'); if(vc) vc.onclick=()=>{ EDIT_VITAL=null; vitalsScreen(id); };
  if(EDIT_VITAL) fillVals(EDIT_VITAL, VIT_VALS);

  // MEOWS ALONE CANNOT RAISE A BAND ON ONE DERANGED VITAL. Temperature caps at 2 points and amber needs
  // 3, so a woman at 40.0 C with everything else normal scored 2 = GREEN, on the one screen whose whole
  // purpose is spotting maternal deterioration - and this screen showed no alerts at all, only a score.
  // The same standalone red flags the ANC/PNC screens carry now fire here. Sepsis and severe
  // hypertension are the two that kill quietly.
  const vitalAlerts=()=>{
    const A=[]; const s=+bps.value||null, d=+bpd.value||null, t=+tp.value||null, p=+pl.value||null, o=+sp.value||null;
    if((s&&s>=160)||(d&&d>=110)) A.push(['red','SEVERE HYPERTENSION','BP '+(s||'?')+'/'+(d||'?')+' — at or above 160/110. Treat and refer urgently. Check for proteinuria and for signs of imminent eclampsia.']);
    else if((s&&s>=140)||(d&&d>=90)) A.push(['amber','Raised blood pressure','BP '+(s||'?')+'/'+(d||'?')+'. Repeat after rest and check urine protein.']);
    if(t&&t>=38.5) A.push(['red','Maternal fever — POSSIBLE SEPSIS','Temperature '+t+'°C. Look for the source (uterus, breast, wound, urine, chest), start antibiotics per protocol, and refer if she does not stabilise.']);
    else if(t&&t>=38) A.push(['amber','Maternal fever','Temperature '+t+'°C. Reassess for a source of infection and monitor closely.']);
    else if(t&&t<36) A.push(['red','Hypothermia','Temperature '+t+'°C. In a sick woman this is an ominous sign — assess for sepsis and shock.']);
    if(p&&p>=120) A.push(['red','Tachycardia','Pulse '+p+'. With a normal or falling BP this is compensated shock — look for bleeding and for sepsis.']);
    if(o&&o<95) A.push([(o<92?'red':'amber'),'Low oxygen saturation','SpO2 '+o+'%. Give oxygen and find the cause.']);
    return A;
  };
  const showMeows=()=>{ const ms=meowsScore({sbp:bps.value,dbp:bpd.value,pulse:pl.value,temp:tp.value,rr:rr.value,spo2:sp.value});
    const act=ms.band==='red'?'urgent review — escalate now':(ms.band==='amber'?'increase monitoring, review':'continue routine monitoring');
    $('#meows').innerHTML=vitalAlerts().map(a=>alertBox(a[0],a[1],a[2])).join('')
      +'<div style="border-top:0.5px solid #eee;padding-top:8px"><b class="muted">MEOWS early-warning</b> <span class="pill '+ms.band+'">score '+ms.total+'</span> <span class="muted">'+esc(act)+'</span>'+(ms.parts.length?('<div class="muted" style="font-size:12px;margin-top:3px">Triggers: '+ms.parts.map(x=>esc(x.label)+' (+'+x.pts+')').join(' &middot; ')+'</div>'):'')+'</div>'; };
  ['bps','bpd','pl','tp','rr','sp'].forEach(x=>{ const e=$('#'+x); if(e) e.oninput=showMeows; }); showMeows();
  $('#vsave').onclick=async()=>{
    if(!checkRanges([['bps','bp_systolic'],['bpd','bp_diastolic'],['pl','pulse'],['tp','temperature'],['rr','resp_rate'],['sp','spo2']])) return;
    const b=$('#vsave'); b.disabled=true; try{
    const editingV = EDIT_VITAL && EDIT_VITAL.id;
    // When correcting, KEEP the original observation time — the reading was taken then, not now.
    const r=await api(editingV?'PATCH':'POST', editingV?('maternal_vitals/'+EDIT_VITAL.id):'maternal_vitals',
      {episode_id:+id, obs_datetime:(editingV ? (EDIT_VITAL.obs_datetime||nowStr()) : nowStr()),
       bp_systolic:numOrNull(bps.value),bp_diastolic:numOrNull(bpd.value),pulse:numOrNull(pl.value),
       temperature:numOrNull(tp.value),resp_rate:numOrNull(rr.value),spo2:numOrNull(sp.value),note:ntt.value});
    const okV = r && (r.ids || r.ok || r.queued);
    $('#vm').textContent = okV ? (editingV?' corrected':' recorded') : (' '+((r&&r.error)||'error'));
    if(okV && !r.queued){ EDIT_VITAL=null; setTimeout(()=>vitalsScreen(id),400); }
    } finally{ b.disabled=false; } };
}

async function handoverScreen(id){
  const [past,provs]=await Promise.all([api('GET','handover?episode='+id).catch(()=>[]),api('GET','providers').catch(()=>[])]);
  const pname=uid=>{ const p=provs.find(x=>x.id==uid); return p?p.full_name:(uid||''); };
  app().innerHTML=nav()+`<div class="card"><h3>Provider handover — episode ${esc(id)}</h3>
   <div class="grid">
    <label>Handover to<select id="hto">${provs.map(p=>`<option value="${p.id}">${esc(p.full_name)} (${esc(p.role)})</option>`).join('')}</select></label>
    <label>Note<input id="hn" placeholder="status, plan, pending tasks"></label>
   </div><button class="act" id="hsave" style="margin-top:10px">Record handover</button> <span class="muted" id="hm"></span>
   ${provs.length?'':'<p class="muted">No providers at this facility yet.</p>'}</div>
   <div class="card"><h3>Handover history</h3><table><tr><th>When</th><th>From</th><th>To</th><th>Note</th></tr>
    ${past.map(p=>`<tr><td>${esc((p.handover_datetime||'').slice(0,16))}</td><td>${esc(pname(p.from_provider_id))}</td><td>${esc(pname(p.to_provider_id))}</td><td>${esc(p.note||'')}</td></tr>`).join('')||'<tr><td colspan=4 class=muted>No handovers yet.</td></tr>'}
   </table></div>`;
  $('#hsave').onclick=async()=>{ const _b=$('#hsave'); if(_b.disabled) return; _b.disabled=true;
    setTimeout(()=>{ if(_b) _b.disabled=false; },4000);
    const to=document.getElementById('hto')?+hto.value:null; const r=await api('POST','handover',{episode_id:+id,from_provider_id:ME.id,to_provider_id:to,note:hn.value});
    $('#hm').textContent=(r&&(r.ids||r.queued))?' handed over':' '+((r&&r.error)||'error'); if(r&&r.ids){ if(to){ try{ await api('PATCH','episodes/'+id,{provider_id:to}); }catch(e){} } setTimeout(()=>handoverScreen(id),400);} };
}

async function editWoman(wid){
  const w=await api('GET','women/'+wid).catch(()=>null);
  if(!w||!w.id){ app().innerHTML=nav()+'<div class="card">Woman not found.</div>'; return; }
  app().innerHTML=nav()+`<div class="card"><h3>Edit woman — ${esc(w.mrn)}</h3>
   <div class="grid">
    <label>First name<input id="fn" value="${esc(w.first_name||'')}"></label>
    <label>Father name<input id="fa" value="${esc(w.father_name||'')}"></label>
    <label>Grandfather<input id="gf" value="${esc(w.grandfather_name||'')}"></label>
    <label>Age<input id="age" type="number" value="${esc(w.age||'')}"></label>
    <label>Phone<input id="ph" value="${esc(w.phone||'')}"></label>
    <label>Kebele<input id="kb" value="${esc(w.kebele||'')}"></label>
    <label>Gravida<input id="gr" type="number" value="${esc(w.gravida||'')}"></label>
    <label>Para<input id="pa" type="number" value="${esc(w.para||'')}"></label>
    <label>Height (cm) <span class="muted" style="font-weight:400">&mdash; drives BMI at every ANC contact</span><input id="ht" type="number" min="120" max="200" value="${esc(w.height_cm||'')}"></label>
    <label>Woreda<input id="wo" value="${esc(w.woreda||'')}"></label>
    <label>GA at first ANC contact (weeks)<input id="gafc" type="number" min="4" max="42" value="${esc(w.ga_first_contact||'')}"></label>
    <label>Blood group<select id="bg">${selOpts([['A','A'],['B','B'],['AB','AB'],['O','O']],w.blood_group)}</select></label>
    <label>Rh factor<select id="rh">${selOpts([['pos','Positive'],['neg','Negative']],w.rh_factor)}</select></label>
    <label>Is this pregnancy planned?<select id="pp">${selOpts([['1','Yes — planned'],['0','No — unplanned / unwanted']],w.pregnancy_planned)}</select></label>
    <label>Abortion<input id="ab" type="number" min="0" value="${esc(w.abortions??'')}"></label>
    <label>Ectopic<input id="ecp" type="number" min="0" value="${esc(w.ectopic??'')}"></label>
    <label>GTD<input id="gtd" type="number" min="0" value="${esc(w.gtd??'')}"></label>
   </div>

   <details class="moh" open><summary>Permanent history &amp; chronic conditions <span class="muted">&mdash; correctable here</span></summary>
   <div class="muted" style="font-size:12px;margin-bottom:8px">These follow her into <b>every future pregnancy</b>: they drive the high-risk worklist and are fed to the AI model. The screening screen deliberately will not let a &ldquo;no&rdquo; erase a recorded &ldquo;yes&rdquo; &mdash; so until now a <b>mis-tapped answer could never be taken back</b>, and she stayed flagged for life. This is the one place they can be corrected. Change one only if you are sure it was recorded in error.</div>
   <div class="grid">
    <label>Previous caesarean section<select id="hprcs">${selOpts([['yes','Yes'],['no','No']],w.prior_cs)}</select></label>
    <label>Previous stillbirth<select id="hprsb">${selOpts([['yes','Yes'],['no','No']],w.prior_stillbirth)}</select></label>
    <label>Previous postpartum haemorrhage<select id="hprpph">${selOpts([['yes','Yes'],['no','No']],w.prior_pph)}</select></label>
    <label>Previous pre-eclampsia / eclampsia<select id="hprpe">${selOpts([['yes','Yes'],['no','No']],w.prior_preeclampsia)}</select></label>
    <label>Previous obstructed labour<select id="hprob">${selOpts([['yes','Yes'],['no','No']],w.prior_obstructed)}</select></label>
    <label>Chronic hypertension<select id="hchtn">${selOpts([['yes','Yes'],['no','No']],w.chronic_htn)}</select></label>
    <label>Diabetes<select id="hdm">${selOpts([['yes','Yes'],['no','No']],w.diabetes)}</select></label>
    <label>Cardiac or renal disease<select id="hcr">${selOpts([['yes','Yes'],['no','No']],w.cardiac_renal)}</select></label>
   </div></details>

   <div class="grid">
    <label>Residence<select id="res">${selOpts([['urban','Urban'],['rural','Rural']],w.residence)}</select></label>
    <label>Occupation<input id="occ" value="${esc(w.occupation||'')}"></label>
    ${ecPicker('lnmp','Last menstrual period',false,w.lnmp)}
   </div>
   ${String(w.rh_factor||'')==='neg'?`<div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>Rh NEGATIVE</b> &mdash; Anti-D prophylaxis is indicated (if indirect Coombs negative).</div>`:''}
   ${w.ga_first_contact?`<div style="background:${lateAnc(w.ga_first_contact)?'#faeeda':'#e1f5ee'};border:1px solid ${lateAnc(w.ga_first_contact)?'#ef9f27':'#5dcaa5'};color:${lateAnc(w.ga_first_contact)?'#633806':'#04342c'};border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
     Booked ANC at <b>${esc(w.ga_first_contact)} weeks</b> &mdash; ${lateAnc(w.ga_first_contact)?'late initiation (after the first trimester).':'timely initiation (first trimester).'}</div>`:''}

   <details class="moh" open><summary>HIV &amp; PMTCT <span class="muted">&mdash; held once, used by ANC, Delivery and PNC</span></summary>
    <div class="muted" style="font-size:12px;margin-bottom:6px">The paper registers ask for these at every contact. Recorded here once, they are replayed into every register row automatically.</div>
    <div class="grid">
     ${tpSel('tp','Targeted population category',w.target_pop_code)}
     <label>Linked to PMTCT at<select id="lpf">${selOpts([['1','1. Same facility'],['2','2. Other facility']],w.hiv_linked_pmtct_facility)}</select></label>
     <label>ART regimen<input id="artr" value="${esc(w.art_regimen||'')}" placeholder="free text — awaiting national code list"></label>
    </div>
    <div class="ticks">
     <label class="tick"><input type="checkbox" id="hkp" ${w.hiv_known_positive==1?'checked':''}> Known HIV positive (transferred from ART)</label>
     <label class="tick"><input type="checkbox" id="lpm" ${w.hiv_linked_pmtct==1?'checked':''}> HIV positive — linked to PMTCT</label>
     <label class="tick"><input type="checkbox" id="lar" ${w.hiv_linked_art==1?'checked':''}> HIV positive — linked to ART</label>
    </div></details>

   <details class="moh"><summary>Partner testing</summary><div class="grid">
     <label>Partner HIV test result<select id="phr">${selOpts([['P','Positive'],['N','Negative'],['I','Indeterminate']],w.partner_hiv_result)}</select></label>
     ${tpSel('ptp','Partner targeted population category',w.partner_target_pop_code)}
    </div>
    <div class="ticks">
     <label class="tick"><input type="checkbox" id="pha" ${w.partner_hiv_accepted==1?'checked':''}> Partner HIV test accepted</label>
     <label class="tick"><input type="checkbox" id="pla" ${w.partner_linked_art==1?'checked':''}> HIV positive partner linked to ART</label>
    </div></details>

   <button class="act" id="wsave" style="margin-top:10px">Save changes</button> <span class="muted" id="wm"></span></div>`;
  $('#wsave').onclick=async()=>{
    // Age drives the high-risk flag (<19 or >35). It was validated at registration and NOT here,
    // so a typo on this screen silently corrupted the flag — or cleared it altogether.
    const ea=ageError(age.value); if(age.value && ea){ modal('Check the age',ea); return; }
    // Height had NO bounds at all on this screen (registration at least had the HTML hints), and it
    // is the one number that follows her through every antenatal contact via BMI.
    if(!checkRanges([['ht','height_cm'],['gr','gravida'],['pa','para']])) return;
    // LNMP: this screen is the ONLY writer of LNMP and EDD in the whole application, and it used
    // to write NULL over them on every save — even a phone-number correction destroyed her dates.
    // The picker is now pre-filled (above); belt and braces, never send an empty one over a
    // stored value.
    const _ln=ecGet('lnmp')||w.lnmp||null;
    const r=await api('PATCH','women/'+wid,{first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value||null,phone:ph.value,kebele:kb.value,gravida:numOrNull(gr.value),para:numOrNull(pa.value),height_cm:(+ht.value||null),lnmp:_ln,edd:(_ln?addDays(_ln,280):null),
    woreda:(wo.value||null),ga_first_contact:(+gafc.value||null),late_anc_initiation:(gafc.value?(lateAnc(gafc.value)?1:0):null),
    blood_group:(bg.value||null),rh_factor:(rh.value||null),pregnancy_planned:(pp.value===''?null:+pp.value),
    abortions:(ab.value===''?null:+ab.value),ectopic:(ecp.value===''?null:+ecp.value),gtd:(gtd.value===''?null:+gtd.value),
    residence:(res.value||null),occupation:(occ.value||null),
    // THE EIGHT PERMANENT FLAGS. The server has always accepted them on PATCH /women — NOTHING SENT
    // THEM. Combined with the deliberate "an explicit no must not erase a recorded yes" rule on the
    // screening screen, that made a mis-tapped answer PERMANENT: she was flagged high-risk for life,
    // in every future pregnancy, and prior_cs=1 was handed to the intrapartum model for ever, with no
    // screen anywhere able to take it back. This is the correction path.
    prior_cs:(hprcs.value||null), prior_stillbirth:(hprsb.value||null), prior_pph:(hprpph.value||null),
    prior_preeclampsia:(hprpe.value||null), prior_obstructed:(hprob.value||null),
    chronic_htn:(hchtn.value||null), diabetes:(hdm.value||null), cardiac_renal:(hcr.value||null),
    target_pop_code:(tp.value||null),hiv_known_positive:tk('hkp'),hiv_linked_pmtct:tk('lpm'),hiv_linked_pmtct_facility:(+lpf.value||null),hiv_linked_art:tk('lar'),art_regimen:(artr.value||null),
    partner_hiv_accepted:tk('pha'),partner_hiv_result:(phr.value||null),partner_target_pop_code:(ptp.value||null),partner_linked_art:tk('pla')});
    $('#wm').textContent=(r&&(r.ok||r.queued))?' saved':' '+((r&&r.error)||'error'); };
}

// ---- MoH paper-register export ----------------------------------------------
// Renders the official ANC / Delivery / PNC register from captured data, so the
// facility can print it instead of hand-writing it. Columns follow the MoH item order.
const REG_COLS={
  anc:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name',r=>((r.first_name||'')+' '+(r.father_name||'')).trim()],['Kebele','kebele'],
    ['Age','age'],['LNMP','lnmp'],['EDD','edd'],['Booking GA','ga_first_contact'],['Late init',tickCell('late_anc_initiation')],['Contact','contact_no'],['Date','visit_date'],['GA','ga_weeks'],
    ['U/S &lt;24w','ultrasound_lt24w'],['Syphilis','syphilis_result'],['Syph Rx',tickCell('syphilis_treated')],
    ['HepB','hepb_result'],['HepB Rx',tickCell('hepb_treated')],['HepB prophy',tickCell('hepb_prophylaxis')],
    ['Td dose','td_dose_no'],['IFA tabs','ifa_tabs'],['Deworm',tickCell('deworming')],['MUAC','muac'],
    ['HIV acc',tickCell('hiv_test_accepted')],['HIV res','hiv_test_result'],['Target pop','target_pop_code'],
    ['Post-test',tickCell('hiv_posttest_counselled')],['PMTCT',tickCell('hiv_linked_pmtct')],['Known+',tickCell('hiv_known_positive')],
    ['Ptnr acc',tickCell('partner_hiv_accepted')],['Ptnr res','partner_hiv_result'],['Ptnr pop','partner_target_pop_code'],['Ptnr ART',tickCell('partner_linked_art')],
    ['C:Danger',tickCell('cnsl_danger_signs')],['C:Nutr',tickCell('cnsl_nutrition')],['C:ECD',tickCell('cnsl_ecd')],['C:Feed',tickCell('cnsl_infant_feeding')],['C:FP',tickCell('cnsl_family_planning')],['Remark','remark']],
  delivery:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name',r=>((r.first_name||'')+' '+(r.father_name||'')).trim()],['Age','age'],['Kebele','kebele'],
    ['Delivery date/time','delivery_datetime'],['Partograph','partograph_used'],['Mode','mode'],['Episiotomy',tickCell('episiotomy')],
    ['Uterotonic','amtsl_uterotonic_type'],['CCT','amtsl_cct'],['Mother','maternal_status'],['Death cause','maternal_death_cause'],
    ['PE',tickCell('comp_preeclampsia')],['E',tickCell('comp_eclampsia')],['APH',tickCell('comp_aph')],['PPH',tickCell('comp_pph')],['Other',tickCell('comp_other')],['Referred',tickCell('referred')],
    ['Birth order','birth_order'],['Outcome','outcome'],['APGAR',r=>(r.apgar_1min||'')+'/'+(r.apgar_5min||'')],['Sex','sex'],['Weight (g)','weight_g'],
    ['NB MRN','mrn_baby'],['Vit K',r=>(r.vitamin_k_time&&r.vitamin_k_time!=='not_given')?'✓':''],['Vit K timing','vitamin_k_time'],['TTC','enc_eye_ointment'],['Chlorhex','enc_cord_care'],
    ['HIV exposed',tickCell('hiv_exposed')],['ARV prophylaxis','arv_prophylaxis'],['DBS','dbs_sample'],['DBS result','dbs_result'],['KMC','kmc'],['Phototherapy','phototherapy'],['NICU','nicu'],
    ['Vacc',r=>[r.vacc_bcg?'BCG':'',r.vacc_opv0?'OPV0':'',r.vacc_hbv?'HBV':''].filter(Boolean).join('+')],
    ['HIV acc',tickCell('hiv_test_accepted')],['HIV res','hiv_test_result'],['Target pop','target_pop_code'],['ART regimen','art_regimen'],
    ['Prem',tickCell('prob_prematurity')],['Sepsis',tickCell('prob_sepsis_vsd')],['RDS',tickCell('prob_resp_distress')],['LBW',tickCell('prob_lbw')],['Congenital',tickCell('prob_congenital')],
    ['BF init','breastfeed_initiated'],['Resus survived',tickCell('resuscitated_survived')],['Death age',r=>(r.death_age_days!=null?r.death_age_days+'d ':'')+(r.death_age_hours!=null?r.death_age_hours+'h':'')],
    ['Death cause','death_cause'],['Birth notif',tickCell('birth_notification')],
    ['IPPFP','ippfp_acceptor'],['Method','ippfp_method'],['Remark','delivery_remark']],
  pnc:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name',r=>((r.first_name||'')+' '+(r.father_name||'')).trim()],['Age','age'],['Woreda/Kebele',r=>[r.woreda,r.kebele].filter(Boolean).join(' / ')],
    ['Infant DOB','infant_dob'],['Place','place_of_delivery'],['Period','visit_period'],['Date','visit_date'],
    ['Condition','maternal_condition'],['PPH',tickCell('pph')],['Other comp','other_obs_complication'],
    ['HIV acc',tickCell('hiv_test_accepted')],['Retest',tickCell('hiv_retest_accepted')],['HIV res','hiv_test_result'],['Target pop','target_pop_code'],
    ['ART',tickCell('hiv_linked_art')],['Known+',tickCell('hiv_known_positive')],
    ['Ptnr acc',tickCell('partner_hiv_accepted')],['Ptnr res','partner_hiv_result'],['Ptnr ART',tickCell('partner_linked_art')],
    ['C:Danger',tickCell('cnsl_danger_signs')],['C:BF',tickCell('cnsl_breastfeeding')],['C:NB care',tickCell('cnsl_newborn_care')],['C:FP',tickCell('cnsl_family_planning')],['C:EPI',tickCell('cnsl_epi')],['C:ECD',tickCell('cnsl_ecd')],
    ['NB weight','nb_weight_g'],['Problems','nb_problems'],['Treatment','nb_treatment'],['Outcome','nb_treatment_outcome'],
    ['Death age','nb_death_age_days'],['Death cause','nb_death_cause'],
    ['IPPFP','ippfp_acceptor'],['Method','ippfp_method'],['Remark','remark']],
  fp:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name of client','name'],['Age','age'],['Sex','sex'],['Reg. date','reg_date'],
    ['New',r=>r.acceptor==='new'?'✓':''],['Repeat',r=>r.acceptor==='repeat'?'✓':''],
    ['HIV offered',tickCell('hiv_offered')],['HIV performed',tickCell('hiv_performed')],['HIV result','hiv_result'],
    ['HIV contra. counselling',tickCell('hiv_counselled')],['Linked to ART',tickCell('hiv_linked_art')],
    ['Target pop','target_pop_code'],['Td checked',tickCell('td_checked')],['IUCD contraindicated',tickCell('iud_contraindicated')],
    ['Visit no','visit_no'],['Visit date','visit_date'],['Contraceptive','method'],['Appointment','appointment_date'],['Remark','remark']],
  lafp:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name of client','name'],['Age','age'],['Reg. date','reg_date'],
    ['Date of insertion','insertion_date'],['Type of LAFP','lafp_type'],['Place received','place_code'],
    ['Date of removal','removal_date'],['Duration (months)','duration_months'],['Reason','removal_reason'],
    ['HIV offered',tickCell('hiv_offered')],['HIV performed',tickCell('hiv_performed')],['HIV result','hiv_result'],
    ['HIV counselling',tickCell('hiv_counselled')],['Linked to ART',tickCell('hiv_linked_art')],
    ['Target pop','target_pop_code'],['Post-removal method','post_removal_method'],['Remark','remark']],
  td:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name','name'],['Age','age'],['Woreda','woreda'],['Kebele','kebele'],['Ketena/Gott','ketena'],
    ['Reg. date','reg_date'],['Pregnant',tickCell('pregnant')],
    ['Td-1','dose1'],['Td-2','dose2'],['Td-3','dose3'],['Td-4','dose4'],['Td-5','dose5'],['Remark','remark']],
  hpv:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Girl&rsquo;s name','name'],['Date of birth','dob'],['Age','age'],
    ['Grade','in_school_grade'],['Out of school',tickCell('out_of_school')],
    ['Woreda','woreda'],['Kebele','kebele'],['Ketena/Gott','ketena'],['House no.','house_no'],
    ['Reg. date','reg_date'],['HPV-1','dose1'],['HPV-2','dose2'],['Remark','remark']],
  // MoH register 6 — Integrated MNCH/PMTCT. Items 1-47, then the cohort summary.
  pmtct:[['S.N',(r,i)=>i+1],['Mother&rsquo;s name','name'],['MRN','mrn'],['ART unique ID','art_number'],['Age','age'],['Booking date','booking_date'],
    ['Newly diagnosed &amp; started ART','newly_diagnosed'],['Known HIV+','known_positive'],
    ['LNMP','lnmp'],['EDD','edd'],['GA (weeks)','ga_weeks'],['Ferrous/folic','ifa_provided'],['Syphilis','syphilis_result'],
    ['Feeding option','feeding_option'],['Date of delivery','delivery_date'],['Sex of infant','infant_sex'],
    ['Place of delivery','place_of_delivery'],['Delivery outcome','delivery_outcome'],['ART in labour','art_during_labour'],
    ['Infant ARV prophylaxis','infant_arv_prophylaxis'],['FP counselled','fp_counselled'],
    ['New',r=>r.fp_acceptor==='new'?'✓':''],['Repeat',r=>r.fp_acceptor==='repeat'?'✓':''],['Contraceptive','fp_method'],
    ['Partner accepted',tickCell('partner_accepted')],['Partner tested','partner_result'],['Partner target pop','partner_target_pop'],
    ['Partner linked to ART',tickCell('partner_linked_art')],
    ['TB screening','tb_screening'],['INH started','inh_start_date'],['TB Rx started','tb_rx_date'],['Unit TB no.','tb_unit_number'],
    ['Initial CD4','cd4_count'],['WHO stage','who_stage'],['CPT started','cpt_started'],['ART initiated','art_start_date'],['Initial regimen','art_regimen'],
    ['Infant MRN','infant_mrn'],['Infant DOB','infant_dob'],['HEI enrolment','hei_enrol_date'],['Infant ARV date','arv_start_date'],['Infant feeding (6m)','feeding_6m'],
    ['Age (wks) CPT','cpt_age_weeks'],['Age (wks) DNA/PCR','pcr_age_weeks'],['DNA/PCR result','pcr_result'],['Rapid HIV-Ab','rapid_ab_result'],
    ['Counselled CCD','cnsl_ccd'],['Counselled nutrition','cnsl_nutrition'],
    ['Cohort month 0','cohort_month0'],['Mother status','mother_status'],['Latest viral load','last_vl'],['Infant outcome','infant_outcome'],
    ['Remark','remark']],
  pregtally:[['Age band','band'],['Women tested','tested'],['HCG positive','positive'],['Negative','negative'],
    ['Negative — FP offered','negative_offered_fp'],['Linked to ANC','linked_to_anc'],['Linked to FP','linked_to_fp']]
};
function tickCell(k){ return r=>(r[k]==1?'✓':''); }   // renders a boolean as the paper's tick

async function registersScreen(){
  // The register export is a facility-wide line list carrying names, MRNs, HIV status and ART
  // regimen. It is not for the read-only observer role, nor for a recorder doing registration.
  if(!(ME.role==='provider'||ME.role==='supervisor'||ADMIN())){
    app().innerHTML=nav()+'<div class="card"><h3>Registers</h3><p class="muted">The MoH register export carries HIV status and ART details for every woman at this facility. It is available to providers, supervisors and administrators.</p></div>';
    return;
  }
  const t=window._regType||'anc';
  const from=window._regFrom||localDate().slice(0,8)+'01';
  const to=window._regTo||localDate();
  const opt=(v,n)=>`<option value="${v}"${t===v?' selected':''}>${n}</option>`;
  app().innerHTML=nav()+`<div class="card">
   <h3>MoH register export</h3>
   <p class="muted">The official Ethiopian MoH register, generated from what has been recorded. Print it, or export to CSV. Person-level items (target population, HIV linkage, partner testing) are filled in automatically on every row.</p>
   <div class="grid">
    <label>Register<select id="rt">
      ${opt('anc','3. Antenatal care (ANC)')}${opt('delivery','4. Delivery')}${opt('pnc','5. Postnatal care (PNC)')}
      ${opt('fp','1. Family planning')}${opt('lafp','2. Long-acting FP removal')}
      ${opt('pmtct','6. PMTCT — integrated MNCH/PMTCT')}
      ${opt('td','10. Td immunization')}${opt('hpv','9. HPV immunization')}
      ${opt('pregtally','Pregnancy test — tally sheet')}
    </select></label>
    <label>From<input id="rf" type="date" value="${from}"></label>
    <label>To<input id="rto" type="date" value="${to}"></label>
   </div>
   <button class="act" id="rgen" style="margin-top:8px">Generate</button>
   <button class="sec" id="rprint" style="margin-top:8px">Print</button>
   <button class="sec" id="rcsv" style="margin-top:8px">Export CSV</button>
   <span class="muted" id="rm"></span></div>
   <div id="regout"></div>`;
  const load=async()=>{
    window._regType=rt.value; window._regFrom=rf.value; window._regTo=rto.value;
    $('#rm').textContent=' loading…';
    let d; try{ d=await api('GET','registers?type='+rt.value+'&from='+rf.value+'&to='+rto.value); }
    catch(e){ $('#rm').textContent=' '+(e.message||'error'); return; }
    const cols=REG_COLS[d.type]||[]; const rows=d.rows||[];
    const cell=(r,c,i)=>{ const g=c[1]; const v=(typeof g==='function')?g(r,i):r[g]; return (v===null||v===undefined)?'':String(v); };
    window._regCsv=[cols.map(c=>c[0].replace(/&lt;/g,'<')).join(',')]
      .concat(rows.map((r,i)=>cols.map(c=>'"'+cell(r,c,i).replace(/"/g,'""')+'"').join(','))).join('\n');
    $('#rm').textContent=' '+d.count+' row(s)';
    const RNAME={anc:'ANC register',delivery:'Delivery register',pnc:'PNC register',fp:'Family planning register',
      lafp:'Long-acting FP removal register',td:'Td immunization register',hpv:'HPV immunization register',
      pmtct:'Integrated MNCH/PMTCT register — one row per exposed infant',
      pregtally:'Pregnancy test — tally sheet (aggregate, by age band)'};
    $('#regout').innerHTML=`<div class="card"><h3>${esc(RNAME[d.type]||d.type)}</h3>
      <p class="muted">${esc(d.facility||'')} &middot; ${esc(d.from)} to ${esc(d.to)} &middot; ${d.count} row(s)</p>
      <div style="overflow-x:auto"><table style="font-size:11px;white-space:nowrap">
      <tr>${cols.map(c=>'<th>'+c[0]+'</th>').join('')}</tr>
      ${rows.map((r,i)=>'<tr>'+cols.map(c=>'<td>'+esc(cell(r,c,i))+'</td>').join('')+'</tr>').join('')
        ||('<tr><td colspan='+cols.length+' class=muted>Nothing recorded in this period.</td></tr>')}
      </table></div></div>`;
  };
  $('#rgen').onclick=load;
  $('#rprint').onclick=()=>window.print();
  $('#rcsv').onclick=()=>{ if(!window._regCsv){ toast('Generate the register first'); return; }
    const bl=new Blob([window._regCsv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(bl); a.download='moh_'+rt.value+'_register_'+rf.value+'_to_'+rto.value+'.csv'; a.click(); };
  load();
}

// ============================================================================
// FAMILY PLANNING  (MoH register 1, 21 items)  +  LAFP REMOVAL (register 2, 19 items)
// One module: same room, same provider, same client.
// NB the FP register has a Sex column — FP clients include MEN (condoms, vasectomy),
// so FP clients have their own identity and are not forced into the maternity record.
// ============================================================================
const FP_METHODS=[['MaC','Male condom'],['FeC','Female condom'],['OC','Oral contraceptive'],['Inj','Injectable'],
 ['EC','Emergency contraception'],['Diaph','Diaphragm'],['IUCD','IUCD (intrauterine device)'],['Imp','Implant'],
 ['TL','Tubal ligation (permanent)'],['V','Vasectomy (permanent)'],['Oth','Other']];
const LAFP_TYPES=[['Implanon','Implanon implant'],['Sino-Implant','Sino-Implant'],['Jadelle','Jadelle implant'],['IUD','IUD'],['Other','Other']];
const LAFP_PLACE=[['WI','Within this facility'],['1','Hospital'],['2','Health centre'],['3','Health post'],['4','Private clinic']];
const LAFP_REASON=[['a','a. On recommended time'],['b','b. Side effect'],['c','c. Wants to get pregnant'],['d','d. Misconception'],['e','e. Other']];
const IUD_CONTRA=['Client (or partner) has other sex partners','STI of the genital tract in the last 3 months, or chronic STI (HBV, HIV)',
 'Pelvic infection (PID) or ectopic pregnancy in the last 3 months','Heavy menstrual bleeding','Severe dysmenorrhoea needing analgesics or bed rest',
 'Bleeding or spotting between periods or after intercourse','Symptomatic valvular heart disease','Other'];

async function fpScreen(){
  const tab=window._fpTab||'fp';
  const [clients,removals]=await Promise.all([api('GET','fp_clients').catch(()=>[]),api('GET','lafp').catch(()=>[])]);
  const T=(k,t)=>`<a class="nav${tab===k?' on':''}" href="#fp" data-fptab="${k}">${t}</a>`;
  app().innerHTML=nav()+`<div class="card"><h3>Family planning</h3>
   <p class="muted">Contraceptive services and long-acting method removal. Clients here may be men or women, and need not be maternity patients.</p>
   <nav class="navbar" style="margin:0 0 10px">${T('fp','Contraceptive services')}${T('lafp','LAFP removal')}</nav>

   ${tab==='fp'?`
   <button class="act" id="fpnew">New FP client</button>
   <table style="margin-top:10px"><tr><th>MRN</th><th>Name</th><th>Age</th><th>Sex</th><th>Acceptor</th><th>Registered</th><th></th></tr>
    ${(clients||[]).map(c=>`<tr><td>${esc(c.mrn||'')}</td><td>${esc(c.name||'')}</td><td>${esc(c.age||'')}</td><td>${esc(c.sex||'')}</td>
      <td>${c.acceptor==='new'?'<span class="pill green">New</span>':(c.acceptor==='repeat'?'<span class="pill">Repeat</span>':'')}${c.from_preg_test_id?' <span class="pill amber">from neg. test</span>':''}</td>
      <td>${esc(c.reg_date||'')}</td><td><a class="nav" href="#fpclient/${c.id}">Open</a></td></tr>`).join('')
      ||'<tr><td colspan=7 class=muted>No family planning clients yet.</td></tr>'}
   </table>`:`
   <button class="act" id="lnew">Record a removal</button>
   <table style="margin-top:10px"><tr><th>MRN</th><th>Name</th><th>Method</th><th>Inserted</th><th>Removed</th><th>Months</th><th>Reason</th><th>Post-removal</th></tr>
    ${(removals||[]).map(r=>`<tr><td>${esc(r.mrn||'')}</td><td>${esc(r.name||'')}</td><td>${esc(r.lafp_type||'')}</td><td>${esc(r.insertion_date||'')}</td>
      <td>${esc(r.removal_date||'')}</td><td>${esc(r.duration_months??'')}</td>
      <td>${esc((LAFP_REASON.find(x=>x[0]===r.removal_reason)||[,''])[1])}</td><td>${esc(r.post_removal_method||'—')}</td></tr>`).join('')
      ||'<tr><td colspan=8 class=muted>No removals recorded yet.</td></tr>'}
   </table>`}
   </div>
   <div id="fpform"></div>`;
  document.querySelectorAll('[data-fptab]').forEach(a=>a.onclick=(e)=>{ e.preventDefault(); window._fpTab=a.dataset.fptab; fpScreen(); });
  if($('#fpnew')) $('#fpnew').onclick=()=>fpNewForm();
  if($('#lnew'))  $('#lnew').onclick=()=>lafpForm();
}

function fpNewForm(){
  $('#fpform').innerHTML=`<div class="card"><h3>New family planning client</h3>
   <div class="grid">
    <label>MRN<input id="fmrn"></label>
    <label>Name of client<input id="fnm"></label>
    <label>Age<input id="fage" type="number" min="10" max="70"></label>
    <label>Sex<select id="fsex">${selOpts([['F','Female'],['M','Male']])}</select></label>
    ${ecPicker('freg','Registration date',true)}
    <label>Acceptor<select id="facc">${selOpts(ACCEPTOR)}</select></label>
    ${tpSel('ftp','Targeted population category')}
    <label>HIV test result<select id="fhr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
   </div>
   <div class="ticks">${tick('fho','HIV test offered')}${tick('fhp','HIV test performed')}${tick('fhc','HIV-specific contraceptive counselling offered')}${tick('fla','HIV positive — linked to ART')}${tick('ftd','Td status checked')}</div>

   <details class="moh"><summary>Contraindications for IUCD</summary>
    <div class="muted" style="font-size:12px;margin-bottom:6px">Tick any that apply. If any is present, IUCD is contraindicated.</div>
    <div class="ticks">${IUD_CONTRA.map((t,i)=>tick('iud'+i,t)).join('')}</div></details>

   <button class="act" id="fsave" style="margin-top:10px">Save client</button> <span class="muted" id="fm"></span></div>`;
  $('#fsave').onclick=async()=>{
    const b=$('#fsave'); if(b.disabled) return; b.disabled=true;
    try{
      if(!fnm.value.trim()){ modal('Name required','Enter the client&rsquo;s name.'); return; }
      const contra=IUD_CONTRA.filter((t,i)=>tk('iud'+i));
      const r=await api('POST','fp_clients',{mrn:(fmrn.value||null),name:fnm.value,age:(+fage.value||null),sex:fsex.value,
        reg_date:ecGet('freg'),acceptor:(facc.value||null),target_pop_code:(ftp.value||null),
        hiv_offered:tk('fho'),hiv_performed:tk('fhp'),hiv_result:(fhr.value||null),hiv_counselled:tk('fhc'),hiv_linked_art:tk('fla'),
        td_checked:tk('ftd'),iud_contraindicated:(contra.length?1:0),iud_contra_detail:(contra.join('; ').slice(0,180)||null)});
      if(r&&r.id){ toast('Client registered','ok'); location.hash='#fpclient/'+r.id; }
      else $('#fm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

async function fpClient(id){
  // Ask the server for THIS client, not for the first 300 and then hunt through them. See epOne().
  const [cs,visits]=await Promise.all([api('GET','fp_clients?id='+id).catch(()=>[]),api('GET','fp_visits?client='+id).catch(()=>[])]);
  const c=(cs||[])[0]||{};
  if(!c.id) toast('Could not load this family-planning record — please go back and open her again.');
  const nextNo=Math.min(5,(visits||[]).length+1);
  app().innerHTML=nav()+`<div class="card"><h3>${esc(c.name||'FP client')} <span class="muted" style="font-size:13px;font-weight:400">— ${esc(c.mrn||'')}</span></h3>
   <p class="muted">${esc(c.age||'?')} yrs · ${c.sex==='M'?'Male':'Female'} · ${c.acceptor==='new'?'New acceptor':'Repeat acceptor'} · Target pop ${esc(c.target_pop_code||'—')}
   ${c.iud_contraindicated==1?' · <span class="pill amber">IUCD contraindicated</span>':''}
   ${c.from_preg_test_id?' · <span class="pill green">came from a negative pregnancy test</span>':''}</p>
   ${c.iud_contraindicated==1?`<div style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>IUCD contraindicated</b> &mdash; ${esc(c.iud_contra_detail||'')}</div>`:''}
   <a class="nav" href="#fp">&lsaquo; Back to family planning</a></div>

   <div class="card"><h3>Record a visit <span class="muted" style="font-size:13px;font-weight:400">— visit ${nextNo} of 5 this year</span></h3>
   <div class="grid">
    <label>Visit number<select id="vno">${selOpts([1,2,3,4,5].map(i=>[i,'Visit '+i]),nextNo)}</select></label>
    ${ecPicker('vdt','Visit date',true)}
    <label>Contraceptive provided<select id="vmth">${selOpts(FP_METHODS)}</select></label>
    ${ecPicker('vapp','Appointment date')}
   </div>
   <label>Remark<input id="vrmk"></label>
   <div id="iudwarn"></div>
   <button class="act" id="vsave" style="margin-top:10px">Save visit</button> <span class="muted" id="vm"></span></div>

   <div class="card"><h3>Visits</h3><table><tr><th>#</th><th>Date</th><th>Method</th><th>Next appointment</th><th>Remark</th></tr>
    ${(visits||[]).map(v=>`<tr><td>${esc(v.visit_no||'')}</td><td>${esc(v.visit_date||'')}</td>
      <td>${esc((FP_METHODS.find(x=>x[0]===v.method)||[,v.method||''])[1])}</td><td>${esc(v.appointment_date||'')}</td><td>${esc(v.remark||'')}</td></tr>`).join('')
      ||'<tr><td colspan=5 class=muted>No visits yet.</td></tr>'}
   </table></div>`;
  const chk=()=>{ $('#iudwarn').innerHTML=(vmth.value==='IUCD'&&c.iud_contraindicated==1)
    ? `<div style="background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>IUCD is contraindicated for this client.</b> ${esc(c.iud_contra_detail||'')} — choose another method or document the clinical justification.</div>` : ''; };
  vmth.addEventListener('change',chk); chk();
  $('#vsave').onclick=async()=>{ const b=$('#vsave'); if(b.disabled) return; b.disabled=true;
    try{ const r=await api('POST','fp_visits',{fp_client_id:+id,visit_no:(+vno.value||null),visit_date:ecGet('vdt'),
        method:(vmth.value||null),appointment_date:ecGet('vapp'),remark:(vrmk.value||null)});
      if(r&&(r.id||r.queued)){ toast('Visit recorded','ok'); setTimeout(()=>fpClient(id),500); }
      else $('#vm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

function lafpForm(){
  $('#fpform').innerHTML=`<div class="card"><h3>Long-acting FP removal</h3>
   <div class="grid">
    <label>MRN<input id="lmrn"></label>
    <label>Name of client<input id="lnm"></label>
    <label>Age<input id="lage" type="number" min="10" max="70"></label>
    ${ecPicker('lreg','Registration date',true)}
    ${ecPicker('lins','Date of insertion')}
    <label>Type of LAFP used<select id="ltyp">${selOpts(LAFP_TYPES)}</select></label>
    <label>Place LAFP was received<select id="lplc">${selOpts(LAFP_PLACE)}</select></label>
    ${ecPicker('lrem','Date of removal',true)}
    <label>Duration used (months)<input id="ldur" type="number" min="0"></label>
    <label>Reason for removal<select id="lrsn">${selOpts(LAFP_REASON)}</select></label>
    ${tpSel('ltp','Targeted population category')}
    <label>HIV test result<select id="lhr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
    <label>Post-removal contraceptive<select id="lpost">${selOpts(FP_METHODS.filter(m=>['MaC','FeC','OC','Inj','EC','Diaph','IUCD','Imp'].includes(m[0])))}</select></label>
   </div>
   <div class="ticks">${tick('lho','HIV test offered')}${tick('lhp','HIV test performed')}${tick('lhc','HIV-specific contraceptive counselling offered')}${tick('lla','HIV positive — linked to ART')}</div>
   <div id="lpostwarn" style="display:none;background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"></div>
   <label>Remark<input id="lrmk"></label>
   <button class="act" id="lsave" style="margin-top:10px">Save removal</button> <span class="muted" id="lm"></span></div>`;
  // A removal for a reason OTHER than wanting to conceive, with no method to follow, is a
  // woman leaving unprotected. Surface it rather than let it pass silently.
  const warn=()=>{ const b=$('#lpostwarn');
    if(lrsn.value && lrsn.value!=='c' && !lpost.value){ b.style.display='';
      b.textContent='She is having a long-acting method removed but no follow-on method is recorded, and she is not removing it to get pregnant. She will leave unprotected — offer a method or document her choice.'; }
    else b.style.display='none'; };
  lrsn.addEventListener('change',warn); lpost.addEventListener('change',warn);
  $('#lsave').onclick=async()=>{ const b=$('#lsave'); if(b.disabled) return; b.disabled=true;
    try{
      if(!lnm.value.trim()){ modal('Name required','Enter the client&rsquo;s name.'); return; }
      const r=await api('POST','lafp',{mrn:(lmrn.value||null),name:lnm.value,age:(+lage.value||null),
        reg_date:ecGet('lreg'),insertion_date:ecGet('lins'),lafp_type:(ltyp.value||null),place_code:(lplc.value||null),
        removal_date:ecGet('lrem'),duration_months:(+ldur.value||null),removal_reason:(lrsn.value||null),
        hiv_offered:tk('lho'),hiv_performed:tk('lhp'),hiv_result:(lhr.value||null),hiv_counselled:tk('lhc'),hiv_linked_art:tk('lla'),
        target_pop_code:(ltp.value||null),post_removal_method:(lpost.value||null),remark:(lrmk.value||null)});
      if(r&&(r.id||r.queued)){ toast('Removal recorded','ok'); window._fpTab='lafp'; fpScreen(); }
      else $('#lm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

// ============================================================================
// IMMUNIZATION  —  Td (MoH register 10)  +  HPV (MoH register 9)
// Both registers have the same shape: a client, and a set of dated doses.
// Td: 5 doses, with separate schedules for pregnant and non-pregnant women.
// HPV: 2 doses, for schoolgirls — who are NOT maternity patients, hence their own identity.
// ============================================================================
const TD_SCHEDULE={1:'At the first ANC contact',2:'At least 4 weeks after Td-1',3:'At least 6 months after Td-2',
 4:'At least 1 year after Td-3',5:'At least 1 year after Td-4'};
const TD_PROTECTION={1:'0%',2:'80% (1–3 years)',3:'95% (5 years)',4:'99% (10 years)',5:'99% (all childbearing years)'};

async function immScreen(){
  const prog=window._immProg||'Td';
  const clients=await api('GET','imm_clients?programme='+prog).catch(()=>[]);
  const T=(k,t)=>`<a class="nav${prog===k?' on':''}" href="#imm" data-prog="${k}">${t}</a>`;
  app().innerHTML=nav()+`<div class="card"><h3>Immunization</h3>
   <p class="muted">${prog==='Td'?'Tetanus–diphtheria for women. Td-1 and Td-2 are the minimum in pregnancy; Td-2 gives 80% protection, Td-3 gives 95%.':'HPV vaccination for girls — two doses. Girls here are not maternity patients, so they have their own record.'}</p>
   <nav class="navbar" style="margin:0 0 10px">${T('Td','Td — tetanus/diphtheria')}${T('HPV','HPV — girls')}</nav>
   <button class="act" id="inew">New ${prog} client</button>
   <table style="margin-top:10px"><tr><th>MRN</th><th>Name</th><th>Age</th>${prog==='Td'?'<th>Pregnant</th>':'<th>School</th>'}<th>Doses</th><th>Status</th><th></th></tr>
    ${(clients||[]).map(c=>{ const n=+c.dose_count||0;
      const done=(prog==='Td')?(n>=2):(n>=2);
      return `<tr><td>${esc(c.mrn||'')}</td><td>${esc(c.name||'')}</td><td>${esc(c.age||'')}</td>
       <td>${prog==='Td'?(c.pregnant==1?'Yes':'No'):(c.out_of_school==1?'Out of school':('Grade '+esc(c.in_school_grade||'?')))}</td>
       <td>${n}</td>
       <td>${done?'<span class="pill green">'+(prog==='Td'?'Td2+ ✓':'Complete ✓')+'</span>':'<span class="pill amber">Incomplete</span>'}</td>
       <td><a class="nav" href="#immclient/${c.id}">Open</a></td></tr>`;}).join('')
      ||'<tr><td colspan=7 class=muted>No '+prog+' clients yet.</td></tr>'}
   </table></div>
   <div id="immform"></div>`;
  document.querySelectorAll('[data-prog]').forEach(a=>a.onclick=(e)=>{ e.preventDefault(); window._immProg=a.dataset.prog; immScreen(); });
  $('#inew').onclick=()=>immNewForm(prog);
}

function immNewForm(prog){
  $('#immform').innerHTML=`<div class="card"><h3>New ${prog} client</h3>
   <div class="grid">
    <label>MRN<input id="imrn"></label>
    <label>${prog==='HPV'?'Girl&rsquo;s name':'Name'}<input id="inm"></label>
    <label>Age<input id="iage" type="number" min="${prog==='HPV'?8:10}" max="${prog==='HPV'?18:60}"></label>
    ${prog==='HPV'?ecPicker('idob','Date of birth'):''}
    ${prog==='Td'?`<label>Pregnant?<select id="ipreg">${selOpts([['1','Yes — pregnant'],['0','No — not pregnant']])}</select></label>`:''}
    ${prog==='HPV'?`<label>In school (grade)<input id="igrd" placeholder="e.g. 5"></label>`:''}
    <label>Woreda<input id="iwor"></label>
    <label>Kebele<input id="ikeb"></label>
    <label>Ketena / Gott<input id="iket"></label>
    ${prog==='HPV'?`<label>House no.<input id="ihse"></label>`:''}
    ${ecPicker('ireg','Registration date',true)}
   </div>
   ${prog==='HPV'?`<div class="ticks">${tick('ioos','Out of school')}</div>`:''}
   <label>Remark<input id="irmk"></label>
   <button class="act" id="isave" style="margin-top:10px">Save client</button> <span class="muted" id="im"></span></div>`;
  $('#isave').onclick=async()=>{ const b=$('#isave'); if(b.disabled) return; b.disabled=true;
    try{
      if(!inm.value.trim()){ modal('Name required','Enter the client&rsquo;s name.'); return; }
      const r=await api('POST','imm_clients',{programme:prog,mrn:(imrn.value||null),name:inm.value,age:(+iage.value||null),
        dob:(prog==='HPV'?ecGet('idob'):null),
        pregnant:(prog==='Td'?(($('#ipreg')||{}).value===''?null:+$('#ipreg').value):null),
        in_school_grade:(prog==='HPV'?(($('#igrd')||{}).value||null):null),
        out_of_school:(prog==='HPV'?tk('ioos'):null),
        woreda:(iwor.value||null),kebele:(ikeb.value||null),ketena:(iket.value||null),
        house_no:(prog==='HPV'?(($('#ihse')||{}).value||null):null),
        reg_date:ecGet('ireg'),remark:(irmk.value||null)});
      if(r&&r.id){ toast('Client registered','ok'); location.hash='#immclient/'+r.id; }
      else $('#im').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

async function immClient(id){
  const [cs,doses]=await Promise.all([api('GET','imm_clients?id='+id).catch(()=>[]),api('GET','imm_doses?client='+id).catch(()=>[])]);
  const c=(cs||[])[0]||{};
  if(!c.id) toast('Could not load this immunisation record — please go back and open her again.');
  const prog=c.programme||'Td';
  const maxDose=(prog==='Td')?5:2;
  const given={}; (doses||[]).forEach(d=>given[d.dose_no]=d.dose_date);
  const n=Object.keys(given).length;
  const nextDose=[...Array(maxDose)].map((_,i)=>i+1).find(i=>!given[i]);
  app().innerHTML=nav()+`<div class="card"><h3>${esc(c.name||'Client')} <span class="muted" style="font-size:13px;font-weight:400">— ${esc(prog)} · ${esc(c.mrn||'')}</span></h3>
   <p class="muted">${esc(c.age||'?')} yrs${prog==='Td'?(c.pregnant==1?' · <b>pregnant</b>':' · not pregnant'):(c.out_of_school==1?' · out of school':' · grade '+esc(c.in_school_grade||'?'))} · ${esc([c.woreda,c.kebele,c.ketena].filter(Boolean).join(', ')||'—')}</p>
   ${(prog==='Td'&&c.pregnant==1&&n<2)?`<div style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"><b>Td-2 not yet given.</b> A pregnant woman needs at least Td-1 and Td-2 to protect her and the newborn against tetanus. Td-2 must be at least 4 weeks after Td-1, and at least 2 weeks before the due date.</div>`:''}
   ${(prog==='HPV'&&n>=2)?`<div style="background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">HPV schedule complete — both doses given.</div>`:''}
   <a class="nav" href="#imm">&lsaquo; Back to immunization</a></div>

   <div class="card"><h3>Doses</h3>
    <table><tr><th>Dose</th><th>Date given</th>${prog==='Td'?'<th>When it is due</th><th>Protection</th>':''}</tr>
    ${[...Array(maxDose)].map((_,i)=>{const d=i+1; return `<tr>
      <td><b>${prog}-${d}</b></td>
      <td>${given[d]?esc(given[d]):'<span class="muted">not given</span>'}</td>
      ${prog==='Td'?`<td class="muted" style="font-size:12px">${TD_SCHEDULE[d]}</td><td class="muted" style="font-size:12px">${TD_PROTECTION[d]}</td>`:''}
    </tr>`;}).join('')}
    </table>

    ${nextDose?`<div class="grid" style="margin-top:12px">
      <label>Record dose<select id="dno">${selOpts([...Array(maxDose)].map((_,i)=>[i+1,prog+'-'+(i+1)+(given[i+1]?' (re-record)':'')]),nextDose)}</select></label>
      ${ecPicker('ddt','Date given',true)}
     </div>
     <button class="act" id="dsave" style="margin-top:10px">Save dose</button> <span class="muted" id="dm"></span>`
     :`<p class="muted" style="margin-top:10px">All ${maxDose} doses recorded.</p>`}
   </div>`;
  if($('#dsave')) $('#dsave').onclick=async()=>{ const b=$('#dsave'); if(b.disabled) return; b.disabled=true;
    try{ const r=await api('POST','imm_doses',{client_id:+id,dose_no:+dno.value,dose_date:ecGet('ddt')});
      if(r&&(r.id||r.queued)){ toast(prog+'-'+dno.value+' recorded','ok'); setTimeout(()=>immClient(id),500); }
      else $('#dm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

// ============================================================================
// PMTCT  (MoH register 6 — Integrated MNCH/PMTCT register, 47 items + cohort grid)
//
// This is a COHORT register, not an encounter register. The mother and her HIV-exposed
// infant are each followed month by month, and the whole point is the outcome:
//   * is she retained on ART with an undetectable viral load, and
//   * did the infant get a DNA/PCR at about 6 weeks and end up HIV-negative?
// Everything below exists to make those two questions answerable at a glance.
// ============================================================================
const PM_ENTRY=[['1','Newly diagnosed at ANC'],['2','Newly diagnosed in labour &amp; delivery'],['3','Newly diagnosed postpartum']];
const PM_KNOWN=[['1','Known positive — already on ART at entry'],['2','Known positive — NOT on ART at entry']];
const PM_FEED=[['EBF','EBF — exclusive breastfeeding'],['ERF','ERF — exclusive replacement feeding'],['MF','MF — mixed feeding']];
const PM_PLACE=[['1','This facility'],['2','Another health facility'],['3','Home']];
const PM_PN=[['P','Positive'],['N','Negative'],['ND','Not done']];
const PM_MSTATUS=[['on_art','Alive and on ART'],['ltf','Lost to follow-up'],['transferred_out','Transferred out'],
  ['transferred_in','Transferred in'],['malnourished','Malnourished'],['died','Died']];
const PM_ISTATUS=[['exposed_bf','Exposed — still breastfeeding'],['discharged_negative','Discharged negative'],
  ['positive','HIV positive'],['ltf','Lost to follow-up'],['transferred_out','Transferred out'],['died','Died']];
const PM_IOUT=[['discharged_negative','Discharged HIV-negative'],['positive_on_art','HIV positive — on ART'],
  ['ltf','Lost to follow-up'],['transferred_out','Transferred out'],['died','Died']];

const wksSince=(d)=>{ if(!d) return null; const t=Date.parse(d); if(isNaN(t)) return null; return Math.floor((Date.now()-t)/6048e5); };
const monthsSince=(d)=>{ if(!d) return null; const t=Date.parse(d); if(isNaN(t)) return null; return Math.floor((Date.now()-t)/2629800000); };
const onArt=(m)=>!!(m.art_start_date || String(m.known_positive)==='1');

// The reference date for "how long has she been in care". A woman who transfers in from an
// ART clinic is already on ART and has no art_start_date in OUR record — so anchoring the
// viral-load schedule to art_start_date alone meant the largest client group was never once
// asked for a viral load. Fall back to the date we first saw her.
const artRef=(m)=>m.art_start_date||m.booking_date||null;

// Cheap triage from the LIST row alone (no per-mother fetch), so the home tile and the
// cohort table can both say "this one needs you" without N+1 requests.
function pmtctNeedsAction(m){
  if(+m.pcr_pos) return true;                    // an infant has tested HIV POSITIVE — never let this go quiet
  if(!onArt(m)) return true;
  if(m.last_vl==='detectable') return true;
  if(m.last_status==='ltf') return true;
  if(m.feeding_option==='MF') return true;
  if(!m.last_vl && monthsSince(artRef(m))>=3) return true;   // viral load never done, and it is due
  if(m.delivery_date && m.delivery_outcome==='LB' && !(+m.infant_count)) return true;
  // Anchor on the INFANT's own date of birth when we have it. Anchoring only on the mother's
  // delivery date meant an exposed infant of a home or other-facility birth — the register's
  // own codes 2 and 3 — was never once surfaced as due for her DNA/PCR.
  const ageW=wksSince(m.first_infant_dob||m.delivery_date);
  if((+m.infant_count) > (+m.pcr_done) && ageW!=null && ageW>=6) return true;   // EID due or overdue
  return false;
}

// The clinical to-do list for one mother-infant pair. This is the module's real value:
// it turns a register into a worklist.
function pmtctAlerts(m,infants){
  const a=[];
  // The infant's HIV result comes FIRST. Nothing else on this screen outranks it.
  (infants||[]).forEach((i,n)=>{
    if(i.pcr_result==='P' || i.rapid_ab_result==='P')
      a.push(['red',esc(infName(i,n))+' &mdash; HIV POSITIVE','This infant is HIV infected. Link her to the ART clinic <b>today</b> and start antiretroviral treatment. Record the outcome as &ldquo;HIV positive &mdash; on ART&rdquo; once she is linked.']);
  });
  if(!onArt(m)) a.push(['red','Not on ART','She is HIV positive and no ART start date is recorded. ART is the single most effective intervention to prevent transmission to the infant — start it today and record the date below.']);
  const vl=(m.last_vl||'');
  if(vl==='detectable') a.push(['red','Viral load detectable (&gt;1,000 copies/ml)','Transmission risk to the infant is high. Give enhanced adherence counselling, repeat the viral load after 3 months, and refer for regimen review if it stays detectable.']);
  // Anchored to artRef, not art_start_date: a woman who transferred in already on ART has no
  // start date here, and used to escape viral-load surveillance entirely.
  const mRef=artRef(m);
  if(onArt(m) && mRef && !vl && monthsSince(mRef)>=3)
    a.push(['amber','Viral load overdue','The first viral load is due 3 months after ART initiation, then every 6 months. She has been in care '+monthsSince(mRef)+' months and none has been recorded.']);
  if(m.feeding_option==='MF') a.push(['red','Mixed feeding','Mixed feeding carries the highest risk of transmission of the three options. Counsel her to choose either exclusive breastfeeding or exclusive replacement feeding, and record the change below.']);
  if(m.last_status==='ltf') a.push(['red','Lost to follow-up','She has missed her appointment by more than two months. Trace her — she and the infant are both at risk.']);
  if(m.delivery_date && m.delivery_outcome==='LB' && !(infants||[]).length)
    a.push(['amber','Infant not enrolled','She has delivered a live baby but no HIV-exposed infant is enrolled in the HEI cohort. Enrol the infant so early infant diagnosis can be tracked.']);
  if(m.delivery_date && m.infant_arv_prophylaxis!=='Y' && m.delivery_outcome==='LB')
    a.push(['red','Infant ARV prophylaxis not given','The infant needs AZT + NVP for the first 6 weeks, then NVP alone for the next 6 weeks — 12 weeks in total.']);
  if(m.tb_screening==='P' && !m.tb_rx_date) a.push(['amber','TB screen positive, no treatment recorded','She screened positive for TB symptoms and no TB treatment start date is recorded.']);
  (infants||[]).forEach((i,n)=>{
    // Once an infant's follow-up is CLOSED, stop nagging about her. Alerts that fire forever
    // are alerts nobody reads — and this is the one screen where they must be trusted.
    if(['died','transferred_out','discharged_negative','positive_on_art'].includes(i.outcome)) return;
    const nm=esc(infName(i,n));
    const ageW=infAgeWks(i,m);
    if(i.pcr_result==null && ageW!=null && ageW>=6)
      a.push([ageW>8?'red':'amber',nm+' — DNA/PCR due','The infant is '+ageW+' weeks old. The DNA/PCR test is due at 6 weeks of age'+(ageW>8?' and is now overdue':'')+'. Collect the sample and send it.']);
    if(i.pcr_result==null && ageW==null)
      a.push(['amber',nm+' — date of birth missing','Her age cannot be worked out, so ADHERE+ cannot tell you when her DNA/PCR is due. Record her date of birth.']);
    if(i.pcr_result==='N' && i.cpt_age_weeks==null)
      a.push(['amber',nm+' — cotrimoxazole not started','Cotrimoxazole prophylaxis is given to every HIV-exposed infant from 6 weeks until HIV infection is excluded.']);
    if(!i.arv_start_date) a.push(['red',nm+' — no ARV prophylaxis date','Record the date the infant started ARV prophylaxis.']);
  });
  return a;
}
function infName(i,n){ return 'Infant '+(n+1)+(i.mrn?' ('+i.mrn+')':''); }
// Her OWN date of birth first. Falling back to the mother's delivery date only works for
// facility births — and the register's own codes say most are elsewhere (2=other facility,
// 3=home), which is precisely where an untested exposed infant goes missing.
function infAgeWks(i,m){
  const d = i.infant_dob || m.delivery_date || i.hei_enrol_date || null;
  return wksSince(d);
}
function alertBox(tone,title,text){
  const c = tone==='red' ? ['#fcebeb','#f09595','#791f1f'] : ['#faeeda','#ef9f27','#633806'];
  return `<div style="background:${c[0]};border:1px solid ${c[1]};color:${c[2]};border-radius:10px;padding:9px 12px;margin:6px 0;font-size:13px"><b>${title}</b> &mdash; ${text}</div>`;
}

async function pmtctScreen(){
  const rows=await api('GET','pmtct').catch(()=>[]);
  const need=(rows||[]).filter(pmtctNeedsAction).length;
  app().innerHTML=nav()+`<div class="card"><h3>PMTCT</h3>
   <p class="muted">Preventing mother-to-child transmission. Every HIV-positive mother and her exposed infant are followed as a cohort from enrolment until the infant&rsquo;s HIV status is finally known.</p>
   ${need?alertBox('amber',need+' mother'+(need>1?'s':'')+' need action',
      'Something is outstanding in their cascade &mdash; not on ART, a detectable viral load, an infant not yet tested, or lost to follow-up. Open each one to see what.'):''}
   <button class="act" id="pnew">Enrol a mother</button>
   <table style="margin-top:10px"><tr><th></th><th>ART no.</th><th>Name</th><th>Age</th><th>Enrolled</th><th>On ART</th><th>Viral load</th><th>Infants</th><th>EID</th><th>Status</th><th></th></tr>
    ${(rows||[]).map(m=>{
      const vl=m.last_vl||'';
      const vlPill = vl==='undetectable' ? '<span class="pill green">Undetectable</span>'
                   : vl==='detectable'   ? '<span class="pill red">Detectable</span>'
                   : '<span class="pill amber">Not done</span>';
      const nI=+m.infant_count||0, nP=+m.pcr_done||0, nPos=+m.pcr_pos||0;
      // A POSITIVE infant is never "green — tested". It is the worst outcome in the module.
      const eid = nPos ? '<span class="pill red">'+nPos+' HIV POSITIVE</span>'
                : !nI ? '<span class="muted">—</span>'
                : nP>=nI ? '<span class="pill green">'+nP+'/'+nI+' tested</span>'
                : '<span class="pill amber">'+nP+'/'+nI+' tested</span>';
      return `<tr><td>${pmtctNeedsAction(m)?'<span title="Something is outstanding — open her">&#9888;&#65039;</span>':''}</td>
       <td>${esc(m.art_number||'—')}</td><td>${esc(m.name||'')}</td><td>${esc(m.age||'')}</td>
       <td>${esc(m.booking_date||'')}</td>
       <td>${onArt(m)?'<span class="pill green">Yes</span>':'<span class="pill red">No</span>'}</td>
       <td>${vlPill}</td><td>${nI||'<span class="muted">—</span>'}</td><td>${eid}</td>
       <td>${m.last_status==='ltf'?'<span class="pill red">LTF</span>':(m.last_status==='died'?'<span class="pill red">Died</span>':(m.last_status==='transferred_out'?'<span class="pill">TO</span>':'<span class="pill green">Active</span>'))}</td>
       <td><a class="nav" href="#pmtctclient/${m.id}">Open</a></td></tr>`;}).join('')
      ||'<tr><td colspan=11 class=muted>No mothers enrolled in PMTCT yet.</td></tr>'}
   </table></div>
   <div id="pmform"></div>`;
  $('#pnew').onclick=()=>pmtctNewForm();
}

function pmtctNewForm(){
  $('#pmform').innerHTML=`<div class="card"><h3>Enrol a mother in PMTCT</h3>
   <p class="muted">If she is already registered for maternity care, link her record &mdash; her delivery and her newborn then flow into the PMTCT cohort automatically instead of being typed twice.</p>
   <div class="grid">
    <label>Link her maternity record (MRN or name)<input id="pmq" placeholder="type to search — optional"></label>
    <label>&nbsp;<select id="pmw"><option value="">— not linked / not registered —</option></select></label>
   </div>
   <div class="grid">
    <label>Mother&rsquo;s name<input id="pmnm"></label>
    <label>MRN<input id="pmmrn"></label>
    <label>Age<input id="pmage" type="number" min="10" max="60"></label>
    <label>ART unique ID number<input id="pmart" placeholder="e.g. 03/09/001/00001"></label>
    ${ecPicker('pmbk','Booking date',true)}
   </div>
   <p class="muted" style="font-size:12px;margin:-2px 0 8px">ART number is region / facility type / facility / patient. Facility type: 08 = hospital, 09 = health centre.</p>

   <h4 style="margin:12px 0 4px">How did she enter PMTCT?</h4>
   <p class="muted" style="font-size:12px;margin:0 0 6px">She is either newly diagnosed here, or she came in already knowing she is positive. It cannot be both.</p>
   <div class="grid">
    <label>Newly diagnosed &amp; started on ART<select id="pmnd"><option value="">— not newly diagnosed —</option>${selOpts(PM_ENTRY).replace(/^<option value="">.*?<\/option>/,'')}</select></label>
    <label>Known HIV positive<select id="pmkp"><option value="">— not previously known —</option>${selOpts(PM_KNOWN).replace(/^<option value="">.*?<\/option>/,'')}</select></label>
   </div>
   <div id="pmentrywarn"></div>

   <h4 style="margin:12px 0 4px">Antenatal</h4>
   <div class="grid">
    ${ecPicker('pmlnmp','LNMP')}
    ${ecPicker('pmedd','EDD')}
    <label>Gestational age (weeks)<input id="pmga" type="number" min="0" max="45"></label>
    <label>Ferrous sulfate / folic acid given<select id="pmifa">${selOpts([['Y','Yes'],['N','No']])}</select></label>
    <label>Syphilis test result<select id="pmsyph">${selOpts([['R','Reactive'],['NR','Non-reactive'],['ND','Not done']])}</select></label>
    <label>Selected infant feeding option<select id="pmfeed">${selOpts(PM_FEED)}</select></label>
   </div>
   <div id="pmfeedwarn"></div>

   <h4 style="margin:12px 0 4px">HIV care</h4>
   <div class="grid">
    <label>Initial CD4 count<input id="pmcd4" placeholder="value, or ND"></label>
    <label>WHO clinical stage<select id="pmwho">${selOpts([[1,'Stage 1'],[2,'Stage 2'],[3,'Stage 3'],[4,'Stage 4']])}</select></label>
    <label>Cotrimoxazole (CPT) started<select id="pmcpt">${selOpts([['Y','Yes'],['N','No']])}</select></label>
    ${ecPicker('pmarts','Date ART initiated')}
    <label>Initial ART regimen<input id="pmreg" placeholder="e.g. TDF/3TC/DTG"></label>
   </div>

   <h4 style="margin:12px 0 4px">TB screening</h4>
   <div class="grid">
    <label>TB symptom screening<select id="pmtb">${selOpts(PM_PN)}</select></label>
    ${ecPicker('pminh','Date INH prophylaxis started')}
    ${ecPicker('pmtbrx','Date TB treatment started')}
    <label>Unit TB number<input id="pmtbn"></label>
   </div>

   <h4 style="margin:12px 0 4px">Partner</h4>
   <div class="grid">
    <label>Partner HIV result<select id="pmpr">${selOpts(PM_PN)}</select></label>
    ${tpSel('pmptp','Partner target population category')}
   </div>
   <div class="ticks">${tick('pmpa','Partner accepted HIV testing')}${tick('pmpl','HIV-positive partner linked to ART')}</div>

   <div class="ticks" style="margin-top:8px">${tick('pmccd','Counselled on care for child development')}${tick('pmnut','Counselled on nutrition')}</div>
   <label>Remark<input id="pmrmk"></label>
   <button class="act" id="pmsave" style="margin-top:10px">Enrol mother</button> <span class="muted" id="pmm"></span></div>`;

  // Linking her maternity record fills in what we already know, rather than asking twice.
  let wfound=[];
  $('#pmq').addEventListener('input',async()=>{ const q=pmq.value.trim(); if(q.length<1) return;
    wfound=await api('GET','women?q='+encodeURIComponent(q)).catch(()=>[]);
    pmw.innerHTML='<option value="">— not linked / not registered —</option>'+(wfound||[]).map(w=>
      `<option value="${w.id}">${esc(w.mrn||'')} — ${esc((w.first_name||'')+' '+(w.father_name||''))} (${esc(w.age||'?')})</option>`).join(''); });
  $('#pmw').addEventListener('change',()=>{ const w=(wfound||[]).find(x=>x.id==pmw.value); if(!w) return;
    pmnm.value=((w.first_name||'')+' '+(w.father_name||'')).trim(); pmmrn.value=w.mrn||''; pmage.value=w.age||'';
    if(w.lnmp) ecSet('pmlnmp',w.lnmp); if(w.edd) ecSet('pmedd',w.edd);
    if(w.art_regimen) pmreg.value=w.art_regimen;
    // She is in the maternity record as a known HIV-positive woman: that IS her entry point.
    if(String(w.hiv_known_positive)==='1' && !$('#pmnd').value && !$('#pmkp').value){ $('#pmkp').value= w.art_regimen?'1':'2'; entryChk(); }
  });

  const entryChk=()=>{ const nd=$('#pmnd').value, kp=$('#pmkp').value;
    $('#pmentrywarn').innerHTML = (nd&&kp)
      ? alertBox('red','These two cannot both be true','She is either newly diagnosed at this visit, or she came in already knowing she is HIV positive. Choose one and clear the other.')
      : (!nd&&!kp) ? alertBox('amber','Entry point not recorded','Record how she entered PMTCT — it is what the whole cohort is counted by.') : ''; };
  $('#pmnd').addEventListener('change',entryChk); $('#pmkp').addEventListener('change',entryChk);
  const feedChk=()=>{ $('#pmfeedwarn').innerHTML=($('#pmfeed').value==='MF')
    ? alertBox('red','Mixed feeding carries the highest transmission risk','Of the three options, mixed feeding is the most dangerous for the infant. Counsel her towards exclusive breastfeeding or exclusive replacement feeding.') : ''; };
  $('#pmfeed').addEventListener('change',feedChk);

  $('#pmsave').onclick=async()=>{ const b=$('#pmsave'); if(b.disabled) return; b.disabled=true;
    try{
      if(!pmnm.value.trim()){ modal('Name required','Enter the mother&rsquo;s name.'); return; }
      const nd=$('#pmnd').value, kp=$('#pmkp').value;
      if(nd&&kp){ modal('Entry point conflicts','She cannot be both newly diagnosed and previously known positive. Choose one.'); return; }
      if(!nd&&!kp){ modal('Entry point required','Record whether she was newly diagnosed here (and where), or came in already known to be HIV positive. The whole PMTCT cohort is counted by this.'); return; }
      if(pmart.value && !/^\d{2}\/\d{2}\/\d{3}\/\d{4,6}$/.test(pmart.value.trim())){
        modal('Check the ART number','It should look like <b>03/09/001/00001</b> — region / facility type / facility / patient. Correct it, or clear it and add it later.'); return; }
      const r=await api('POST','pmtct',{woman_id:(+pmw.value||null),name:pmnm.value,mrn:(pmmrn.value||null),age:(+pmage.value||null),
        art_number:(pmart.value.trim()||null),booking_date:ecGet('pmbk'),
        newly_diagnosed:(nd?+nd:null),known_positive:(kp?+kp:null),
        lnmp:ecGet('pmlnmp'),edd:ecGet('pmedd'),ga_weeks:(+pmga.value||null),
        ifa_provided:(pmifa.value||null),syphilis_result:(pmsyph.value||null),feeding_option:(pmfeed.value||null),
        cd4_count:(pmcd4.value||null),who_stage:(+pmwho.value||null),cpt_started:(pmcpt.value||null),
        art_start_date:ecGet('pmarts'),art_regimen:(pmreg.value||null),
        tb_screening:(pmtb.value||null),inh_start_date:ecGet('pminh'),tb_rx_date:ecGet('pmtbrx'),tb_unit_number:(pmtbn.value||null),
        partner_accepted:tk('pmpa'),partner_result:(pmpr.value||null),partner_target_pop:(pmptp.value||null),partner_linked_art:tk('pmpl'),
        cnsl_ccd:(tk('pmccd')?'Y':'N'),cnsl_nutrition:(tk('pmnut')?'Y':'N'),remark:(pmrmk.value||null)});
      if(r&&r.id){ toast('Enrolled in PMTCT','ok'); location.hash='#pmtctclient/'+r.id; return; }  // leave disabled: we are navigating away
      $('#pmm').textContent=' '+((r&&r.error)||'error'); b.disabled=false;
    }catch(e){ b.disabled=false; modal('Could not enrol her',esc(e.message||'error')); } };
}

async function pmtctClient(id){
  // Fetch HER record by id. This used to pick her out of the LIMIT-300 list, so past 300
  // mothers she came back as {} — a blank chart showing a false "not on ART" alert, whose
  // Save button then wrote nine NULLs over her real delivery record.
  let m=null;
  try{ m=await api('GET','pmtct/'+id); }catch(e){ m=null; }
  if(!m || !m.id){
    app().innerHTML=nav()+`<div class="card"><h3>PMTCT record not found</h3>
      <p class="muted">This record could not be loaded — it may belong to another facility, or it may have been removed. Nothing has been changed.</p>
      <a class="nav" href="#pmtct">&lsaquo; Back to PMTCT</a></div>`;
    return;
  }
  const [infants,fu]=await Promise.all([
    api('GET','pmtct_infants?mother='+id).catch(()=>[]),
    api('GET','pmtct_fu?mother='+id).catch(()=>[])]);

  // If she is linked to her maternity record, pull the newborns that were actually delivered
  // here. An exposed baby recorded in the delivery room must not have to be typed again to
  // exist in the PMTCT cohort — that gap is exactly how exposed infants get lost.
  let borne=[];
  if(m.woman_id){
    try{
      const hers=(await api('GET','episodes?woman='+m.woman_id)||[]).filter(e=>e.service_category==='labour');
      const sets=await Promise.all(hers.map(e=>api('GET','babies?episode='+e.id).catch(()=>[])));
      borne=[].concat(...sets.map(s=>s||[]));
    }catch(e){}
  }
  const enrolled=new Set((infants||[]).map(i=>+i.baby_id).filter(Boolean));
  const unlinked=borne.filter(b=>!enrolled.has(+b.id) && b.outcome==='live_birth');

  const alerts=pmtctAlerts(m,infants);
  const mfu=(fu||[]).filter(f=>f.subject==='mother').sort((a,b)=>a.month_no-b.month_no);
  const nextMonth=(mfu.length?Math.max(...mfu.map(f=>+f.month_no))+1:0);
  const fuSub=window._pmFuSub||'mother';
  const entry = String(m.known_positive)==='1' ? 'Known positive — on ART at entry'
              : String(m.known_positive)==='2' ? 'Known positive — not on ART at entry'
              : (PM_ENTRY.find(x=>x[0]===String(m.newly_diagnosed))||[,'—'])[1];

  app().innerHTML=nav()+`<div class="card">
   <h3>${esc(m.name||'PMTCT client')} <span class="muted" style="font-size:13px;font-weight:400">— ${esc(m.art_number||m.mrn||'')}</span></h3>
   <p class="muted">${esc(m.age||'?')} yrs · enrolled ${esc(m.booking_date||'—')} · ${entry.replace(/&amp;/g,'&')}
     ${m.art_regimen?' · '+esc(m.art_regimen):''} ${m.feeding_option?' · feeding: '+esc(m.feeding_option):''}</p>
   <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
     <span class="pill ${onArt(m)?'green':'red'}">${onArt(m)?'On ART':'Not on ART'}</span>
     <span class="pill ${m.last_vl==='undetectable'?'green':(m.last_vl==='detectable'?'red':'amber')}">Viral load: ${esc(m.last_vl||'not done')}</span>
     <span class="pill">${(infants||[]).length} exposed infant(s)</span>
     ${m.tb_screening?`<span class="pill ${m.tb_screening==='P'?'red':''}">TB screen: ${esc(m.tb_screening)}</span>`:''}
   </div>
   <a class="nav" href="#pmtct">&lsaquo; Back to PMTCT</a></div>

   ${alerts.length?`<div class="card"><h3>What needs to happen next</h3>
     ${alerts.map(a=>alertBox(a[0],a[1],a[2])).join('')}</div>`:
     `<div class="card"><h3>What needs to happen next</h3>
       <div style="background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:9px 12px;font-size:13px">Nothing outstanding. She is on ART, her viral load is recorded, and every enrolled infant has been tested.</div></div>`}

   <div class="card"><h3>HIV care</h3>
    <p class="muted">Everything here can change after enrolment &mdash; she starts ART, she switches feeding option, her TB treatment begins. Record it as it happens.</p>
    <div class="grid">
     ${ecPicker('cart','Date ART initiated',false,m.art_start_date)}
     <label>ART regimen<input id="creg" value="${esc(m.art_regimen||'')}" placeholder="e.g. TDF/3TC/DTG"></label>
     <label>Infant feeding option<select id="cfeed">${selOpts(PM_FEED,m.feeding_option)}</select></label>
     <label>Cotrimoxazole (CPT) started<select id="ccpt">${selOpts([['Y','Yes'],['N','No']],m.cpt_started)}</select></label>
     <label>Initial CD4 count<input id="ccd4" value="${esc(m.cd4_count||'')}" placeholder="value, or ND"></label>
     <label>WHO clinical stage<select id="cwho">${selOpts([[1,'Stage 1'],[2,'Stage 2'],[3,'Stage 3'],[4,'Stage 4']],m.who_stage)}</select></label>
     <label>TB symptom screening<select id="ctb">${selOpts(PM_PN,m.tb_screening)}</select></label>
     ${ecPicker('cinh','Date INH prophylaxis started',false,m.inh_start_date)}
     ${ecPicker('ctbrx','Date TB treatment started',false,m.tb_rx_date)}
     <label>Unit TB number<input id="ctbn" value="${esc(m.tb_unit_number||'')}"></label>
    </div>
    <div id="cfeedwarn"></div>
    <button class="act" id="csave" style="margin-top:10px">Save HIV care</button> <span class="muted" id="cm"></span>
   </div>

   <div class="card"><h3>Delivery &amp; postpartum</h3>
    <div class="grid">
     ${ecPicker('pdd','Date of delivery',false,m.delivery_date)}
     <label>Sex of infant<select id="psx">${selOpts([['M','Male'],['F','Female']],m.infant_sex)}</select></label>
     <label>Place of delivery<select id="ppl">${selOpts(PM_PLACE,m.place_of_delivery)}</select></label>
     <label>Delivery outcome<select id="pout">${selOpts([['LB','Live birth'],['SB','Stillbirth']],m.delivery_outcome)}</select></label>
     <label>ART taken during labour<select id="pal">${selOpts([['Y','Yes'],['N','No']],m.art_during_labour)}</select></label>
     <label>Infant received ARV prophylaxis<select id="pip">${selOpts([['Y','Yes'],['N','No']],m.infant_arv_prophylaxis)}</select></label>
    </div>
    <p class="muted" style="font-size:12px;margin:2px 0 8px">Infant prophylaxis is AZT + NVP for the first 6 weeks, then NVP alone for the next 6 weeks &mdash; 12 weeks in total.</p>
    <h4 style="margin:10px 0 4px">Family planning</h4>
    <div class="grid">
     <label>FP counselled<select id="pfc">${selOpts([['Y','Yes'],['N','No']],m.fp_counselled)}</select></label>
     <label>Acceptor<select id="pfa">${selOpts(ACCEPTOR,m.fp_acceptor)}</select></label>
     <label>Contraceptive provided<select id="pfm">${selOpts(FP_METHODS,m.fp_method)}</select></label>
    </div>
    <button class="act" id="pdsave" style="margin-top:10px">Save</button> <span class="muted" id="pdm"></span>
   </div>

   ${unlinked.length?`<div class="card"><h3>Newborns from her delivery record</h3>
    <p class="muted">These babies were recorded in the delivery room. Every one of them is HIV-exposed and belongs in the HEI cohort &mdash; enrol them here rather than typing them in again.</p>
    <table><tr><th>Baby MRN</th><th>Sex</th><th>Weight</th><th>Born</th><th>Already recorded in delivery</th><th></th></tr>
     ${unlinked.map(b=>`<tr><td>${esc(b.mrn||'—')}</td><td>${esc(b.sex||'')}</td><td>${esc(b.weight_g?b.weight_g+' g':'')}</td>
       <td>${esc((b.recorded_at||'').slice(0,10))}</td>
       <td class="muted" style="font-size:12px">${[b.arv_prophylaxis?'ARV: '+esc(b.arv_prophylaxis):'',b.dbs_sample?'DBS: '+esc(b.dbs_sample):''].filter(Boolean).join(' · ')||'—'}</td>
       <td><button class="sec" data-enrol="${b.id}">Enrol in HEI cohort</button></td></tr>`).join('')}
    </table></div>`:''}

   <div class="card"><h3>HIV-exposed infants</h3>
    <p class="muted">Each exposed infant is followed until her HIV status is finally known. The DNA/PCR is due at about 6 weeks of age; the antibody test confirms at 18 months.</p>
    <table><tr><th>Infant MRN</th><th>Enrolled</th><th>ARV started</th><th>Feeding</th><th>CPT (wks)</th><th>DNA/PCR (wks)</th><th>PCR</th><th>Antibody</th><th>Outcome</th></tr>
     ${(infants||[]).map(i=>`<tr>
       <td>${esc(i.mrn||'')}</td><td>${esc(i.hei_enrol_date||'')}</td><td>${esc(i.arv_start_date||'')}</td>
       <td>${esc(i.feeding_6m||'')}</td><td>${esc(i.cpt_age_weeks??'')}</td>
       <td>${esc(i.pcr_age_weeks??'')}${(i.pcr_age_weeks>8)?' <span class="pill amber">late</span>':''}</td>
       <td>${i.pcr_result==='P'?'<span class="pill red">Positive</span>':(i.pcr_result==='N'?'<span class="pill green">Negative</span>':'<span class="muted">—</span>')}</td>
       <td>${i.rapid_ab_result==='P'?'<span class="pill red">Positive</span>':(i.rapid_ab_result==='N'?'<span class="pill green">Negative</span>':'<span class="muted">—</span>')}</td>
       <td>${esc((PM_IOUT.find(x=>x[0]===i.outcome)||[,''])[1])}</td></tr>`).join('')
       ||'<tr><td colspan=9 class=muted>No exposed infant enrolled yet.</td></tr>'}
    </table>
    <button class="sec" id="pinew" style="margin-top:10px">Add / update an infant</button>
    <div id="piform"></div>
   </div>

   <div class="card"><h3>Cohort follow-up</h3>
    <p class="muted">Month 0 is the month she was enrolled &mdash; the shared event for both the maternal and the infant cohort. Viral load is due 3 months after ART starts, then every 6 months. Below 1,000 copies/ml is undetectable.</p>
    <nav class="navbar" style="margin:0 0 10px">
      <a class="nav${fuSub==='mother'?' on':''}" href="#pmtctclient/${id}" data-fusub="mother">Mother</a>
      <a class="nav${fuSub==='infant'?' on':''}" href="#pmtctclient/${id}" data-fusub="infant">Infant</a>
    </nav>

    ${fuSub==='mother'?`
    <table><tr><th>Month</th><th>Date seen</th><th>Status</th><th>Viral load</th><th>Copies/ml</th><th>Note</th></tr>
     ${mfu.map(f=>`<tr><td><b>${esc(f.month_no)}</b></td><td>${esc(f.visit_date||'')}</td>
       <td>${esc((PM_MSTATUS.find(x=>x[0]===f.status)||[,f.status||''])[1])}</td>
       <td>${f.viral_load==='undetectable'?'<span class="pill green">Undetectable</span>':(f.viral_load==='detectable'?'<span class="pill red">Detectable</span>':'')}</td>
       <td>${esc(f.vl_value??'')}</td><td>${esc(f.note||'')}</td></tr>`).join('')
       ||'<tr><td colspan=6 class=muted>No follow-up recorded yet.</td></tr>'}
    </table>
    <div class="grid" style="margin-top:12px">
     <label>Month<input id="fmn" type="number" min="0" max="60" value="${nextMonth}"></label>
     ${ecPicker('fdt','Date seen',true)}
     <label>Status this month<select id="fst">${selOpts(PM_MSTATUS)}</select></label>
     <label>Viral load<select id="fvl">${selOpts([['undetectable','Undetectable (&lt;1,000)'],['detectable','Detectable (&gt;1,000)']])}</select></label>
     <label>Copies/ml (if known)<input id="fvv" type="number" min="0"></label>
    </div>
    <label>Note<input id="fnt"></label>
    <div id="fedit" class="muted" style="font-size:12px"></div>
    <div id="fvlwarn"></div>
    <button class="act" id="fsav" style="margin-top:10px">Save this month</button> <span class="muted" id="fm2"></span>`
    :`
    ${(infants||[]).length?`
    <label>Which infant<select id="ifsel">${(infants||[]).map((i,n)=>`<option value="${i.id}">${esc(infName(i,n))}</option>`).join('')}</select></label>
    <table style="margin-top:10px"><tr><th>Month</th><th>Date seen</th><th>Status</th><th>Note</th></tr>
     <tbody id="ifrows"></tbody>
    </table>
    <div class="grid" style="margin-top:12px">
     <label>Month<input id="ifmn" type="number" min="0" max="60" value="0"></label>
     ${ecPicker('ifdt','Date seen',true)}
     <label>Status this month<select id="ifst">${selOpts(PM_ISTATUS)}</select></label>
    </div>
    <label>Note<input id="ifnt"></label>
    <div id="ifedit" class="muted" style="font-size:12px"></div>
    <button class="act" id="ifsav" style="margin-top:10px">Save this month</button> <span class="muted" id="ifm"></span>`
    :`<p class="muted">No exposed infant is enrolled yet, so there is nothing to follow up. Enrol her above first.</p>`}`}
   </div>`;

  // A save that succeeded must NOT re-enable its button — the screen is about to re-render, and
  // re-enabling leaves a live button on a stale form, which is how double-click duplicates happen.
  const guard=(sel,fn)=>{ const b=$(sel); if(!b) return; b.onclick=async()=>{ if(b.disabled) return; b.disabled=true;
    try{ const ok=await fn(); if(!ok) b.disabled=false; }catch(e){ b.disabled=false; toast(e.message||'error'); } }; };

  // ---- HIV care ----
  const cfeedChk=()=>{ $('#cfeedwarn').innerHTML=($('#cfeed').value==='MF')
    ? alertBox('red','Mixed feeding carries the highest transmission risk','Of the three options this is the most dangerous for the infant. Counsel her towards exclusive breastfeeding or exclusive replacement feeding.') : ''; };
  $('#cfeed').addEventListener('change',cfeedChk);
  guard('#csave',async()=>{
    const r=await api('PATCH','pmtct/'+id,{art_start_date:ecGet('cart'),art_regimen:(creg.value||null),
      feeding_option:(cfeed.value||null),cpt_started:(ccpt.value||null),cd4_count:(ccd4.value||null),
      who_stage:(+cwho.value||null),tb_screening:(ctb.value||null),inh_start_date:ecGet('cinh'),
      tb_rx_date:ecGet('ctbrx'),tb_unit_number:(ctbn.value||null)});
    if(r&&(r.ok||r.queued)){ toast('Saved','ok'); setTimeout(()=>pmtctClient(id),500); return true; }
    $('#cm').textContent=' '+((r&&r.error)||'error'); return false; });

  // ---- delivery / FP ----
  guard('#pdsave',async()=>{
    const r=await api('PATCH','pmtct/'+id,{delivery_date:ecGet('pdd'),infant_sex:(psx.value||null),
      place_of_delivery:(+ppl.value||null),delivery_outcome:(pout.value||null),art_during_labour:(pal.value||null),
      infant_arv_prophylaxis:(pip.value||null),fp_counselled:(pfc.value||null),fp_acceptor:(pfa.value||null),fp_method:(pfm.value||null)});
    if(r&&(r.ok||r.queued)){ toast('Saved','ok'); setTimeout(()=>pmtctClient(id),500); return true; }
    $('#pdm').textContent=' '+((r&&r.error)||'error'); return false; });

  $('#pinew').onclick=()=>pmtctInfantForm(id,infants,m);
  document.querySelectorAll('[data-fusub]').forEach(a=>a.onclick=(e)=>{ e.preventDefault(); window._pmFuSub=a.dataset.fusub; pmtctClient(id); });

  // Carry the delivery-room newborn straight into the HEI cohort, bringing what is already
  // known with her: her MRN, her date of birth, and the date her ARV prophylaxis was started.
  document.querySelectorAll('[data-enrol]').forEach(btn=>btn.onclick=async()=>{
    if(btn.disabled) return; btn.disabled=true;
    const b=borne.find(x=>x.id==btn.dataset.enrol)||{};
    const dob=m.delivery_date||(b.recorded_at||'').slice(0,10)||null;
    try{
      const r=await api('POST','pmtct_infants',{mother_id:+id,baby_id:+b.id,mrn:(b.mrn||null),
        infant_dob:dob, hei_enrol_date:localDate(),
        arv_start_date:((b.arv_prophylaxis&&b.arv_prophylaxis!=='not_given')?dob:null)});
      if(r&&(r.id||r.queued)){ toast('Infant enrolled in the HEI cohort','ok'); setTimeout(()=>pmtctClient(id),500); }
      else { btn.disabled=false; toast((r&&r.error)||'error'); }
    }catch(e){ btn.disabled=false; toast(e.message||'error'); }
  });

  // ---- cohort follow-up: MOTHER ----
  if(fuSub==='mother' && $('#fsav')){
    // NB declare vlChk BEFORE loadMonth, which calls it. Declaring it after would work only by
    // luck of invocation order — and a `const` referenced before initialisation is precisely the
    // temporal-dead-zone trap that once silently killed every safety dialog in this app.
    // the number and the band must agree — a typed 45,000 marked "undetectable" is a lie
    const vlChk=()=>{ const v=+fvv.value, band=fvl.value; let w='';
      if(fvv.value!==''){
        if(v>=1000 && band==='undetectable') w=alertBox('red','These disagree',v.toLocaleString()+' copies/ml is <b>detectable</b> — 1,000 or more. Change the band, or correct the number.');
        if(v<1000 && band==='detectable')   w=alertBox('red','These disagree',v.toLocaleString()+' copies/ml is <b>undetectable</b> — below 1,000. Change the band, or correct the number.');
      }
      $('#fvlwarn').innerHTML=w; };

    // Typing a month that already exists must LOAD it. The server replaces the row on save, so
    // without this a provider adding a note to month 3 would silently wipe the detectable viral
    // load recorded there — the single most safety-critical field in the module.
    const loadMonth=()=>{ const f=mfu.find(x=>+x.month_no===+fmn.value);
      if(f){ fst.value=f.status||''; fvl.value=f.viral_load||''; fvv.value=(f.vl_value??''); fnt.value=f.note||'';
             ecSet('fdt',f.visit_date);
             $('#fedit').innerHTML='Editing month '+f.month_no+' &mdash; the values already recorded are shown. Saving replaces them.'; }
      else { fst.value=''; fvl.value=''; fvv.value=''; fnt.value=''; $('#fedit').textContent=''; }
      vlChk(); };

    fvv.addEventListener('input',vlChk); fvl.addEventListener('change',vlChk);
    fmn.addEventListener('change',loadMonth); fmn.addEventListener('input',loadMonth); loadMonth();

    guard('#fsav',async()=>{
      const v=fvv.value===''?null:+fvv.value;
      // A number with no band selected used to be stored as "not done" — so a frankly
      // detectable 45,000 raised nothing at all. Derive the band from the number.
      const band=fvl.value || (v==null ? null : (v>=1000 ? 'detectable' : 'undetectable'));
      if(v!=null && fvl.value && ((v>=1000&&fvl.value==='undetectable')||(v<1000&&fvl.value==='detectable'))){
        modal('Viral load disagrees with itself','You have entered <b>'+v.toLocaleString()+' copies/ml</b> but marked it <b>'+fvl.value+'</b>. Below 1,000 is undetectable; 1,000 or more is detectable. Correct one of them.'); return false; }
      if(!fst.value){ modal('Status required','Record how she is this month — alive and on ART, lost to follow-up, transferred, or died. Leaving it blank would silently overwrite whatever was recorded before.'); return false; }
      const r=await api('POST','pmtct_fu',{mother_id:+id,subject:'mother',month_no:(+fmn.value||0),visit_date:ecGet('fdt'),
        status:fst.value,viral_load:band,vl_value:v,note:(fnt.value||null)});
      if(r&&(r.id||r.queued)){ toast('Month recorded','ok'); setTimeout(()=>pmtctClient(id),500); return true; }
      $('#fm2').textContent=' '+((r&&r.error)||'error'); return false; });
  }

  // ---- cohort follow-up: INFANT ----
  // The infant half of the grid answers the question the whole module exists for: did she
  // end up negative? It was defined in the schema but had no way in.
  if(fuSub==='infant' && $('#ifsav')){
    const rowsFor=(iid)=>(fu||[]).filter(f=>f.subject==='infant' && +f.infant_id===+iid).sort((a,b)=>a.month_no-b.month_no);
    const paint=()=>{ const rs=rowsFor(ifsel.value);
      $('#ifrows').innerHTML = rs.map(f=>`<tr><td><b>${esc(f.month_no)}</b></td><td>${esc(f.visit_date||'')}</td>
        <td>${esc((PM_ISTATUS.find(x=>x[0]===f.status)||[,f.status||''])[1])}</td><td>${esc(f.note||'')}</td></tr>`).join('')
        || '<tr><td colspan=4 class=muted>No follow-up recorded for this infant yet.</td></tr>';
      ifmn.value = rs.length ? (Math.max(...rs.map(f=>+f.month_no))+1) : 0;
      loadIMonth(); };
    const loadIMonth=()=>{ const f=rowsFor(ifsel.value).find(x=>+x.month_no===+ifmn.value);
      if(f){ ifst.value=f.status||''; ifnt.value=f.note||''; ecSet('ifdt',f.visit_date);
             $('#ifedit').innerHTML='Editing month '+f.month_no+' &mdash; saving replaces what is recorded there.'; }
      else { ifst.value=''; ifnt.value=''; $('#ifedit').textContent=''; } };
    ifsel.addEventListener('change',paint);
    ifmn.addEventListener('change',loadIMonth);
    paint();

    guard('#ifsav',async()=>{
      if(!ifst.value){ modal('Status required','Record how the infant is this month — still exposed and breastfeeding, discharged negative, HIV positive, lost, transferred, or died.'); return false; }
      const r=await api('POST','pmtct_fu',{mother_id:+id,subject:'infant',infant_id:+ifsel.value,
        month_no:(+ifmn.value||0),visit_date:ecGet('ifdt'),status:ifst.value,note:(ifnt.value||null)});
      if(r&&(r.id||r.queued)){ toast('Month recorded','ok'); setTimeout(()=>pmtctClient(id),500); return true; }
      $('#ifm').textContent=' '+((r&&r.error)||'error'); return false; });
  }
}

function pmtctInfantForm(mid,infants,m){
  const opts=[['','— new infant —']].concat((infants||[]).map((i,n)=>[i.id,'Infant '+(n+1)+(i.mrn?' ('+i.mrn+')':'')]));
  $('#piform').innerHTML=`<div style="margin-top:12px;border-top:1px solid #e6eae8;padding-top:12px">
   <div class="grid">
    <label>Record<select id="pisel">${opts.map(o=>`<option value="${o[0]}">${esc(o[1])}</option>`).join('')}</select></label>
    <label>Infant MRN<input id="pimrn"></label>
    ${ecPicker('pidob','Infant date of birth')}
    ${ecPicker('piehd','Date of HEI enrolment',true)}
    ${ecPicker('piarv','Date infant started ARV prophylaxis')}
    <label>Feeding practice (first 6 months)<select id="pifd">${selOpts(PM_FEED)}</select></label>
    <label>Age in weeks CPT started<input id="picpt" type="number" min="0" max="120"></label>
    <label>Age in weeks DNA/PCR done<input id="pipw" type="number" min="0" max="120"></label>
    <label>DNA/PCR result<select id="pipr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
    <label>Rapid HIV antibody result (18 months)<select id="piab">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
    <label>Final outcome<select id="pio">${selOpts(PM_IOUT)}</select></label>
   </div>
   <div id="piwarn"></div>
   <button class="act" id="pisave" style="margin-top:10px">Save infant</button> <span class="muted" id="pim"></span></div>`;

  // Editing an existing infant must LOAD her values first — otherwise saving would blank
  // every field the provider did not retype, including the dates.
  const fill=()=>{ const i=(infants||[]).find(x=>x.id==pisel.value);
    pimrn.value=i?(i.mrn||''):''; picpt.value=i?(i.cpt_age_weeks??''):''; pipw.value=i?(i.pcr_age_weeks??''):'';
    pipr.value=i?(i.pcr_result||''):''; piab.value=i?(i.rapid_ab_result||''):''; pio.value=i?(i.outcome||''):'';
    pifd.value=i?(i.feeding_6m||''):'';
    ecSet('pidob', i?i.infant_dob:null); ecSet('piehd', i?i.hei_enrol_date:null); ecSet('piarv', i?i.arv_start_date:null);
    chk(); };
  const chk=()=>{ let w='';
    if(pipr.value==='P') w+=alertBox('red','DNA/PCR positive','The infant is HIV infected. Link to the ART clinic <b>today</b> and start treatment. Set the outcome to &ldquo;HIV positive — on ART&rdquo; once she is linked.');
    if(pipw.value!=='' && +pipw.value>8) w+=alertBox('amber','Test done late','The DNA/PCR is due at about 6 weeks of age. This one was at '+pipw.value+' weeks. Every week of delay is a week an infected infant spends untreated.');
    if(pipr.value==='N' && pio.value==='discharged_negative' && piab.value!=='N')
      w+=alertBox('amber','Discharge needs the antibody test','A negative DNA/PCR is not the final answer while she is still breastfeeding. The infant is discharged HIV-negative only after the rapid antibody test at 18 months, at least 6 weeks after breastfeeding stopped.');
    $('#piwarn').innerHTML=w; };
  pisel.addEventListener('change',fill);
  [pipr,pipw,piab,pio].forEach(el=>el.addEventListener('change',chk));
  pipw.addEventListener('input',chk);

  // Do NOT re-enable the button after a successful save — the screen is about to re-render, and
  // a live button on a stale form is how you get two infants where there is one.
  $('#pisave').onclick=async()=>{ const b=$('#pisave'); if(b.disabled) return; b.disabled=true;
    try{
      const payload={mrn:(pimrn.value||null),infant_dob:ecGet('pidob'),hei_enrol_date:ecGet('piehd'),arv_start_date:ecGet('piarv'),
        feeding_6m:(pifd.value||null),cpt_age_weeks:(picpt.value===''?null:+picpt.value),
        pcr_age_weeks:(pipw.value===''?null:+pipw.value),pcr_result:(pipr.value||null),
        rapid_ab_result:(piab.value||null),outcome:(pio.value||null)};
      const r = pisel.value
        ? await api('PATCH','pmtct_infants/'+pisel.value,payload)
        : await api('POST','pmtct_infants',Object.assign({mother_id:+mid},payload));
      if(r&&(r.id||r.ok||r.queued)){ toast('Infant saved','ok'); setTimeout(()=>pmtctClient(mid),500); }
      else { $('#pim').textContent=' '+((r&&r.error)||'error'); b.disabled=false; }
    }catch(e){ b.disabled=false; toast(e.message||'error'); } };
}

// ---- Pregnancy test (OPD) -> ANC room --------------------------------------
// "If a mother's pregnancy test became positive from OPD, how can we link her to the
//  ANC room?" — a positive test opens her ANC episode here, so the handoff is recorded
//  instead of depending on her finding the ANC room herself.
async function pregTest(){
  const past=await api('GET','pregnancy_tests').catch(()=>[]);
  const pending=(past||[]).filter(p=>p.result==='pending');
  app().innerHTML=nav()+`
   ${pending.length?`<div class="card"><h3>Awaiting a result <span class="pill amber">${pending.length}</span></h3>
    <p class="muted">These women were registered for a pregnancy test and the result has not come back. Record it here and she is routed straight away &mdash; positive opens her ANC episode, negative opens her family-planning record.</p>
    <table><tr><th>Registered</th><th>MRN</th><th>Name</th><th>Result</th><th></th></tr>
    ${pending.map(p=>`<tr>
      <td>${esc(p.test_date||'')}</td><td>${esc(p.mrn||'')}</td>
      <td>${esc(((p.first_name||'')+' '+(p.father_name||'')).trim())}</td>
      <td><select data-res="${p.id}" style="min-width:130px"><option value="">— select —</option><option value="negative">Negative</option><option value="positive">Positive</option></select></td>
      <td><button class="sec" data-save="${p.id}">Record</button></td></tr>`).join('')}
    </table>
    <div class="ticks" style="margin-top:8px">${tick('ptfpall','If negative, open her family-planning record')}</div>
    <p class="muted" style="font-size:12px">A negative test is the highest-yield moment there is to offer contraception &mdash; she is in the building, thinking about her fertility, with a provider in front of her.</p>
    </div>`:''}

   <div class="card"><h3>Pregnancy test <span class="muted" style="font-size:13px;font-weight:400">— for a woman already registered</span></h3>
   <p class="muted">To register a NEW woman for a test, use <a class="nav" href="#register" style="padding:0">Register</a> and choose &ldquo;Pregnancy test&rdquo;.</p>
   <div class="grid">
    <label>Find the woman (MRN or name)<input id="ptq" placeholder="type to search"></label>
    <label>&nbsp;<select id="ptw"><option value="">— search first —</option></select></label>
    ${ecPicker('ptd','Test date',true)}
    <label>Result<select id="ptr"><option value="pending">Not back yet</option><option value="negative">Negative</option><option value="positive">Positive</option></select></label>
   </div>
   <div id="ptpos" style="display:none;background:#e1f5ee;border:1px solid #5dcaa5;color:#04342c;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
     <div class="ticks">${tick('ptlink','Open her ANC episode now (link to the ANC room)')}</div>
     <div style="margin-top:4px">A positive test means she needs ANC. Ticking this registers her for antenatal care and she will appear on the ANC worklist immediately.</div>
   </div>
   <div id="ptneg" style="display:none;background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px">
     <div class="ticks">${tick('ptfp','Offer family planning now (open her as an FP client)')}</div>
     <div style="margin-top:4px">She is not pregnant &mdash; and she is in the building, thinking about her fertility, with a provider in front of her. This is the highest-yield moment to offer contraception. Ticking this opens her family-planning record so she does not leave with nothing.</div>
   </div>
   <label>Note<input id="ptn" placeholder="optional"></label>
   <button class="act" id="ptsave" style="margin-top:10px">Save test</button> <span class="muted" id="ptm"></span></div>

   <div class="card"><h3>Recent tests</h3><table><tr><th>Date</th><th>MRN</th><th>Name</th><th>Result</th><th>Linked to ANC</th></tr>
    ${(past||[]).map(p=>`<tr><td>${esc(p.test_date||'')}</td><td>${esc(p.mrn||'')}</td><td>${esc((p.first_name||'')+' '+(p.father_name||''))}</td>
      <td>${p.result==='positive'?'<span class="pill amber">Positive</span>':esc(p.result||'')}</td>
      <td>${p.linked_episode_id?('<a class="nav" href="#patient/'+p.linked_episode_id+'">ANC episode '+p.linked_episode_id+'</a>'):(p.result==='positive'?'<span class="muted">not linked</span>':'—')}</td></tr>`).join('')
      ||'<tr><td colspan=5 class=muted>No tests recorded yet.</td></tr>'}
   </table></div>`;

  let found=[];
  ptq.addEventListener('input',async()=>{ const q=ptq.value.trim(); if(q.length<1) return;
    found=await api('GET','women?q='+encodeURIComponent(q)).catch(()=>[]);
    ptw.innerHTML='<option value="">— select the woman —</option>'+(found||[]).map(w=>`<option value="${w.id}">${esc(w.mrn)} — ${esc((w.first_name||'')+' '+(w.father_name||''))} (${esc(w.age||'?')})</option>`).join(''); });
  ptr.addEventListener('change',()=>{
    $('#ptpos').style.display=(ptr.value==='positive')?'':'none';
    $('#ptneg').style.display=(ptr.value==='negative')?'':'none';
  });

  // Record a result that has come back from the lab. THIS is where she gets routed.
  document.querySelectorAll('[data-save]').forEach(btn=>btn.onclick=async()=>{
    if(btn.disabled) return;
    const pid=btn.dataset.save;
    const sel=document.querySelector('[data-res="'+pid+'"]');
    if(!sel.value){ modal('Select the result','Record whether her test was positive or negative.'); return; }
    btn.disabled=true;
    try{
      const neg=(sel.value==='negative');
      const r=await api('PATCH','pregnancy_tests/'+pid,{result:sel.value,
        link_to_anc:(sel.value==='positive')?1:0,
        link_to_fp:(neg&&tk('ptfpall'))?1:0, fp_offered:(neg&&tk('ptfpall'))?1:0});
      if(r&&r.episode_id){ toast('Positive — ANC episode opened','ok'); location.hash='#patient/'+r.episode_id; return; }
      if(r&&r.fp_client_id){ toast('Negative — family planning record opened','ok'); location.hash='#fpclient/'+r.fp_client_id; return; }
      toast('Result recorded','ok'); setTimeout(pregTest,500);
    }catch(e){ btn.disabled=false; toast(e.message||'error'); }
  });

  $('#ptsave').onclick=async()=>{
    const b=$('#ptsave'); if(b.disabled) return;
    if(!ptw.value){ modal('Select the woman','Search for her by MRN or name and select her from the list. If she is not registered yet, register her first.'); return; }
    b.disabled=true;
    try{
      const r=await api('POST','pregnancy_tests',{woman_id:+ptw.value,test_date:ecGet('ptd'),result:ptr.value,
        note:(ptn.value||null),
        link_to_anc:(ptr.value==='positive'&&tk('ptlink'))?1:0,
        link_to_fp:(ptr.value==='negative'&&tk('ptfp'))?1:0,
        fp_offered:(ptr.value==='negative'&&tk('ptfp'))?1:0});
      if(r&&r.episode_id){ toast('Positive — ANC episode opened','ok'); setTimeout(()=>location.hash='#patient/'+r.episode_id,700); }
      else if(r&&r.fp_client_id){ toast('Negative — family planning record opened','ok'); setTimeout(()=>location.hash='#fpclient/'+r.fp_client_id,700); }
      else if(r&&(r.id||r.queued)){ $('#ptm').textContent=' saved'; setTimeout(()=>pregTest(),600); }
      else $('#ptm').textContent=' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; }
  };
}

// =================================================================================================
// THE CARE RECORD — showing back what was written down.
//
// Everything below exists because of one finding: the tool captured 54 fields at an ANC contact and
// showed 12 of them back. The rest — a reactive syphilis result, the anti-D for a Rh-negative woman,
// the IPV disclosure, the unsuppressed viral load, the serial fundal heights, the danger note one
// provider wrote for the next — went into the database and were never seen by a human being again.
// A record that cannot be read is not a record.
//
// LABELS AND CODES. The MoH forms store codes (maternal condition 1-4, newborn problem 1-11). The
// code is meaningless on a screen, so every code is rendered as the words the provider ticked.
// =================================================================================================
const YN = v => (v==1||v==='1') ? 'Yes' : ((v==0||v==='0') ? 'No' : null);
const CODES = {
  maternal_condition:{1:'Normal',2:'Complicated — managed',3:'Complicated — referred',4:'Died'},
  nb_treatment_outcome:{1:'Improved',2:'No change',3:'Died',4:'Referred',5:'Unknown',6:'Resuscitated and survived'},
  nb_death_cause:{1:'Prematurity',2:'Infection',3:'Asphyxia',4:'Other'},
  place_of_delivery:{1:'This facility',2:'Other facility',3:'Home'},
  hiv_test_result:{P:'POSITIVE',N:'Negative'},
  // The forms store the MoH CODES — R / NR / ND, Y / N. Rendering "R" back at a clinician is no
  // better than not showing it: this is the whole point of the feature. Say the word.
  syphilis_result:{R:'REACTIVE',NR:'Non-reactive',ND:'Not done'},
  hepb_result:{R:'REACTIVE',NR:'Non-reactive',ND:'Not done'},
  ultrasound_lt24w:{Y:'Yes',N:'No'},
  partograph_used:{Y:'Yes',N:'No'},
  maternal_death_cause:{1:'Haemorrhage',2:'Hypertensive disorder',3:'Sepsis',4:'Obstructed labour',5:'Abortion complication',6:'Other'},
};
const CSV_CODES = {
  nb_problems:{1:'Normal',2:'Prematurity',3:'Sepsis / VSD',4:'Respiratory distress',5:'Perinatal asphyxia',6:'Low birth weight',
               7:'Congenital malformation',8:'Absence of reflex',9:'Jaundice',10:'Head circumference <33cm',11:'Other'},
  nb_treatment:{1:'Oxygen resuscitation',2:'KMC',3:'Antibiotic',4:'Chlorhexidine',5:'Blood transfusion',6:'Other'},
  substance_use:{none:'None',alcohol:'Alcohol',tobacco:'Tobacco',khat:'Khat',caffeine:'Heavy caffeine',other:'Other'},
};
// How each column reads on the record. [label, kind]. kind: t=text/number, y=yes/no tick, c=coded, v=CSV coded.
// `!` marks a value that must CATCH THE EYE when it is abnormal — it is rendered as a red pill.
const F = {
  // ANC contact
  visit_date:['Date','t'], contact_no:['Contact','t'], ga_weeks:['Gestational age (weeks)','t'],
  weight_kg:['Weight (kg)','t'], bmi:['BMI','t'], height_cm:['Height (cm)','t'],
  bp_systolic:['BP systolic','t'], bp_diastolic:['BP diastolic','t'],
  fundal_height_cm:['Fundal height (cm)','t'], fetal_heart_rate:['Fetal heart rate','t'],
  presentation:['Presentation','t'], fetal_movement:['Fetal movement','t'],
  urine_protein:['Urine protein','t!'], hgb:['Haemoglobin','t'], anaemia_grade:['Anaemia','t!'],
  muac:['MUAC (cm)','t'], muac_flag:['MUAC below 23 cm','y!'], pallor:['Pallor','t!'],
  urine_gramstain:['Urine gram stain','t!'], ogtt_result:['OGTT (diabetes)','t!'],
  malaria_assessed:['Malaria assessed','t'],
  syphilis_result:['Syphilis','c!'], syphilis_treated:['Syphilis treated','y'],
  hepb_result:['Hepatitis B','c!'], hepb_treated:['Hepatitis B treated','y'], hepb_prophylaxis:['HepB prophylaxis','y'],
  hiv_test_accepted:['HIV test accepted','y'], hiv_test_result:['HIV result','c!'], hiv_posttest_counselled:['Post-test counselled','y'],
  art_continued:['ART continued','y'], viral_load:['Viral load','t!'], viral_load_date:['Viral load date','t'],
  art_clinic_linked:['Linked back to ART clinic','y'],
  td_dose_no:['Td dose given','t'], ifa_tabs:['Iron-folic acid given (tablets)','t'], ifa_tabs_consumed:['IFA tablets taken','t'],
  calcium_given:['Calcium given','y'], deworming:['Deworming given','y'], anti_d_given:['Anti-D given','y'],
  ultrasound_lt24w:['Ultrasound before 24 weeks','c'],
  mental_health:['Mental health','t!'], ipv_screen:['Intimate partner violence','t!'], substance_use:['Substance use','v'],
  cnsl_danger_signs:['Counselled: danger signs','y'], cnsl_nutrition:['Counselled: nutrition','y'], cnsl_ecd:['Counselled: early child development','y'],
  cnsl_infant_feeding:['Counselled: infant feeding','y'], cnsl_family_planning:['Counselled: family planning','y'],
  cnsl_lifestyle:['Counselled: lifestyle','y'], cnsl_bpcr:['Counselled: birth preparedness','y'],
  danger_note:['Danger signs noted','t!'], remark:['Remark','t'], next_appointment:['Next appointment','t'],
  // PNC visit
  visit_period:['Period','t'], maternal_condition:['Mother','c!'], other_obs_complication:['Other complication','t!'],
  m_temp:['Temperature','t!'], m_bp_systolic:['BP systolic','t'], m_bp_diastolic:['BP diastolic','t'], m_pulse:['Pulse','t'],
  bleeding:['Lochia','t!'], uterine_tone:['Uterine tone','t!'], perineum:['Perineum / wound','t!'], breast:['Breasts','t'],
  mood:['Mood','t!'], mother_breastfeeding:['Breastfeeding','t'], pp_fp:['Postpartum family planning','t'], ifa_continued:['IFA continued','t'],
  pph:['Postpartum haemorrhage','y!'],
  nb_temp:['Newborn temperature','t!'], nb_feeding:['Newborn feeding','t!'], cord:['Cord','t!'],
  nb_convulsions:['Convulsions','t!'], nb_fast_breathing:['Fast breathing','t!'], nb_chest_indrawing:['Chest indrawing','t!'],
  nb_lethargy:['Lethargy','t!'], nb_jaundice:['Jaundice','t!'], nb_kmc:['KMC','t'], nb_immunization:['Immunisation','t'],
  nb_eid:['Early infant diagnosis (HIV)','t!'], nb_weight_g:['Newborn weight (g)','t'],
  nb_problems:['Newborn problems','v!'], nb_problem_other:['Other problem','t'], nb_treatment:['Treatment given','v'],
  nb_treatment_outcome:['Treatment outcome','c!'], nb_death_age_days:['Age at death (days)','t!'], nb_death_cause:['Cause of death','c!'],
  cnsl_breastfeeding:['Counselled: breastfeeding','y'], cnsl_newborn_care:['Counselled: newborn care','y'], cnsl_epi:['Counselled: immunisation','y'],
  ippfp_acceptor:['Postpartum FP acceptor','t'], ippfp_method:['Postpartum FP method','t'], ippfp_timing:['FP method timing','t'],
  // delivery
  delivery_datetime:['Date and time of birth','t'], mode:['Mode of birth','t'], mode_other_text:['Mode (other)','t'],
  maternal_status:['Mother at discharge','t!'], maternal_outcome:['Maternal outcome','t!'], maternal_death_cause:['Cause of maternal death','c!'],
  blood_loss_ml:['Blood loss (ml)','t!'], episiotomy:['Episiotomy','y'], partograph_used:['Partograph used','t'],
  amtsl_uterotonic:['AMTSL: uterotonic','t'], amtsl_uterotonic_type:['AMTSL: uterotonic type','t'], amtsl_cct:['AMTSL: cord traction','t'],
  amtsl_uterine_tone:['AMTSL: uterine tone','t!'], amtsl_massage:['AMTSL: uterine massage','t'], amtsl_placenta:['Placenta','t!'],
  comp_preeclampsia:['Pre-eclampsia','y!'], comp_eclampsia:['Eclampsia','y!'], comp_aph:['Antepartum haemorrhage','y!'],
  comp_pph:['Postpartum haemorrhage','y!'], comp_other:['Other complication','y!'], referred:['Referred','y!'],
  hiv_retest_accepted:['HIV retest accepted','y'], cnsl_feeding_options:['Counselled: feeding options','y'],
  // newborn
  birth_order:['Birth order','t'], sex:['Sex','t'], weight_g:['Birth weight (g)','t!'],
  apgar_1min:['APGAR 1 min','t!'], apgar_5min:['APGAR 5 min','t!'], outcome:['Outcome','t!'], resuscitated:['Resuscitated','t!'],
  breastfeed_initiated:['Breastfeeding initiated within 1 hour','t!'], vitamin_k_time:['Vitamin K','t!'],
  enc_dried:['Dried and warmed','y'], enc_breathing:['Breathing checked','y'], enc_eye_ointment:['Eye ointment','y'], enc_cord_care:['Chlorhexidine cord care','y'],
  vacc_bcg:['BCG','y'], vacc_opv0:['OPV-0','y'], vacc_hbv:['Hepatitis B birth dose','y'],
  prob_prematurity:['Prematurity','y!'], prob_sepsis_vsd:['Sepsis','y!'], prob_resp_distress:['Respiratory distress','y!'],
  prob_lbw:['Low birth weight','y!'], prob_congenital:['Congenital malformation','y!'], prob_jaundice:['Jaundice','y!'],
  prob_other:['Other problem','y'], prob_other_text:['Other problem (detail)','t'],
  kmc:['Kangaroo mother care','t'], phototherapy:['Phototherapy','t'], antibiotics:['Antibiotics','t'], oxygen:['Oxygen','t'],
  nicu:['NICU','t!'], nicu_facility:['NICU facility','t'],
  hiv_exposed:['HIV exposed','y!'], arv_prophylaxis:['Infant ARV prophylaxis','t!'], dbs_sample:['DBS sample','t!'],
  dbs_result:['DBS result','t!'], art_linked:['Linked to ART clinic','y!'],
  resuscitated_survived:['Resuscitated and survived','y'], death_age_days:['Age at death (days)','t!'],
  death_age_hours:['Age at death (hours)','t!'], death_cause:['Cause of death','t!'], birth_notification:['Birth notified','y'],
  mrn:['Newborn MRN','t'],
};
// A value that a clinician must not scroll past.
function isAlarming(col, v){
  const s=String(v==null?'':v).toLowerCase();
  if(v==null||v==='') return false;
  switch(col){
    case 'hiv_test_result': return s==='p';
    // 'R' = reactive, 'NR' = NON-reactive. A substring test on "react" would flag both, and a test
    // on the letter r would flag "nr" — either way, a woman with a NEGATIVE test would be shown as
    // positive. Match exactly.
    case 'syphilis_result': case 'hepb_result':
      return s==='r' || s==='positive' || s==='p' || s==='reactive';
    case 'urine_protein': return s==='+'||s==='++'||s==='+++';
    case 'anaemia_grade': return s==='moderate'||s==='severe';
    case 'viral_load': return (+v)>=1000;
    case 'ipv_screen': return s==='disclosed'||s==='yes';
    case 'mental_health': return s!=='' && s!=='normal' && s!=='none';
    case 'ogtt_result': return s==='gdm'||s==='abnormal'||s==='high';
    case 'urine_gramstain': case 'pallor': return s!=='' && s!=='normal' && s!=='negative' && s!=='none' && s!=='no';
    case 'blood_loss_ml': return (+v)>=500;
    case 'apgar_1min': case 'apgar_5min': return (+v)<7;
    case 'weight_g': return (+v)<2500;
    case 'nb_temp': case 'm_temp': return (+v)>=38 || (+v)<36;
    case 'maternal_condition': return String(v)!=='1';
    case 'nb_treatment_outcome': return String(v)==='3';
    case 'bleeding': return s==='heavy'||s==='offensive';
    case 'uterine_tone': return s==='atonic';
    case 'perineum': return s==='infected';
    case 'mood': return s==='low'||s==='support';
    case 'cord': return s!=='' && s!=='normal';
    case 'nb_feeding': return s!=='' && s!=='good' && s!=='normal';
    case 'outcome': return s.indexOf('still')>=0 || s.indexOf('death')>=0 || s.indexOf('died')>=0;
    case 'maternal_status': case 'maternal_outcome': return s==='died'||s==='death'||s==='unstable_referred'||s==='near_miss';
    case 'nicu': return s==='admitted'||s==='referred_out';
    case 'dbs_result': return s==='positive'||s==='p';
    case 'resuscitated': return s==='yes'||s==='1';
    case 'breastfeed_initiated': return s==='no'||s==='0';
    case 'vitamin_k_time': return s==='not_given'||s==='none';
    case 'nb_eid': return s==='not_done'||s==='due';
    default:
      // yes/no alarms (comp_*, prob_*, pph, muac_flag, hiv_exposed…)
      return (v==1||v==='1');
  }
}
// One field, rendered — or nothing at all if it was never recorded. ("Not recorded" on 54 lines is
// noise; what was NOT done that SHOULD have been is handled separately, by gapsFor().)
function fld(col, v){
  const def=F[col]; if(!def) return '';
  if(v===null||v===undefined||v==='') return '';
  const [label,kindRaw]=def; const kind=kindRaw.replace('!','');
  let shown;
  if(kind==='y'){ shown=YN(v); if(shown===null) return ''; if(shown==='No' && !isAlarming(col,v)) return ''; }
  else if(kind==='c'){ shown=(CODES[col]||{})[v] || String(v); }
  else if(kind==='v'){
    const map=CSV_CODES[col]||{};
    shown=String(v).split(',').map(s=>s.trim()).filter(Boolean).map(c=>map[c]||c).join(', ');
    if(!shown) return '';
  }
  else shown=String(v);
  const alarm=kindRaw.indexOf('!')>=0 && isAlarming(col,v);
  return `<div class="rec-f"><span class="rec-l">${esc(label)}</span>`+
         `<span class="rec-v${alarm?' rec-alarm':''}">${esc(shown)}</span></div>`;
}
const fields = (row, cols) => cols.map(c=>fld(c,row[c])).join('');
const recBlock = (title, body, note) => body.trim()
  ? `<div class="rec-b"><h5>${title}</h5>${note?`<p class="muted" style="font-size:12px;margin:0 0 6px">${note}</p>`:''}<div class="rec-g">${body}</div></div>` : '';

// WHAT IS MISSING, AND STILL MATTERS. Some omissions are only visible as omissions: a Rh-negative
// woman with no anti-D at 28 weeks, a woman past 24 weeks with no dating scan, a reactive syphilis
// never treated. These are the ones worth putting in front of the provider — not a wall of blanks.
function gapsFor(W, anc, labs){
  const g=[]; const last=(col)=>{ for(let i=anc.length-1;i>=0;i--){ const v=anc[i][col]; if(v!==null&&v!==undefined&&v!=='') return v; } return null; };
  // The mandatory first-contact panel. An outstanding test follows her to every screen until it is
  // done — that is the whole point: at contact 1 it is a prompt, by contact 4 it is a failure.
  if((anc||[]).length && typeof firstLabState==='function'){
    const st=firstLabState(W, anc, labs||[]);
    const notDone=st.filter(s=>s.state!=='done');
    if(notDone.length) g.push([
      'First-contact tests not resulted: '+notDone.map(s=>s.label).join(', '),
      notDone.every(s=>s.state==='sent')
        ? 'The requests are with the laboratory. Record the results here as soon as they come back — until then they cannot change her care.'
        : 'These are required at the first contact. Each one changes what happens next: treatment for syphilis, PMTCT for HIV, anti-D for a Rh-negative woman, iron for anaemia.']);
  }
  const any=(col,val)=>anc.some(v=>String(v[col]||'').toLowerCase()===val);
  const ga=+(last('ga_weeks')||0);
  const rhNeg=String(W.rh_factor||'').toLowerCase()==='neg';
  // R = reactive, NR = non-reactive. Match EXACTLY: a substring test would read "NR" as reactive and
  // put a warning on a woman whose test was negative — and a clinician who is warned about nothing
  // soon stops reading the warnings.
  const reactive=v=>{ const s=String(v||'').toLowerCase(); return s==='r'||s==='reactive'||s==='positive'||s==='p'; };
  const syph=last('syphilis_result');
  const hepb=last('hepb_result');
  if(rhNeg && ga>=28 && !anc.some(v=>v.anti_d_given==1))
    g.push(['Anti-D has not been given','She is Rh negative and past 28 weeks. Without anti-D she can be sensitised, which threatens this baby and every pregnancy after it.']);
  if(reactive(syph) && !anc.some(v=>v.syphilis_treated==1))
    g.push(['Syphilis is reactive and no treatment is recorded','Treat her and her partner. Untreated maternal syphilis causes stillbirth and congenital syphilis, and it is preventable with benzathine penicillin.']);
  if(reactive(hepb) && !anc.some(v=>v.hepb_prophylaxis==1))
    g.push(['Hepatitis B is reactive and no prophylaxis is recorded','Plan the birth dose of HBV vaccine (and immunoglobulin where available) for the newborn.']);
  if(ga>=24 && !anc.some(v=>{const s=String(v.ultrasound_lt24w||'').toLowerCase(); return s==='y'||s==='yes'||v.ultrasound_lt24w==1;}))
    g.push(['No dating ultrasound before 24 weeks','Gestational age can no longer be established reliably by scan. Date her from the last menstrual period and record the uncertainty.']);
  if(ga>=20 && !anc.some(v=>v.calcium_given==1))
    g.push(['Calcium has not been started','From 20 weeks, calcium reduces the risk of pre-eclampsia in this population.']);
  if(anc.length && !anc.some(v=>+v.td_dose_no>0))
    g.push(['No tetanus (Td) dose recorded','Neonatal tetanus is prevented here, at ANC, or not at all.']);
  if(anc.length && !anc.some(v=>+v.ifa_tabs>0))
    g.push(['No iron-folic acid given','Anaemia is the commonest treatable contributor to maternal death in this setting.']);
  if(ga>=13 && !anc.some(v=>v.deworming==1))
    g.push(['No deworming recorded','Indicated once after the first trimester.']);
  if(String(W.hiv_known_positive||'')==='1' || any('hiv_test_result','p')){
    const vl=last('viral_load');
    if(vl===null) g.push(['She is HIV positive and no viral load is recorded','A viral load determines the delivery plan and the infant’s ARV prophylaxis.']);
    else if(+vl>=1000 && !anc.some(v=>v.art_clinic_linked==1))
      g.push(['Viral load is not suppressed and no ART-clinic referral is recorded','An unsuppressed viral load is the strongest predictor of transmission to the baby. Refer her back to the ART clinic.']);
  }
  return g;
}

// THE FULL RECORD. Everything written down about her, in the order it happened, across every episode
// of care — because her syphilis result was found in the antenatal room and matters in the labour
// ward, and her blood loss at birth matters at her postnatal visit on day three.
async function reportScreen(id){
  const C=await api('GET','chart?episode='+id).catch(e=>({error:e.message}));
  if(!C || C.error || !C.woman){
    app().innerHTML=nav()+`<div class="card"><h3>Record could not be loaded</h3>
      <p class="muted">${esc((C&&C.error)||'This episode could not be found.')}</p>
      <a class="nav" href="#patient/${esc(id)}">&lsaquo; Back to patient</a></div>`;
    return;
  }
  const W=C.woman, anc=C.anc_visits||[], pnc=C.pnc_visits||[], bbs=C.babies||[], dels=C.deliveries||[],
        refs=C.referrals||[], dgs=C.danger_signs||[], vits=C.vitals||[], labs=C.labs||[],
        scr=C.anc_screening||[], obs=C.observations||[], eps=C.episodes||[];
  const name=((W.first_name||'')+' '+(W.father_name||'')+' '+(W.grandfather_name||'')).trim();
  const gaps=gapsFor(W,anc,labs);
  const yesScr=scr.filter(s=>s.response==='yes');

  // A single fundal height says nothing. The SERIES is the only growth screen a health centre has
  // without a scan — and it was never once shown to anybody.
  const trendRow=(label,col,fmt)=>{
    if(!anc.some(v=>v[col]!==null&&v[col]!==undefined&&v[col]!=='')) return '';
    return `<tr><th>${esc(label)}</th>${anc.map(v=>{
      const raw=v[col]; const val=(raw===null||raw===undefined||raw==='')?'·':(fmt?fmt(v):raw);
      const al=(raw!==''&&raw!=null&&isAlarming(col,raw));
      return `<td${al?' class="rec-alarm"':''}>${esc(val)}</td>`; }).join('')}</tr>`;
  };
  const trends = anc.length ? `<div class="rec-b"><h5>Across her contacts</h5>
     <div style="overflow-x:auto"><table class="rec-t">
      <tr><th>Contact</th>${anc.map(v=>`<td>${esc(v.contact_no||'·')}</td>`).join('')}</tr>
      <tr><th>Date</th>${anc.map(v=>`<td>${esc(String(v.visit_date||'').slice(5,10))}</td>`).join('')}</tr>
      <tr><th>GA (weeks)</th>${anc.map(v=>`<td>${esc(v.ga_weeks||'·')}</td>`).join('')}</tr>
      ${trendRow('Weight (kg)','weight_kg')}
      ${trendRow('Blood pressure','bp_systolic',v=>(v.bp_systolic||'?')+'/'+(v.bp_diastolic||'?'))}
      ${trendRow('Fundal height (cm)','fundal_height_cm')}
      ${trendRow('Fetal heart rate','fetal_heart_rate')}
      ${trendRow('Urine protein','urine_protein')}
      ${trendRow('Haemoglobin','hgb')}
      ${trendRow('MUAC (cm)','muac')}
      ${trendRow('Iron-folic acid','ifa_tabs')}
     </table></div></div>` : '';

  const ancBlocks = anc.map(v=>`<div class="rec-c">
      <h5>ANC contact ${esc(v.contact_no||'')} <span class="muted">&mdash; ${esc(v.visit_date||'')}${v.ga_weeks?(' &middot; '+esc(v.ga_weeks)+' weeks'):''}</span></h5>
      <div class="rec-g">
        ${fields(v,['weight_kg','bmi','bp_systolic','bp_diastolic','fundal_height_cm','fetal_heart_rate','presentation','fetal_movement','urine_protein','hgb','anaemia_grade','muac','muac_flag','pallor','urine_gramstain','ogtt_result','malaria_assessed'])}
        ${fields(v,['syphilis_result','syphilis_treated','hepb_result','hepb_treated','hepb_prophylaxis','hiv_test_accepted','hiv_test_result','hiv_posttest_counselled','art_continued','viral_load','viral_load_date','art_clinic_linked'])}
        ${fields(v,['td_dose_no','ifa_tabs','ifa_tabs_consumed','calcium_given','deworming','anti_d_given','ultrasound_lt24w'])}
        ${fields(v,['mental_health','ipv_screen','substance_use'])}
        ${fields(v,['cnsl_danger_signs','cnsl_nutrition','cnsl_ecd','cnsl_infant_feeding','cnsl_family_planning','cnsl_lifestyle','cnsl_bpcr'])}
        ${fields(v,['danger_note','remark','next_appointment'])}
      </div></div>`).join('');

  const delBlocks = dels.map(d=>`<div class="rec-c"><h5>Birth <span class="muted">&mdash; ${esc(String(d.delivery_datetime||'').slice(0,16))}</span></h5>
      <div class="rec-g">${fields(d,['mode','mode_other_text','partograph_used','episiotomy','blood_loss_ml','amtsl_uterotonic','amtsl_uterotonic_type','amtsl_cct','amtsl_uterine_tone','amtsl_massage','amtsl_placenta','comp_preeclampsia','comp_eclampsia','comp_aph','comp_pph','comp_other','referred','maternal_status','maternal_outcome','maternal_death_cause','hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_feeding_options','ippfp_acceptor','ippfp_method','ippfp_timing','remark'])}</div></div>`).join('');

  const babyBlocks = bbs.map(b=>`<div class="rec-c"><h5>Newborn ${esc(b.birth_order||'')} <span class="muted">${b.mrn?('&mdash; MRN '+esc(b.mrn)):''}</span></h5>
      <div class="rec-g">${fields(b,['sex','weight_g','apgar_1min','apgar_5min','outcome','resuscitated','resuscitated_survived','breastfeed_initiated','vitamin_k_time','enc_dried','enc_breathing','enc_eye_ointment','enc_cord_care','vacc_bcg','vacc_opv0','vacc_hbv','prob_prematurity','prob_sepsis_vsd','prob_resp_distress','prob_lbw','prob_congenital','prob_jaundice','prob_other','prob_other_text','kmc','phototherapy','antibiotics','oxygen','nicu','nicu_facility','hiv_exposed','arv_prophylaxis','dbs_sample','dbs_result','art_linked','death_age_days','death_age_hours','death_cause','birth_notification'])}</div></div>`).join('');

  const pncBlocks = pnc.map(p=>`<div class="rec-c"><h5>Postnatal visit <span class="muted">&mdash; ${esc(p.visit_date||'')}${p.visit_period?(' &middot; '+esc(p.visit_period)):''}</span></h5>
      <div class="rec-g">
        ${fields(p,['maternal_condition','other_obs_complication','m_temp','m_bp_systolic','m_bp_diastolic','m_pulse','bleeding','uterine_tone','perineum','breast','mood','pph','mother_breastfeeding','pp_fp','ifa_continued'])}
        ${fields(p,['nb_temp','nb_feeding','cord','nb_convulsions','nb_fast_breathing','nb_chest_indrawing','nb_lethargy','nb_jaundice','nb_kmc','nb_immunization','nb_eid','nb_weight_g','nb_problems','nb_problem_other','nb_treatment','nb_treatment_outcome','nb_death_age_days','nb_death_cause'])}
        ${fields(p,['hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_danger_signs','cnsl_breastfeeding','cnsl_newborn_care','cnsl_family_planning','cnsl_epi','cnsl_ecd','ippfp_acceptor','ippfp_method','danger_note','remark'])}
      </div></div>`).join('');

  const HIST={prior_cs:'Previous caesarean',prior_stillbirth:'Previous stillbirth',prior_pph:'Previous PPH',
    prior_preeclampsia:'Previous pre-eclampsia',prior_obstructed:'Previous obstructed labour',
    chronic_htn:'Chronic hypertension',diabetes:'Diabetes',cardiac_renal:'Cardiac / renal disease'};
  const histBody = fields(W,['height_cm']) + Object.keys(HIST).filter(k=>String(W[k]||'').toLowerCase()==='yes')
    .map(k=>`<div class="rec-f"><span class="rec-l">${esc(HIST[k])}</span><span class="rec-v rec-alarm">Yes</span></div>`).join('');

  app().innerHTML=nav()+`<div class="card rec">
   <h3>Care record &mdash; ${esc(name)}</h3>
   <p><b>MRN ${esc(W.mrn||'')}</b>${W.age?(' &middot; '+esc(W.age)+' years'):''} &middot; G${esc(W.gravida||'?')}/P${esc(W.para||'?')}${W.blood_group?(' &middot; blood group '+esc(W.blood_group)+(W.rh_factor?(' '+esc(W.rh_factor)):'')):''}${W.phone?(' &middot; '+esc(W.phone)):''}</p>
   <p class="muted">${eps.length} episode(s) of care here &middot; ${anc.length} ANC contact(s) &middot; ${dels.length} birth(s) &middot; ${bbs.length} newborn(s) &middot; ${pnc.length} postnatal visit(s)</p>

   ${gaps.length?`<div class="rec-b" style="border-left:4px solid #a32d2d">
     <h5 style="color:#a32d2d">Still outstanding</h5>
     ${gaps.map(g=>`<div style="margin-bottom:8px"><b>${esc(g[0])}</b><div class="muted" style="font-size:13px">${esc(g[1])}</div></div>`).join('')}
   </div>`:''}

   ${recBlock('History', histBody, 'What she carries into every episode of care.')}
   ${yesScr.length?`<div class="rec-b"><h5>Risk screening</h5><div class="rec-g">${yesScr.map(s=>`<div class="rec-f"><span class="rec-l">${esc(s.item_code||'')}</span><span class="rec-v rec-alarm">Yes</span></div>`).join('')}</div></div>`:''}
   ${trends}
   ${ancBlocks?`<div class="rec-b"><h5>Antenatal contacts</h5>${ancBlocks}</div>`:''}
   ${labs.length?`<div class="rec-b"><h5>Laboratory</h5><table class="rec-t"><tr><th>Test</th><th>Requested</th><th>Result</th><th>Result date</th><th>Note</th></tr>
      ${labs.map(l=>`<tr><td>${esc(l.test_code||'')}</td><td>${esc(String(l.requested_date||'').slice(0,10))}</td><td>${esc(l.result||'— pending —')}</td><td>${esc(String(l.result_date||'').slice(0,10))}</td><td>${esc(l.note||'')}</td></tr>`).join('')}</table></div>`:''}
   ${obs.length?`<div class="rec-b"><h5>Labour</h5><p class="muted" style="font-size:13px">${obs.length} partograph observation(s). Last: cervix ${esc(obs[obs.length-1].cervix_cm||'—')} cm, fetal heart ${esc(obs[obs.length-1].fetal_heart_rate||'—')}.</p></div>`:''}
   ${delBlocks?`<div class="rec-b"><h5>Birth</h5>${delBlocks}</div>`:''}
   ${babyBlocks?`<div class="rec-b"><h5>Newborn(s)</h5>${babyBlocks}</div>`:''}
   ${pncBlocks?`<div class="rec-b"><h5>Postnatal care</h5>${pncBlocks}</div>`:''}
   ${dgs.length?`<div class="rec-b"><h5>Danger signs recorded</h5><div class="rec-g">${dgs.map(d=>`<div class="rec-f"><span class="rec-l">${esc(String(d.obs_datetime||'').slice(0,16))}</span><span class="rec-v">${esc([d.headache==1?'headache':'',d.blurred_vision==1?'blurred vision':'',d.epigastric_pain==1?'epigastric pain':'',d.vaginal_bleeding==1?'vaginal bleeding':'',d.remark||''].filter(Boolean).join(', ')||'recorded')}</span></div>`).join('')}</div></div>`:''}
   ${refs.length?`<div class="rec-b"><h5>Referrals</h5><div class="rec-g">${refs.map(r=>`<div class="rec-f"><span class="rec-l">${esc(String(r.recorded_at||'').slice(0,10))} &rarr; ${esc(r.referred_to||'')}</span><span class="rec-v${String(r.urgency||'')==='emergency'?' rec-alarm':''}">${esc(r.reason||'')}${r.feedback?(' &middot; feedback: '+esc(r.feedback)):''}</span></div>`).join('')}</div></div>`:''}
   ${vits.length?`<div class="rec-b"><h5>Vital signs</h5><table class="rec-t"><tr><th>When</th><th>BP</th><th>Pulse</th><th>Temp</th><th>Resp</th><th>SpO2</th></tr>
      ${vits.map(v=>`<tr><td>${esc(String(v.obs_datetime||'').slice(0,16))}</td><td>${esc((v.bp_systolic||'—')+'/'+(v.bp_diastolic||'—'))}</td><td>${esc(v.pulse||'—')}</td><td>${esc(v.temperature||'—')}</td><td>${esc(v.resp_rate||'—')}</td><td>${esc(v.spo2||'—')}</td></tr>`).join('')}</table></div>`:''}

   <div style="margin-top:12px">
     <button class="sec" onclick="window.print()">Print / save as PDF</button>
     <span class="muted" style="font-size:12px;margin-left:8px">Gives her a copy of her own record to carry &mdash; and the receiving facility a copy when she is referred.</span>
   </div>
  </div>`;
}

// ---- EXPORT: the facility's data, in its own hands ----------------------------------------------
// The record belongs to the facility, not to this application. If the tool goes away, or the woreda
// wants the figures in a spreadsheet, there has to be a way out. CSV, because Excel is what the
// facility and the woreda office actually use.
async function exportScreen(){
  if(!(ME.role==='provider'||ME.role==='supervisor'||ADMIN())){ app().innerHTML=nav()+'<div class="card">Providers, supervisors and admins only.</div>'; return; }
  const today=new Date().toISOString().slice(0,10);
  const first=today.slice(0,8)+'01';
  const T=[['women','Patients registered'],['anc','ANC contacts'],['deliveries','Births'],['babies','Newborns'],['pnc','Postnatal visits'],['referrals','Referrals']];
  app().innerHTML=nav()+`<div class="card">
    <h3>Export the facility&rsquo;s records</h3>
    <p class="muted">A spreadsheet of what this facility recorded, for the dates you choose. It opens in Excel.</p>
    <div class="grid">
      <label>From<input id="xf" type="date" value="${first}"></label>
      <label>To<input id="xt" type="date" value="${today}"></label>
    </div>
    <div style="margin-top:10px">${T.map(t=>`<button class="sec" data-x="${t[0]}" style="margin:3px 6px 3px 0">${t[1]}</button>`).join('')}</div>
    <div id="xm" class="muted" style="margin-top:8px;font-size:13px"></div>
    <p class="muted" style="font-size:12px;margin-top:12px">These files contain names, MRNs and clinical results, including HIV status. Treat them as you would the paper register: they do not go on an unlocked computer, and they are not sent over an unencrypted channel. Every export is recorded in the audit log with your name.</p>
  </div>`;
  document.querySelectorAll('[data-x]').forEach(b=>b.onclick=async()=>{
    const from=$('#xf').value, to=$('#xt').value;
    if(!from||!to){ $('#xm').textContent='Choose both dates.'; return; }
    b.disabled=true; $('#xm').textContent='Preparing the file…';
    try{
      // NOT through api(): that helper parses JSON and would queue this offline. An export is a file,
      // and it only makes sense with a live server.
      const res=await fetch(API_BASE+'api/export?type='+b.dataset.x+'&from='+from+'&to='+to, {credentials:'include'});
      if(!res.ok){ $('#xm').textContent='Could not export — '+(res.status===403?'you do not have permission.':'the server refused ('+res.status+').'); b.disabled=false; return; }
      const blob=await res.blob();
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=b.dataset.x+'_'+from+'_to_'+to+'.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      $('#xm').textContent='Downloaded. Check your downloads folder.';
    }catch(e){ $('#xm').textContent='Could not export — '+(e.message||'error'); }
    finally{ b.disabled=false; }
  });
}

// ---- THE REFERRAL LETTER ------------------------------------------------------------------------
// A woman referred from a health centre arrives at the hospital with whatever she can remember. The
// facility that referred her holds her blood group, her haemoglobin, her HIV status, what she was
// given and why she is being sent — and none of it travelled with her. This is the piece of paper
// that does.
async function letterScreen(id){
  const C=await api('GET','chart?episode='+id).catch(()=>null);
  if(!C||!C.woman){ app().innerHTML=nav()+'<div class="card"><h3>Record could not be loaded</h3></div>'; return; }
  const W=C.woman, anc=C.anc_visits||[], refs=C.referrals||[], dels=C.deliveries||[], bbs=C.babies||[];
  const ref=refs[refs.length-1]||null;
  const last=(col)=>{ for(let i=anc.length-1;i>=0;i--){ const v=anc[i][col]; if(v!==null&&v!==undefined&&v!=='') return v; } return null; };
  const name=((W.first_name||'')+' '+(W.father_name||'')+' '+(W.grandfather_name||'')).trim();
  const ep=(C.episodes||[]).find(e=>String(e.id)===String(id))||{};
  const line=(l,v)=>v?`<div class="rec-f"><span class="rec-l">${esc(l)}</span><span class="rec-v">${esc(v)}</span></div>`:'';
  const gaps=gapsFor(W,anc,C.labs);
  app().innerHTML=nav()+`<div class="card rec">
    <div style="text-align:center;margin-bottom:10px">
      <h3 style="margin-bottom:2px">Referral letter</h3>
      <div class="muted">${esc(ME.facility_name||'')}${ME.facility_name?' &middot; ':''}${esc(new Date().toISOString().slice(0,10))}</div>
    </div>
    <div class="rec-b"><h5>The patient</h5><div class="rec-g">
      ${line('Name',name)}${line('MRN',W.mrn)}${line('Age',W.age)}
      ${line('Gravida / Para','G'+(W.gravida||'?')+' / P'+(W.para||'?'))}
      ${line('Gestational age', ep.anc_ga_weeks?(ep.anc_ga_weeks+' weeks'):(last('ga_weeks')?last('ga_weeks')+' weeks':''))}
      ${line('Blood group', W.blood_group||'')}
      ${W.rh_factor?`<div class="rec-f"><span class="rec-l">Rh factor</span><span class="rec-v${String(W.rh_factor).toLowerCase()==='neg'?' rec-alarm':''}">${esc(String(W.rh_factor).toLowerCase()==='neg'?'NEGATIVE':'Positive')}</span></div>`:''}
      ${line('Phone',W.phone)}
    </div></div>
    <div class="rec-b"><h5>Why she is being referred</h5>
      ${ref?`<div class="rec-g">
        ${line('Referred to',ref.referred_to)}${line('Urgency',ref.urgency)}${line('Transport',ref.transport)}
        <div class="rec-f" style="grid-column:1/-1"><span class="rec-l">Reason</span><span class="rec-v${String(ref.urgency||'')==='emergency'?' rec-alarm':''}">${esc(ref.reason||'')}</span></div>
      </div>`:'<p class="muted">No referral has been recorded for this episode. Record it on the Refer screen and this letter will carry the reason.</p>'}
    </div>
    <div class="rec-b"><h5>What we found</h5><div class="rec-g">
      ${fld('hiv_test_result', last('hiv_test_result'))}
      ${fld('syphilis_result', last('syphilis_result'))}
      ${fld('hepb_result', last('hepb_result'))}
      ${fld('hgb', last('hgb'))}${fld('anaemia_grade', last('anaemia_grade'))}
      ${fld('bp_systolic', last('bp_systolic'))}${fld('bp_diastolic', last('bp_diastolic'))}
      ${fld('urine_protein', last('urine_protein'))}
      ${fld('fundal_height_cm', last('fundal_height_cm'))}${fld('fetal_heart_rate', last('fetal_heart_rate'))}
      ${fld('presentation', last('presentation'))}
      ${['prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed','chronic_htn','diabetes','cardiac_renal']
        .filter(k=>String(W[k]||'').toLowerCase()==='yes')
        .map(k=>`<div class="rec-f"><span class="rec-l">${esc({prior_cs:'Previous caesarean',prior_stillbirth:'Previous stillbirth',prior_pph:'Previous PPH',prior_preeclampsia:'Previous pre-eclampsia',prior_obstructed:'Previous obstructed labour',chronic_htn:'Chronic hypertension',diabetes:'Diabetes',cardiac_renal:'Cardiac / renal disease'}[k])}</span><span class="rec-v rec-alarm">Yes</span></div>`).join('')}
      ${dels.length?fld('mode',dels[0].mode)+fld('blood_loss_ml',dels[0].blood_loss_ml):''}
      ${bbs.map(b=>fld('weight_g',b.weight_g)+fld('apgar_5min',b.apgar_5min)+fld('outcome',b.outcome)).join('')}
    </div></div>
    <div class="rec-b"><h5>What we gave her</h5><div class="rec-g">
      ${fld('td_dose_no', last('td_dose_no'))}${fld('ifa_tabs', last('ifa_tabs'))}
      ${fld('calcium_given', last('calcium_given'))}${fld('deworming', last('deworming'))}
      ${fld('anti_d_given', last('anti_d_given'))}${fld('syphilis_treated', last('syphilis_treated'))}
    </div></div>
    ${gaps.length?`<div class="rec-b"><h5>Still outstanding at the time of referral</h5>
      <ul style="margin:4px 0 0 18px;font-size:13px">${gaps.map(g=>`<li>${esc(g[0])}</li>`).join('')}</ul></div>`:''}
    <div class="rec-b"><h5>Referring provider</h5>
      <p style="font-size:13px">${esc(ME.full_name||'')}${ME.cadre?(' &middot; '+esc(ME.cadre)):''} &middot; ${esc(ME.facility_name||'')}</p>
      <p class="muted" style="font-size:12px;margin-top:24px">Signature: ______________________________</p>
    </div>
    <div style="margin-top:12px">
      <button class="act" onclick="window.print()">Print the letter</button>
      <a class="nav" href="#report/${esc(id)}" style="margin-left:8px">Her full record &rsaquo;</a>
    </div>
  </div>`;
}

async function _reportScreenOld(id){
  const [e,obs,chk,deliv,babies,anc,pnc,refs]=await Promise.all([
    epOne(id), api('GET','observations?episode='+id).catch(()=>[]),
    api('GET','checklist?episode='+id).catch(()=>[]), api('GET','delivery?episode='+id).catch(()=>[]),
    api('GET','babies?episode='+id).catch(()=>[]), api('GET','anc_screening?episode='+id).catch(()=>[]),
    api('GET','pnc_visits?episode='+id).catch(()=>[]), api('GET','referrals?episode='+id).catch(()=>[])]);
  const d=(deliv||[])[0]||{}; const last=obs[obs.length-1]||{};
  const ancYes=(anc||[]).filter(a=>a.response==='yes').length;
  app().innerHTML=nav()+`<div class="card"><h3>Care summary — episode ${esc(id)}</h3>
   <p><b>${esc((e.first_name||'')+' '+(e.father_name||''))}</b> · MRN ${esc(e.mrn||'')} · G${esc(e.gravida||'?')}/P${esc(e.para||'?')} · ${esc(e.service_category||'')} · status ${esc(e.status||'')}</p>
   <p class="muted">Admitted ${esc((e.admission_datetime||'').slice(0,16))}${e.admitted_from&&e.admitted_from!=='new'?(' ('+esc(e.admitted_from)+')'):''}</p>
   <h4>Partograph</h4><p class="muted">${obs.length} observation(s). Last: cervix ${esc(last.cervix_cm||'—')} cm, FHR ${esc(last.fetal_heart_rate||'—')}, hrs ${esc(last.hours_since_active||'—')}.</p>
   <h4>ANC screening</h4><p class="muted">${anc.length?(ancYes?(ancYes+' risk factor(s) → specialised care'):'no risk factors → basic ANC'):'not screened'}</p>
   <h4>Safe-birth checklist</h4><p class="muted">${chk.length} item(s) recorded.</p>
   <h4>Delivery</h4><p class="muted">${d.delivery_datetime?('Mode '+esc(d.mode||'')+', partograph '+esc(d.partograph_used||'?')+', mother '+esc(d.maternal_status||d.maternal_outcome||'')):'not delivered'}</p>
   <h4>Newborn(s)</h4><p class="muted">${babies.length?babies.map(b=>'#'+esc(b.birth_order)+' '+esc(b.sex||'')+' '+esc(b.weight_g||'?')+'g APGAR '+esc(b.apgar_1min||'?')+'/'+esc(b.apgar_5min||'?')+' '+esc(b.outcome||'')).join('; '):'none recorded'}</p>
   <h4>PNC follow-up</h4><p class="muted">${pnc.length} visit(s).</p>
   <h4>Referral</h4><p class="muted">${refs.length?refs.map(r=>'to '+esc(r.referred_to||'')+' ('+esc(r.urgency||'')+') — '+esc(r.reason||'')).join('; '):'none'}</p>
   <button class="sec" onclick="window.print()" style="margin-top:10px">Print</button></div>`;
}

const BEMONC=[
 ['BEM_ANTIBIOTICS','Parenteral antibiotics'],
 ['BEM_UTEROTONIC','Uterotonic for PPH (oxytocin / misoprostol)'],
 ['BEM_MGSO4','Anticonvulsant — magnesium sulfate'],
 ['BEM_MANUAL_PLACENTA','Manual removal of placenta'],
 ['BEM_RETAINED_PRODUCTS','Removal of retained products'],
 ['BEM_ASSISTED_DELIVERY','Assisted vaginal delivery (vacuum)'],
 ['BEM_NEWBORN_RESUS','Newborn resuscitation']
];
async function bemoncScreen(id){
  const existing=await api('GET','bemonc?episode='+id).catch(()=>[]);
  const prev={}; existing.forEach(r=>prev[r.item_code]=r.response);
  app().innerHTML=nav()+`<div class="card"><h3>Basic Emergency Obstetric &amp; Newborn Care (BEmONC) — episode ${esc(id)}</h3>
   <p class="muted">Record the emergency obstetric &amp; newborn signal functions. "Referred" = indicated but not available here (needs hospital / CEmONC).</p>
   ${BEMONC.map(it=>{const v=prev[it[0]]||'not_needed'; return `<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center;gap:10px">${esc(it[1])}
     <select data-code="${it[0]}" style="width:170px"><option value="not_needed"${v==='not_needed'?' selected':''}>Not needed</option><option value="given"${v==='given'?' selected':''}>Given</option><option value="referred"${v==='referred'?' selected':''}>Referred (unavailable)</option></select></label></div>`;}).join('')}
   <button class="act" id="bsave" style="margin-top:12px">Save</button> <span class="muted" id="bm"></span></div>`;
  $('#bsave').onclick=async()=>{ const b=$('#bsave'); if(b.disabled) return; b.disabled=true;
    try{ const rows=[...document.querySelectorAll('#app select[data-code]')].map(s=>({episode_id:+id,item_code:s.dataset.code,response:s.value}));
      const r=await api('POST','bemonc',rows); $('#bm').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error');
    } finally{ b.disabled=false; } };
}

async function facilityEdit(id){
  if(!SUPER()){ app().innerHTML=nav()+'<div class="card">Facilities are managed centrally &mdash; a super-admin action.</div>'; return; }
  const list=await api('GET','facilities').catch(()=>[]); const f=(list||[]).find(x=>x.id==id)||{};
  const types=['health_center','primary_hospital','general_hospital','other'];
  app().innerHTML=nav()+`<div class="card"><h3>Edit facility</h3>
    <div class="grid">
     <label>Name<input id="fnm" value="${esc(f.name||'')}"></label>
     <label>Type<select id="fty">${types.map(t=>`<option value="${t}"${f.facility_type===t?' selected':''}>${t.replace('_',' ')}</option>`).join('')}</select></label>
     <label>Kebele<input id="fke" value="${esc(f.kebele||'')}"></label><label>Woreda<input id="fwo" value="${esc(f.woreda||'')}"></label>
     <label>Zone<input id="fzo" value="${esc(f.zone||'')}"></label><label>Region<input id="fre" value="${esc(f.region||'')}"></label>
     <label>DHIS2 org-unit code<input id="fdh" value="${esc(f.dhis2_org_unit||'')}"></label>
    </div><button class="act" id="fsave" style="margin-top:10px">Save changes</button> <a class="nav" href="#facilities">Cancel</a> <span class="muted" id="fm"></span></div>`;
  $('#fsave').onclick=async()=>{ const r=await api('PATCH','facilities/'+id,{name:fnm.value,facility_type:fty.value,kebele:fke.value,woreda:fwo.value,zone:fzo.value,region:fre.value,dhis2_org_unit:fdh.value});
    if(r&&(r.ok||r.queued)){ $('#fm').textContent=' saved'; setTimeout(()=>location.hash='#facilities',600); } else $('#fm').textContent=' '+((r&&r.error)||'error'); };
}

async function patientHub(id){
  // Fetch HER episode by id. Reading it out of the LIMIT-200 list meant that past 200 episodes
  // she resolved to {} — and the failure was silent and clinical: the Rh-negative banner
  // vanished, a woman on ART was offered an HIV test, and the hub rendered labour tiles for an
  // ANC patient.
  let e=null;
  try{ const one=await api('GET','episodes?ep='+id); e=(Array.isArray(one)?one[0]:one)||null; }catch(err){ e=null; }
  if(!e){
    app().innerHTML=nav()+`<div class="card"><h3>Record could not be loaded</h3>
      <p class="muted">This episode could not be found &mdash; it may belong to another facility, or the connection failed. <b>Nothing has been changed.</b> Do not enter data against a record you cannot see.</p>
      <a class="nav" href="#home">&lsaquo; Home</a></div>`;
    return;
  }
  const cat=e.service_category;
  const delivered=(String(e.status||'')==='delivered'); const isLab=(cat==='labour'||cat==='highrisk'); const postnatal=(cat==='pnc'||(isLab&&delivered));
  const tile=(href,txt)=>`<a class="hubx" href="${href}">${txt}</a>`;
  // Is she in the PMTCT cohort? Her PMTCT chart used to be invisible from her maternity chart.
  let pmRec=null;
  if(e.woman_id){ try{ const pms=await api('GET','pmtct'); pmRec=(pms||[]).find(p=>p.woman_id==e.woman_id)||null; }catch(err){} }
  const pmTile = pmRec ? tile('#pmtctclient/'+pmRec.id,'PMTCT &amp; exposed infant') : '';
  // RISK SCREENING BELONGS ON EVERY EPISODE. It used to appear only for ANC — so a woman
  // admitted straight into labour, unbooked (high risk by definition), had no way anywhere in
  // the application to record a previous caesarean. The model then scored her prior_cs = 0.
  const scrTile = tile('#anc/'+id,'Risk screening');
  let tiles, fold='';
  if(ME.role==='observer') tiles=[tile('#report/'+id,'Full record')];   // read-only role: view the summary, no data-entry screens
  else if(cat==='anc') tiles=[scrTile,tile('#ancvisit/'+id,'Follow-up visit'),tile('#vitals/'+id,'Vital signs'),tile('#danger/'+id,'Danger signs'),pmTile,tile('#referral/'+id,'Refer'),tile('#letter/'+id,'Referral letter'),tile('#report/'+id,'Full record'),tile('#editwoman/'+e.woman_id,'Edit details')];
  else if(postnatal){ tiles=[tile('#pncvisit/'+id,'PNC follow-up'),tile('#baby/'+id,'Newborn'),tile('#vitals/'+id,'Vital signs'),tile('#danger/'+id,'Danger signs'),scrTile,pmTile,tile('#editwoman/'+e.woman_id,'Obstetric details'),tile('#referral/'+id,'Refer'),tile('#letter/'+id,'Referral letter'),tile('#report/'+id,'Full record')];
    if(isLab&&delivered){ const lab=[tile('#partograph/'+id,'Partograph &amp; AI'),tile('#delivery/'+id,'Delivery'),tile('#checklist/'+id,'Safe-birth checklist'),tile('#bemonc/'+id,'Emergency care (BEmONC)'),tile('#handover/'+id,'Handover')];
      fold=`<details style="margin-top:10px;border:0.5px solid #e6eae8;border-radius:10px"><summary style="cursor:pointer;padding:10px 12px;font-size:13px;color:#334155">Labour &amp; delivery record <span class="muted">&mdash; for review</span></summary><div class="hubgrid" style="padding:0 12px 12px">${lab.join('')}</div></details>`; } }
  else tiles=[tile('#partograph/'+id,'Partograph &amp; AI'),scrTile,tile('#vitals/'+id,'Vital signs'),tile('#checklist/'+id,'Safe-birth checklist'),tile('#danger/'+id,'Danger signs'),tile('#delivery/'+id,'Delivery'),tile('#baby/'+id,'Newborn'),pmTile,tile('#bemonc/'+id,'Emergency care (BEmONC)'),tile('#handover/'+id,'Handover'),tile('#editwoman/'+e.woman_id,'Obstetric details'),tile('#referral/'+id,'Refer'),tile('#letter/'+id,'Referral letter'),tile('#report/'+id,'Full record')];
  tiles=tiles.filter(Boolean);
  const _nm=((e.first_name||'')+' '+(e.father_name||'')).trim();
  const _ini=(_nm.split(/\s+/).map(s=>s[0]||'').join('').slice(0,2)||'—').toUpperCase();
  let _ga=''; if(e.edd){ const _d=(new Date(e.edd+'T00:00:00')-new Date())/86400000; const _w=Math.round((280-_d)/7); if(_w>0&&_w<=45) _ga=_w+' wga'; }
  const _book=e.ga_first_contact?('booked '+e.ga_first_contact+'w'+(e.late_anc_initiation==1?' (late)':'')):'';
  window.CTX={id:+id, ini:_ini, name:_nm||('Episode '+id), meta:['MRN '+(e.mrn||''),'G'+(e.gravida||'?')+'/P'+(e.para||'?'),_ga,_book,e.status].filter(Boolean).join(' · ')};
  app().innerHTML=nav()+`<div class="card"><h3>${esc((e.first_name||'')+' '+(e.father_name||''))||('Episode '+esc(id))}</h3>
    <p class="muted">MRN ${esc(e.mrn||'')} &middot; G${esc(e.gravida||'?')}/P${esc(e.para||'?')} &middot; ${esc(cat||'')} &middot; ${esc(e.status||'')}${e.admitted_from&&e.admitted_from!=='new'?(' &middot; admitted from '+esc(e.admitted_from)):''} ${syncPill(e)}</p>
    ${isLocalId(e.id)?`<p style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:13px">
       This chart exists only on <b>this device</b> so far. Everything you record on it is safe and will be sent to the server automatically when there is a connection. Do not wipe or hand over the tablet before the sync pill reads <b>online</b>.</p>`:''}
    ${(e.referred==1 && !e.returned_at)?`<p style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:13px">
       <b>Referred out</b>${e.referred_at?(' on '+esc(String(e.referred_at).slice(0,16))):''} &mdash; she has not been recorded as back.
       <button id="epreturn" class="sm" style="margin-left:6px">She has come back</button></p>`:''}
    ${(e.referred==1 && e.returned_at)?`<p class="muted" style="font-size:12px;margin:4px 0">Referred out${e.referred_at?(' on '+esc(String(e.referred_at).slice(0,16))):''} &middot; came back on ${esc(String(e.returned_at).slice(0,16))}.</p>`:''}
    ${e.late_anc_initiation==1?`<p style="background:#faeeda;border:1px solid #ef9f27;color:#633806;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:13px">Late ANC initiation &mdash; first contact at ${esc(e.ga_first_contact)} weeks.</p>`:''}
    ${(isLab&&!delivered)?`<p class="muted" style="margin:2px 0 8px">Membranes: <select id="rmset"><option value="0">Intact</option><option value="1">Ruptured</option></select>
      <span id="rmtwrap" style="display:none"> ruptured at <input id="rmt" type="datetime-local" style="width:auto"> <button id="rmtsave" class="sm">Save time</button></span>
      <span id="rmtshow" class="muted"></span></p>`:''}
    <div class="hubgrid">${tiles.join('')}</div>${fold}
    <div id="hubknown"></div>
    ${(ME.role==='provider'||ADMIN())?`<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">
      ${String(e.status||'')==='closed'
        ? `<span class="pill" style="background:#eef1f0;color:#4a5754">This episode of care is closed${e.closed_datetime?(' &middot; '+esc(String(e.closed_datetime).slice(0,16))):''}</span>
           <button id="epreopen" class="sm" style="margin-left:8px">She has come back &mdash; reopen</button>`
        : `<button id="epclose" class="sm">Close this episode of care</button>
           <span class="muted" style="font-size:12px">Takes her off the worklist. The record stays, and can be reopened.</span>`}
     </div>`:''}
    ${(ME.role==='provider'||ADMIN())?`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button id="epvoid" class="sm" style="background:#a32d2d">Remove this episode&hellip;</button>
      <button id="wvoid" class="sm" style="background:#a32d2d;margin-left:6px">Remove this patient&hellip;</button>
      <div class="muted" style="font-size:12px;margin-top:4px">For a record that should never have existed &mdash; the wrong patient, a duplicate, a test entry. It is taken off every worklist, register and count, but <b>nothing is destroyed</b>: the record is kept with your name and your reason, and an admin can restore it.
      ${ME.role==='provider'?' An admin is told when a provider removes a record.':''}</div>
     </div>`:''}</div>`;

  // ---- WHAT IS ALREADY KNOWN ABOUT HER ------------------------------------------------------
  // The tool held a reactive syphilis result, an unsuppressed viral load, the fundal-height series
  // and the danger note the last provider wrote — and showed the next provider a row of tiles. This
  // panel puts the findings that CHANGE WHAT YOU DO TODAY in front of her before she starts writing.
  //
  // It loads AFTER the tiles, and never blocks them: on a bad link the hub still works.
  if(ME.role!=='observer' && ME.role!=='recorder' && !isLocalId(e.id)){
    (async()=>{
      const C=await api('GET','chart?episode='+id).catch(()=>null);
      const box=$('#hubknown'); if(!C||!C.woman||!box) return;
      const anc=C.anc_visits||[], pnc=C.pnc_visits||[], bbs=C.babies||[], dels=C.deliveries||[];
      const gaps=gapsFor(C.woman,anc,C.labs);
      const lastOf=(rows,col)=>{ for(let i=rows.length-1;i>=0;i--){ const v=rows[i][col]; if(v!==null&&v!==undefined&&v!=='') return v; } return null; };

      // The findings that persist and must not be re-asked or forgotten.
      const persist=[];
      const push=(col,val)=>{ const h=fld(col,val); if(h) persist.push(h); };
      push('syphilis_result', lastOf(anc,'syphilis_result')); push('syphilis_treated', lastOf(anc,'syphilis_treated'));
      push('hepb_result', lastOf(anc,'hepb_result')); push('hepb_prophylaxis', lastOf(anc,'hepb_prophylaxis'));
      push('hiv_test_result', lastOf(anc,'hiv_test_result')); push('viral_load', lastOf(anc,'viral_load'));
      push('hgb', lastOf(anc,'hgb')); push('anaemia_grade', lastOf(anc,'anaemia_grade'));
      push('td_dose_no', lastOf(anc,'td_dose_no')); push('ifa_tabs', lastOf(anc,'ifa_tabs'));
      push('calcium_given', lastOf(anc,'calcium_given')); push('deworming', lastOf(anc,'deworming'));
      push('anti_d_given', lastOf(anc,'anti_d_given')); push('ultrasound_lt24w', lastOf(anc,'ultrasound_lt24w'));
      push('presentation', lastOf(anc,'presentation')); push('urine_protein', lastOf(anc,'urine_protein'));
      push('ipv_screen', lastOf(anc,'ipv_screen')); push('mental_health', lastOf(anc,'mental_health'));
      push('substance_use', lastOf(anc,'substance_use'));
      const d0=dels[0]||{};
      push('blood_loss_ml', d0.blood_loss_ml); push('comp_pph', d0.comp_pph); push('comp_eclampsia', d0.comp_eclampsia);
      push('comp_preeclampsia', d0.comp_preeclampsia); push('amtsl_placenta', d0.amtsl_placenta);
      push('ippfp_method', d0.ippfp_method);
      bbs.forEach(b=>{ ['weight_g','apgar_5min','outcome','breastfeed_initiated','vitamin_k_time','hiv_exposed','arv_prophylaxis','dbs_sample','dbs_result','nicu']
        .forEach(c=>{ const h=fld(c,b[c]); if(h) persist.push('<div class="rec-f"><span class="rec-l">Newborn '+esc(b.birth_order||'')+' &middot; '+esc((F[c]||[c])[0])+'</span><span class="rec-v'+(isAlarming(c,b[c])?' rec-alarm':'')+'">'+esc(String(b[c]))+'</span></div>'); }); });

      // The last provider's own words to the next one — written down and, until now, never read.
      const notes=[];
      const lastAnc=anc[anc.length-1], lastPnc=pnc[pnc.length-1];
      if(lastAnc&&lastAnc.danger_note) notes.push(['Danger signs noted at the last contact', lastAnc.danger_note]);
      if(lastAnc&&lastAnc.remark)      notes.push(['Remark from the last contact', lastAnc.remark]);
      if(lastPnc&&lastPnc.danger_note) notes.push(['Danger signs at the last postnatal visit', lastPnc.danger_note]);
      if(lastPnc&&lastPnc.remark)      notes.push(['Remark from the last postnatal visit', lastPnc.remark]);

      if(!persist.length && !notes.length && !gaps.length) return;
      box.innerHTML=`<div class="card rec" style="margin-top:12px">
        <h3 style="font-size:15px">What is already known about her</h3>
        <p class="muted" style="font-size:12px;margin-top:-4px">Recorded at an earlier contact. Read it before you write today&rsquo;s.</p>
        ${gaps.length?`<div class="rec-b" style="border-left:4px solid #a32d2d;padding-left:10px">
          <h5 style="color:#a32d2d">Still outstanding</h5>
          ${gaps.map(g=>`<div style="margin-bottom:6px"><b>${esc(g[0])}</b><div class="muted" style="font-size:12px">${esc(g[1])}</div></div>`).join('')}
        </div>`:''}
        ${persist.length?`<div class="rec-b"><div class="rec-g">${persist.join('')}</div></div>`:''}
        ${notes.length?`<div class="rec-b">${notes.map(n=>`<div style="margin-bottom:6px"><span class="rec-l" style="font-size:12px">${esc(n[0])}</span><div style="font-weight:600;color:#1f2937">${esc(n[1])}</div></div>`).join('')}</div>`:''}
        <a class="nav" href="#report/${esc(id)}">Open her full record &rsaquo;</a>
      </div>`;
    })();
  }

  // ---- VOID (soft delete) -------------------------------------------------------------------
  // Nothing could ever be removed: not a woman registered twice by mistake, not an episode opened on
  // the wrong patient. Closing an episode only takes it off the worklist — the record is still real,
  // still counted, still in the register. This is for a record that should NEVER HAVE EXISTED.
  const askVoid=(what, targetId, name)=>{
    // A record created offline has no server id yet — only a local placeholder. The server cannot be
    // asked to remove something it has never seen, so say so plainly instead of failing with a 404.
    if(isLocalId(targetId)){
      toast('This record has not reached the server yet. Let it sync first, then remove it.');
      return;
    }
    const old=document.getElementById('mdl'); if(old) old.remove();
    const d=document.createElement('div'); d.id='mdl';
    d.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px';
    d.innerHTML=`<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)">
      <h3 style="margin:0 0 8px;color:#a32d2d;font-size:16px">Remove ${what==='woman'?'this patient':'this episode'}?</h3>
      <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#334155">${esc(name)}<br>
      ${what==='woman'?'<b>Her whole record, and every episode of care on it,</b> will be taken off every worklist, register and count.':'This episode, and everything recorded on it, will be taken off every worklist, register and count.'}
      Nothing is destroyed &mdash; it is kept with your name and your reason, and an admin can restore it.</p>
      <label style="font-size:13px;color:#334155">Why is this being removed? <span style="color:#a32d2d">(required)</span>
        <input id="vreason" placeholder="e.g. registered twice by mistake" style="width:100%;margin-top:4px"></label>
      <div id="verr" style="color:#a32d2d;font-size:13px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="sec" id="vcancelbtn" style="flex:1">Cancel</button>
        <button class="act" id="vok" style="flex:1;background:#a32d2d">Remove</button>
      </div></div>`;
    document.body.appendChild(d);
    $('#vcancelbtn').onclick=()=>d.remove();
    $('#vok').onclick=async()=>{
      const reason=($('#vreason').value||'').trim();
      if(reason.length<3){ $('#verr').textContent='Please say why. It is the only record of what happened to this patient.'; return; }
      $('#vok').disabled=true;
      const r=await api('POST','void',{entity:what, id:+targetId, reason}).catch(e=>({error:e.message}));
      if(r&&r.ok){ d.remove(); toast(what==='woman'?'The patient record was removed':'The episode was removed','ok'); location.hash='#home'; }
      else { $('#vok').disabled=false; $('#verr').textContent=(r&&r.error)||'Could not remove it.'; }
    };
  };
  const _vname=((e.first_name||'')+' '+(e.father_name||'')).trim()+' — MRN '+(e.mrn||'');
  const evb=$('#epvoid'); if(evb) evb.onclick=()=>askVoid('episode', id, _vname+' · '+(cat||'')+' episode');
  const wvb=$('#wvoid');  if(wvb) wvb.onclick=()=>askVoid('woman', e.woman_id, _vname);

  // CLOSING AN EPISODE. Nothing in ADHERE+ ever ended one — the enum had 'closed', the schema had
  // closed_datetime, and no code touched either. So every woman ever registered stayed on a
  // worklist for ever, and a woman moved from ANC to labour sat on both at once.
  const cbtn=$('#epclose');
  if(cbtn) cbtn.onclick=async()=>{
    if(!confirm('Close this episode of care?\n\nShe comes off the worklist. Nothing is deleted — the whole record stays readable, and you can reopen it if she comes back.')) return;
    cbtn.disabled=true;
    const r=await api('PATCH','episodes/'+id,{status:'closed'});
    if(r&&(r.ok||r.closed)){ toast('Episode closed','ok'); patientHub(id); }
    else { cbtn.disabled=false; toast((r&&r.error)||'Could not close'); }
  };
  // CLOSING THE REFERRAL LOOP. She came back. Record it, so the worklist stops saying she is away.
  const retb=$('#epreturn');
  if(retb) retb.onclick=async()=>{
    retb.disabled=true;
    const r=await api('PATCH','episodes/'+id,{returned_at:localDateTime()});
    if(r&&(r.ok||r.queued)){ toast('Recorded — she is back from referral','ok'); patientHub(id); }
    else { retb.disabled=false; toast((r&&r.error)||'Could not record'); }
  };
  const rbtn=$('#epreopen');
  if(rbtn) rbtn.onclick=async()=>{
    rbtn.disabled=true;
    const r=await api('PATCH','episodes/'+id,{status:'reopen'});
    if(r&&r.ok){ toast('Reopened as "'+(r.status||'active')+'"','ok'); patientHub(id); }
    else { rbtn.disabled=false; toast((r&&r.error)||'Could not reopen'); }
  };
  // Rupture TIME, not just the fact of rupture. The scorer derives rom_hours from this column and
  // the model was trained on it; until now nothing could write it, so the feature was dead.
  if(isLab&&!delivered){
    const rs=$('#rmset'), wrap=$('#rmtwrap'), rmt=$('#rmt'), show=$('#rmtshow');
    const paint=()=>{
      const on=(rs.value==='1');
      if(wrap) wrap.style.display=on?'':'none';
      if(show) show.textContent=(on&&e.ruptured_datetime)?('— ruptured '+String(e.ruptured_datetime).slice(0,16).replace(' ','T').replace('T',' ')+' ('+romHrs(e.ruptured_datetime)+'h)'):'';
      if(on&&rmt&&!rmt.value) rmt.value=(e.ruptured_datetime?String(e.ruptured_datetime).slice(0,16).replace(' ','T'):localDateTime().slice(0,16).replace(' ','T'));
    };
    if(rs){ rs.value=String(e.ruptured_membrane||0); paint();
      rs.onchange=async()=>{ paint();
        const body={ruptured_membrane:+rs.value};
        if(rs.value!=='1') body.ruptured_datetime=null;                 // intact again: clear the clock
        const r=await api('PATCH','episodes/'+id,body); if(r&&(r.ok||r.queued)) toast('Membranes updated','ok'); }; }
    const sv=$('#rmtsave');
    if(sv) sv.onclick=async()=>{
      if(!rmt.value){ toast('Enter the time the membranes ruptured'); return; }
      const when=rmt.value.replace('T',' ')+':00';
      // The provider types the CLINIC's clock, so validate it against the clinic's clock — on a
      // device in another zone, Date.parse() would read it as the device's and reject a valid time.
      const w=parseLocal(when);
      if(w && w.getTime()>Date.now()+60000){ toast('That is in the future'); return; }
      sv.disabled=true;
      const r=await api('PATCH','episodes/'+id,{ruptured_membrane:1,ruptured_datetime:when});
      sv.disabled=false;
      if(r&&(r.ok||r.queued)){ e.ruptured_datetime=when; paint(); toast('Rupture time saved — the score now sees hours since ROM','ok'); }
    };
  }
}

async function supervisorDash(){
  if(ME.role!=='supervisor'&&!ADMIN()){ app().innerHTML=nav()+'<div class="card">Supervisors only.</div>'; return; }
  const days=window._supDays||0;
  let d; try{ d=await api('GET','supervisor'+(days?('?days='+days):'')); }catch(e){ app().innerHTML=nav()+'<div class="card">Could not load dashboard: '+esc(e.message||'error')+'</div>'; return; }
  const fac=d.facilities||[];
  const tot=fac.reduce((a,f)=>({lab:a.lab+f.labour_episodes,ps:a.ps+f.partographs_started,del:a.del+f.deliveries,red:a.red+f.red_alerts,ref:a.ref+f.referrals}),{lab:0,ps:0,del:0,red:0,ref:0});
  const band=v=>v>=80?'green':v>=50?'amber':'red';
  const rows=fac.map(f=>`<tr><td>${esc(f.name)}</td><td class="muted">${esc(f.woreda||'')}</td><td>${f.labour_episodes}</td><td><span class="pill ${band(f.partograph_completion)}">${f.partograph_completion}%</span></td><td>${f.deliveries}</td><td>${f.red_alerts}</td><td>${f.referrals}</td></tr>`).join('')||'<tr><td colspan=7 class=muted>No facilities in your scope yet.</td></tr>';
  const totPct=tot.lab?Math.round(100*tot.ps/tot.lab):0;
  const card=(v,l)=>`<div class="hubx" style="cursor:default"><b style="font-size:20px">${v}</b><br>${l}</div>`;
  app().innerHTML=nav()+`<div class="card"><h3>Supervisor dashboard <span class="pill">${esc(d.scope||'facility')} scope</span></h3>
   <p class="muted">Period: <select id="supp" style="width:auto;display:inline-block"><option value="0"${days===0?' selected':''}>All time</option><option value="30"${days===30?' selected':''}>Last 30 days</option><option value="90"${days===90?' selected':''}>Last 90 days</option></select> &middot; ${fac.length} facilit${fac.length===1?'y':'ies'} in your ${esc(d.scope||'facility')}. "Partograph started" = share of labour episodes with ≥1 observation recorded.</p>
   <div class="hubgrid" style="margin-bottom:10px">${card(tot.lab,'Labour episodes')}${card(totPct+'%','Partograph started')}${card(tot.del,'Deliveries')}${card(tot.red,'Red AI alerts')}${card(tot.ref,'Referrals')}</div>
   <table><tr><th>Facility</th><th>Woreda</th><th>Labour</th><th>Partograph started</th><th>Deliveries</th><th>Red alerts</th><th>Referrals</th></tr>${rows}</table></div>`;
  const ps=$('#supp'); if(ps) ps.onchange=()=>{ window._supDays=+ps.value; supervisorDash(); };
}

async function remindersScreen(){
  if(ME.role!=='supervisor'&&!ADMIN()){ app().innerHTML=nav()+'<div class="card">Admins &amp; supervisors only.</div>'; return; }
  const list=await api('GET','reminders').catch(()=>[]);
  const pill=s=>s==='sent'?'green':s==='pending'?'amber':s==='failed'?'red':'';
  const rowsHtml=(list||[]).map(r=>`<tr><td>${esc((r.created_at||'').slice(0,16))}</td><td>${esc(((r.first_name||'')+' '+(r.father_name||'')).trim())}</td><td>${esc(r.kind||'')}</td><td>${esc(r.due_date||'')}</td><td>${esc(r.phone||'')}</td><td><span class="pill ${pill(r.status)}">${esc(r.status||'')}</span>${r.provider_note?(' <span class="muted" style="font-size:11px">'+esc(r.provider_note)+'</span>'):''}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No reminders yet. Add ANC follow-up visits with a next-appointment date, capture SMS consent, then run the scheduler.</td></tr>';
  app().innerHTML=nav()+`<div class="card"><h3>SMS reminders</h3>
   <p class="muted">ANC follow-up reminders (Amharic) for women who gave SMS consent and have a phone on file. Sending runs on a schedule; you can also run it now. Actual delivery goes through the configured SMS gateway.</p>
   ${ADMIN()?'<button class="act" id="rrun">Generate &amp; send due reminders</button> <span class="muted" id="rmsg"></span>':''}</div>
   <div class="card"><h3>Recent reminders</h3><table><tr><th>Created</th><th>Woman</th><th>Type</th><th>Due</th><th>Phone</th><th>Status</th></tr>${rowsHtml}</table></div>`;
  const b=$('#rrun'); if(b) b.onclick=async()=>{ $('#rmsg').textContent=' running…'; try{ const r=await api('POST','reminders/run'); $('#rmsg').textContent=' generated '+r.generated+', sent '+r.sent+', skipped '+r.skipped+(r.failed?(', failed '+r.failed):''); setTimeout(()=>remindersScreen(),1000); }catch(e){ $('#rmsg').textContent=' '+(e.message||'error'); } };
}

// ---- Service worker: make sure clients actually GET the new build -------------
// Bug found in the v16 audit: phones were still running adhere-v29 four deploys later.
// The browser HTTP-caches service-worker.js, so it never saw the new cache name and
// kept serving the old app.js. Three things are needed:
//   1. updateViaCache:'none'  — never take service-worker.js from the HTTP cache
//   2. reg.update()           — actively check for a new worker on load and hourly
//   3. skipWaiting + reload   — when a new worker takes over, reload once so the
//                               user is on the new code immediately
if('serviceWorker' in navigator){
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading) return; reloading=true;
    location.reload();          // the new worker has taken control — run the new code
  });
  navigator.serviceWorker.register('./service-worker.js',{updateViaCache:'none'}).then(reg=>{
    reg.update().catch(()=>{});
    setInterval(()=>reg.update().catch(()=>{}), 60*60*1000);   // hourly
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) reg.update().catch(()=>{}); });
  }).catch(()=>{});
}
boot();
