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
  if(o.tmp>=38){up('amber');R.push('fever');}
  if(o.hrs>=6&&(o.cvx-4)/o.hrs<0.25){up('red');R.push('arrested labour');} else if(o.hrs>=4&&(o.cvx-4)/o.hrs<0.5){up('amber');R.push('protracted labour');}
  return {band,reasons:R};
}
// clinically-neutral defaults for features the partograph UI does not collect
const FEAT_DEFAULTS={age:25,parity:1,ga:39,prior_cs:0,rom_hours:2,meconium:0,urine_prot:0,bleeding:0,headache:0,blurred:0,epigastric:0,clonus:0};
// Derive real maternal features from the woman's record (falls back to neutral defaults).
function motherFeats(W){ W=W||{};
  const out={};
  if(W.age!=null&&W.age!=='') out.age=+W.age;
  if(W.para!=null&&W.para!=='') out.parity=+W.para;
  if(W.lnmp){ const d=(Date.now()-new Date(W.lnmp+'T00:00:00').getTime())/864e5; if(d>0&&d<310) out.ga=Math.max(24,Math.min(43,Math.round(d/7))); }
  if(W.prior_cs==='yes') out.prior_cs=1;
  return out;
}
// Transparent MEOWS (Modified Early Obstetric Warning Score): aggregate-weighted trigger score.
// Any single parameter scoring 3 = red trigger; total>=5 = red; total 3-4 = amber (increase monitoring).
function meowsScore(v){ const parts=[]; let total=0;
  const add=(pts,label)=>{ if(pts>0){ total+=pts; parts.push({pts,label}); } };
  const s=+v.sbp; if(!isNaN(s)){ add(s<=90?3:s>=160?3:(s>=150||s<=100)?2:s>=140?1:0, 'systolic '+s); }
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
const online=()=>navigator.onLine;
function newCid(){ try{ return crypto.randomUUID(); }catch(e){ return 'c'+Date.now()+Math.random().toString(36).slice(2); } }

async function api(method, path, bodyObj){
  const write=method!=='GET'; const cid=write?newCid():null;   // stable key for idempotent (offline-safe) writes
  try{
    const headers={'Content-Type':'application/json'}; if(cid) headers['X-Idempotency-Key']=cid;
    const res=await fetch(API_BASE+'api/'+path,{method,headers,
      credentials:'include',body:bodyObj?JSON.stringify(bodyObj):undefined});
    if(!res.ok) throw new Error((await res.json()).error||res.status);
    return await res.json();
  }catch(e){
    if(write && !online()){ queue({method,path,bodyObj,cid}); return {queued:true}; }
    throw e;
  }
}
function queue(item){ const q=JSON.parse(localStorage.qq||'[]'); item.by=(ME&&ME.id)||null; if(!item.cid) item.cid=newCid(); q.push(item); localStorage.qq=JSON.stringify(q); paintNet(); }
async function flush(){ let q=JSON.parse(localStorage.qq||'[]'); if(!q.length)return; const cur=(ME&&ME.id)||null; const keep=[];
  for(const it of q){ if(it.by && cur && it.by!==cur){ keep.push(it); continue; }   // shared tablet: never replay another user's queued writes under this session
    try{ const hd={'Content-Type':'application/json'}; if(it.cid) hd['X-Idempotency-Key']=it.cid; const res=await fetch(API_BASE+'api/'+it.path,{method:it.method,headers:hd,credentials:'include',body:JSON.stringify(it.bodyObj)}); if(!res.ok){ if(res.status>=500) keep.push(it); else { const dl=JSON.parse(localStorage.dlq||'[]'); dl.push(Object.assign({status:res.status,at:Date.now()},it)); localStorage.dlq=JSON.stringify(dl); } } }catch(e){ keep.push(it);} }
  localStorage.qq=JSON.stringify(keep); paintNet(); }
function paintNet(){ const q=JSON.parse(localStorage.qq||'[]'); const n=$('#net');
  const dl=(JSON.parse(localStorage.dlq||'[]')).length; n.textContent=(online()?(q.length?('sync '+q.length+' pending'):'online'):'offline')+(dl?(' · '+dl+' failed'):'');
  n.className='pill '+(online()?(q.length?'amber':'green'):'red'); }
window.addEventListener('online',()=>{paintNet();flush();}); window.addEventListener('offline',paintNet);
// Visible feedback so a save can never fail silently (api() throws on any non-OK response).
function toast(msg,kind){ let t=document.getElementById('toast'); if(!t){ t=document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);color:#fff;padding:10px 18px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:9999;max-width:92%;font-size:14px;transition:opacity .3s'; document.body.appendChild(t); } t.style.background=(kind==='ok')?'#0f6e56':'#a32d2d'; t.textContent=msg; t.style.opacity='1'; clearTimeout(t._h); t._h=setTimeout(()=>{ t.style.opacity='0'; },4500); }
window.addEventListener('unhandledrejection',e=>{ const m=(e.reason&&e.reason.message)?e.reason.message:''; if(m&&m!=='undefined') toast('Could not save — '+m+'. Nothing was recorded; please try again.'); });

async function boot(){
  try{ MODEL=await (await fetch('model/risk_model.json')).json(); RM=new RiskModel(MODEL); }catch(e){}
  try{ NBMODEL=await (await fetch('model/newborn_model.json')).json(); NRM=new RiskModel(NBMODEL); }catch(e){}
  try{ RULES=await (await fetch('model/mch_rules.json')).json(); RE=new RulesEngine(RULES); }catch(e){}
  try{ const r=await api('GET','me'); ME=r.user; if(ME) localStorage.me=JSON.stringify(ME); }catch(e){}
  if(!ME && localStorage.me){ ME=JSON.parse(localStorage.me); ME._offline=true; }
  paintNet(); route();
}
$('#logout').onclick=async()=>{ try{ await api('GET','logout'); }catch(e){} ME=null; localStorage.removeItem('me'); location.hash=''; route(); };
window.addEventListener('hashchange', route);

function route(){
  $('#who').textContent = ME?(' — '+ME.full_name+' ['+ME.role+']'+(ME.facility_name?' · '+ME.facility_name:'')+(ME._offline?' · offline':'')):'';
  $('#logout').style.display = ME?'inline-block':'none';
  if(!ME) return login();
  if(ME.must_change_password==1 && !ME._offline) return forcePw();
  const h=(location.hash||'#home').slice(1); const [screen,arg]=h.split('/');
  ({home:home,register:register,antenatal:ancList,labour:labour,highrisk:highriskList,partograph:partograph,anc:ancScreen,
    checklist:checklist,danger:danger,delivery:delivery,pnc:pnc,dashboard:dashboard,users:users,facilities:facilities,
    referral:referralScreen,ancvisit:ancVisits,pncvisit:pncVisits,baby:babiesScreen,handover:handoverScreen,vitals:vitalsScreen,report:reportScreen,editwoman:editWoman,patient:patientHub,facilityedit:facilityEdit,bemonc:bemoncScreen,supervisor:supervisorDash,reminders:remindersScreen,registers:registersScreen}[screen]||(ME.role==='supervisor'?supervisorDash:home))(arg);
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
  const top=`<nav class="navbar">${back}
  ${(ME.role==='recorder'||ME.role==='provider'||ME.role==='admin')?L('#register','Register'):''}
  ${L('#antenatal','Antenatal')}
  ${L('#labour','Labour ward')}
  ${L('#highrisk','High risk')}
  ${L('#pnc','Postnatal')}
  ${L('#dashboard','Dashboard')}
  ${L('#registers','Registers')}
  ${ME.role==='admin'?L('#facilities','Facilities'):''}
  ${ME.role==='admin'?L('#users','Users'):''}
  ${ME.role==='admin'?L('#reminders','Reminders'):''}</nav>`;
  const bot=`<nav class="botnav">${B('#home','Home')}${B('#antenatal','ANC')}${B('#labour','Labour')}${B('#pnc','PNC')}${B('#dashboard','Dash')}</nav>`;
  return pbar+top+bot; }

function home(){
  const ec=(window.Ethiopian?Ethiopian.fmt(new Date()):'');
  app().innerHTML=nav()+`<div class="card"><h3>Welcome, ${esc(ME.full_name)}</h3>
   <p class="muted">Role: ${ME.role}${ME.facility_name?' · '+esc(ME.facility_name):''}. ${ec?'Today: <b>'+ec+'</b> ('+new Date().toLocaleDateString()+').':''}</p>
   <p class="muted">Care pathway: Antenatal → Labour ward → High risk → Postnatal. Recorders register women; providers run the partograph, checklist, danger-sign, delivery and PNC; observers can view.</p></div>
   <div class="card"><h3>Change my password</h3>
    <div class="grid">
     <label>Current password<input id="cpw" type="password"></label>
     <label>New password<input id="npw" type="password"></label>
    </div><button class="act" id="chpw" style="margin-top:10px">Update password</button> <span class="muted" id="pwm"></span></div>`;
  $('#chpw').onclick=async()=>{ const r=await api('POST','password',{current:cpw.value,new:npw.value}); if(r&&r.ok){ $('#pwm').textContent=' updated'; cpw.value='';npw.value=''; } else $('#pwm').textContent=' '+((r&&r.error)||'error'); };
}

// ---- MoH register helpers ----------------------------------------------------
// A tick box on the paper register is a boolean. tick() renders it, tk() reads it.
function tick(id,label){ return `<label class="tick"><input type="checkbox" id="${id}"> ${label}</label>`; }
function tk(id){ const el=document.getElementById(id); return (el&&el.checked)?1:0; }

// Targeted population category — the 9-code list (A-I) from the MoH instruction page.
// (The register footer prints a contradictory 7-code list; MoH to confirm.)
const TARGET_POP=[['A','Female commercial sex workers'],['B','Long distance drivers'],['C','Mobile / daily labourers'],
  ['D','Prisoners'],['E','OVC'],['F','Children of PLHIV'],['G','Partners of PLHIV'],['H','Other MARPS'],['I','General population']];
function tpSel(id,label,val){ return `<label>${label}<select id="${id}"><option value="">-</option>`+
  TARGET_POP.map(([c,n])=>`<option value="${c}"${val===c?' selected':''}>${c}. ${n}</option>`).join('')+`</select></label>`; }
function selOpts(list,val){ return `<option value="">-</option>`+list.map(([v,n])=>`<option value="${v}"${String(val)===String(v)?' selected':''}>${n}</option>`).join(''); }

const IPPFP_METHODS=[['POP','POP — progestin-only pill'],['Imp','Implant'],['IUCD','IUCD'],['TL','Tubal ligation'],['Oth','Other']];
const ACCEPTOR=[['new','New acceptor'],['repeat','Repeat acceptor']];

// Ethiopian-calendar date entry: 3 selects (day/month/year E.C.) -> stores Gregorian YYYY-MM-DD
function ecToday(){ return (window.Ethiopian?Ethiopian.toEth(new Date()):{year:2018,month:1,day:1}); }
function ecPicker(id,label,def){ const t=ecToday(); const mons=(window.Ethiopian?Ethiopian.months:[]);
  const days=Array.from({length:30},(_,i)=>i+1); const years=Array.from({length:7},(_,i)=>t.year-4+i);
  return `<label>${label} <span class="muted" style="font-weight:400">(Ethiopian calendar)</span>
   <span style="display:flex;gap:6px;flex-wrap:wrap">
    <select id="${id}_d" style="min-width:80px"><option value="">Day</option>${days.map(d=>`<option${def&&d===t.day?' selected':''}>${d}</option>`).join('')}</select>
    <select id="${id}_m" style="min-width:135px"><option value="">Month</option>${mons.map((m,i)=>`<option value="${i+1}"${def&&(i+1)===t.month?' selected':''}>${m}</option>`).join('')}</select>
    <select id="${id}_y" style="min-width:90px"><option value="">Year</option>${years.map(y=>`<option${y===t.year?' selected':''}>${y}</option>`).join('')}</select>
   </span>
   <span class="muted" style="font-weight:400;font-size:11px">format: Day &middot; Month &middot; Year</span></label>`; }
function ecGet(id){ const d=($('#'+id+'_d')||{}).value, m=($('#'+id+'_m')||{}).value, y=($('#'+id+'_y')||{}).value;
  return (d&&m&&y&&window.Ethiopian)?Ethiopian.toGreg(+y,+m,+d):null; }
function addDays(iso,n){ if(!iso)return null; const dt=new Date(iso+'T00:00:00'); dt.setDate(dt.getDate()+n); return dt.toISOString().slice(0,10); }

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
function ageRisk(n){ n=+n;
  if(n>0&&n<20) return 'Age '+n+' — adolescent pregnancy. This is a high-risk group: she needs specialised ANC, closer monitoring and screening for pre-eclampsia, anaemia and obstructed labour.';
  if(n>=35) return 'Age '+n+' — advanced maternal age. This is a high-risk group: she needs specialised ANC and closer monitoring.';
  return ''; }
// A modal the user must acknowledge — a toast is too easy to miss for a risk flag.
function modal(title,body,kind){ const old=document.getElementById('mdl'); if(old) old.remove();
  const c=(kind==='risk')?'#a32d2d':'#0f766e';
  const d=document.createElement('div'); d.id='mdl';
  d.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px';
  d.innerHTML=`<div style="background:#fff;border-radius:14px;max-width:420px;width:100%;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)">
    <h3 style="margin:0 0 8px;color:${c};font-size:16px">${esc(title)}</h3>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#334155">${esc(body)}</p>
    <button class="act" id="mdlok" style="width:100%">Understood</button></div>`;
  document.body.appendChild(d);
  d.querySelector('#mdlok').onclick=()=>d.remove();
  d.onclick=(e)=>{ if(e.target===d) d.remove(); };
}

async function register(){
  const r=mrnRule();
  app().innerHTML=nav()+`<div class="card"><h3>Register / admit</h3>
   <div class="grid">
    <label>MRN <span class="muted" style="font-weight:400">(${esc(r.label)})</span><input id="mrn" inputmode="numeric" maxlength="${r.max}" placeholder="${'0'.repeat(r.min)}"></label>
    <label>First name<input id="fn"></label>
    <label>Father name<input id="fa"></label><label>Grandfather<input id="gf"></label>
    <label>Age<input id="age" type="number" min="10" max="60"></label>
    <label>Marital status<select id="ms"><option value="married">Married</option><option value="single">Single</option><option value="divorced">Divorced</option><option value="widowed">Widowed</option></select></label>
    <label>Phone<input id="ph" placeholder="09..."></label><label>Kebele<input id="kb"></label>
    <label>Next of kin / husband<input id="nok"></label><label>Kin phone<input id="kph" placeholder="09..."></label>
    <label>Emergency contact address<input id="kad" placeholder="kebele, woreda, landmark"></label>
    <label>Service<select id="cat"><option value="anc">ANC</option><option value="labour" selected>Labour &amp; delivery</option><option value="pnc">PNC</option></select></label>
   </div>
   <div id="riskbox" style="display:none;background:#fcebeb;border:1px solid #f09595;color:#791f1f;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px"></div>

   <details class="moh" open><summary>Obstetric history</summary><div class="grid">
    <label>Gravida<input id="gr" type="number" min="0"></label>
    <label>Para<input id="pa" type="number" min="0"></label>
    <label>Children alive<input id="ca" type="number" min="0"></label>
    <label>Previous pregnancy outcome<select id="ppo">${selOpts([['first','First pregnancy'],['live_birth','Live birth'],['stillbirth','Stillbirth'],['abortion','Abortion / miscarriage'],['neonatal_death','Neonatal death'],['caesarean','Caesarean section']])}</select></label>
   </div>
   <div class="muted" style="font-size:12px;margin-top:6px">Full risk screening (previous C/S, PPH, pre-eclampsia, obstructed labour, chronic conditions) is done by the provider on the ANC screening screen.</div></details>

   <button class="act" id="save" style="margin-top:6px">Register</button> <span class="muted" id="m"></span></div>`;

  const showRisk=()=>{ const b=$('#riskbox'); const msg=ageRisk(age.value);
    if(msg){ b.style.display=''; b.textContent=msg; } else { b.style.display='none'; } };
  let lastWarned=null;
  age.addEventListener('input',showRisk);
  age.addEventListener('blur',()=>{ const e=ageError(age.value); if(e && age.value){ $('#m').textContent=' '+e; return; }
    const msg=ageRisk(age.value);
    if(msg && age.value!==lastWarned){ lastWarned=age.value; modal('High-risk group',msg,'risk'); } });
  mrn.addEventListener('blur',()=>{ const e=mrnError(mrn.value); $('#m').textContent=e?(' '+e):''; });

  $('#save').onclick=async()=>{
    const em=mrnError(mrn.value); if(em){ $('#m').textContent=' '+em; modal('Check the MRN',em); return; }
    const ea=ageError(age.value); if(ea){ $('#m').textContent=' '+ea; modal('Check the age',ea); return; }
    $('#m').textContent=' saving…';
    try{
      const w=await api('POST','women',{mrn:mrn.value.trim(),first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value||null,marital_status:ms.value,phone:ph.value,kebele:kb.value,next_of_kin:nok.value,kin_phone:kph.value,kin_address:(kad.value||null),sms_consent:1,
        gravida:(+gr.value||null),para:(+pa.value||null),children_alive:(+ca.value||null),prev_pregnancy_outcome:(ppo.value||null)});
      const wid=w.id; if(!wid){ $('#m').textContent=' saved (offline queued)'; return; }
      await api('POST','episodes',{woman_id:wid,service_category:cat.value,status:cat.value==='labour'?'laboring':'active',provider_id:ME.role==='provider'?ME.id:null,admission_datetime:new Date().toISOString().slice(0,19).replace('T',' ')});
      $('#m').textContent=' registered'; setTimeout(()=>location.hash='#'+(cat.value==='anc'?'antenatal':cat.value==='pnc'?'pnc':cat.value==='highrisk'?'highrisk':'labour'),600);
    }catch(e){ $('#m').textContent=' '+(e.message||'could not register'); }
  };
}

function provOpts(provs,sel){ return '<option value="">— Not assigned —</option>'+(provs||[]).map(p=>`<option value="${p.id}"${sel==p.id?' selected':''}>${esc(p.full_name)}</option>`).join(''); }
function wireAssign(){ document.querySelectorAll('select.asgn').forEach(s=>{ s.onchange=async()=>{ const r=await api('PATCH','episodes/'+s.dataset.ep,{provider_id:+s.value||null}); if(r&&(r.ok||r.queued)) toast('Provider updated','ok'); }; }); }
async function labour(){
  const [rows,provs]=await Promise.all([api('GET','episodes?category=labour').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>Labour ward</h3><table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}${r.high_risk==1?' <span class="pill amber">Higher risk</span>':''}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No women in labour. Register one.</td></tr>'}
   </table></div>`;
  wireAssign();
}

const OB={}; // per-episode in-memory observations for the chart
async function partograph(id){
  const [obs,eps]=await Promise.all([api('GET','observations?episode='+id).catch(()=>[]),api('GET','episodes').catch(()=>[])]);
  const W=(eps||[]).find(x=>x.id==id)||{}; const MF=motherFeats(W);
  const locked=(String(W.status||'').toLowerCase()==='delivered');
  OB[id]=obs.map(o=>({hrs:+o.hours_since_active,cvx:+o.cervix_cm,fhr:+o.fetal_heart_rate,ctx:+o.contractions_per10,mld:+o.moulding,sbp:+o.bp_systolic,tmp:+o.temperature,dsc:(o.descent_head==null?null:+o.descent_head),amn:o.amniotic_fluid}));
  if(!BTS[id]) BTS[id]=new BayesTracker(0.15);
  app().innerHTML=nav()+`<div class="card"><h3>Partograph — episode ${esc(id)} <span id="band" class="pill"></span></h3>${locked?'<div class="pill amber" style="display:inline-block;margin:0 0 8px">Delivered - partograph is read-only</div>':''}
    <div class="grid">
     <label>Hours active<input id="hrs" type="number" step="0.5" value="1"></label>
     <label>Cervix cm<input id="cvx" type="number" step="0.5" value="5"></label>
     <label>Fetal HR<input id="fhr" type="number" value="140"></label>
     <label>Contractions/10<input id="ctx" type="number" value="3"></label>
     <label>Moulding (0–3)<select id="mld"><option value="0">0</option><option value="1">+1</option><option value="2">+2</option><option value="3">+3</option></select></label>
     <label>Caput<select id="cap"><option value="">Not assessed</option><option value="0">0</option><option value="1">+1</option><option value="2">+2</option><option value="3">+3</option></select></label>
     <label>Descent — fifths palpable<input id="dsc" type="number" min="0" max="5" placeholder="5→0 (optional)"></label>
     <label>Amniotic fluid<select id="amn"><option value="">Not assessed</option><option value="I">Intact</option><option value="C">Clear</option><option value="M">Meconium</option><option value="B">Blood</option><option value="A">Absent</option></select></label>
     <label>Systolic BP<input id="sbp" type="number" value="118"></label>
     <label>Temp °C<input id="tmp" type="number" step="0.1" value="37"></label>
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
    const btn=$('#rec'); btn.disabled=true;                         // guard against double-submit
    try{
    const o={hrs:+hrs.value,cvx:+cvx.value,fhr:+fhr.value,ctx:+ctx.value,mld:+mld.value,sbp:+sbp.value,tmp:+tmp.value,dsc:(dsc.value===''?null:+dsc.value),amn:(amn.value||null)};
    const mld3=Math.max(0,Math.min(3,Math.round(o.mld)||0));
    // Save the observation FIRST — a failed save must never show a misleading chart/score.
    const obsRes=await api('POST','observations',{episode_id:+id,obs_datetime:new Date().toISOString().slice(0,19).replace('T',' '),hours_since_active:o.hrs,cervix_cm:o.cvx,fetal_heart_rate:o.fhr,contractions_per10:o.ctx,moulding:['0','+1','+2','+3'][mld3],caput:(cap.value===''?null:['0','+1','+2','+3'][Math.max(0,Math.min(3,+cap.value||0))]),descent_head:o.dsc,amniotic_fluid:o.amn,bp_systolic:o.sbp,temperature:o.tmp,urine_protein:(uprot.value||null),urine_acetone:(uacet.value||null)});
    OB[id].push(o); OB[id].sort((a,b)=>a.hrs-b.hrs); drawPG(id); drawVitals(id); obs.push({obs_datetime:new Date().toISOString().slice(0,19).replace('T',' ')}); renderMonSched(id,obs);
    const mecon=(o.amn==='M')?1:0;
    const feat=Object.assign({},FEAT_DEFAULTS,MF,{hrs:o.hrs,cvx:o.cvx,cvx_rate:o.hrs>0?(o.cvx-4)/o.hrs:1,fhr:o.fhr,ctx:o.ctx,mld:mld3,meconium:mecon,sbp:o.sbp,dbp:Math.round(o.sbp*0.65),temp:o.tmp});
    const r=RM?RM.predict(feat):{probability:0,band:'green'};
    const cf=clinicalFlags(o); const finalBand=escalate(r.band,cf.band);   // safety guardrail
    $('#ai').style.display='block'; $('#prob').textContent=Math.round(r.probability*100)+'%'; $('#prob').className=finalBand;
    const bd=$('#band'); bd.textContent=finalBand.toUpperCase()+(finalBand!==r.band?' (clinical override)':''); bd.className='pill '+finalBand;
    $('#drv').textContent=(cf.reasons.length?('red-flags: '+cf.reasons.join(', ')):'AI band '+r.band);
    const drv=riskDrivers(o,feat); $('#why').innerHTML=drv.length?('<b>Contributing findings:</b> '+drv.map(esc).join(' &middot; ')):'No abnormal intrapartum findings detected.';
    // Newborn — readiness for resuscitation, from the intrapartum picture
    if(NRM){ const nb=NRM.predict({ga:feat.ga,meconium:mecon,fhr:o.fhr,mld:mld3,cvx:o.cvx,hrs:o.hrs,ctx:o.ctx,sbp:o.sbp,temp:o.tmp,prior_cs:feat.prior_cs,age:feat.age,parity:feat.parity,rom_hours:feat.rom_hours});
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
    $('#hitl').textContent=''; $('#hrs').value=(o.hrs+1);
    toast(scored?('Observation recorded'+(obsRes&&obsRes.queued?' (offline — will sync when online)':'')):'Observation saved. (The AI risk score could not be stored, but the reading is recorded.)', scored?'ok':'');
    }catch(err){ toast('Could not record the observation — '+(err.message||'error')+'. Nothing was saved.'); }
    finally{ $('#rec').disabled=false; }
  };
  $('#ack').onclick=async()=>{ if(lastScoreId[id]){ try{ await api('PATCH','risk_scores/'+lastScoreId[id]); $('#hitl').textContent='acknowledged (saved)'; }catch(e){ $('#hitl').textContent='acknowledged (queued)'; } } else $('#hitl').textContent='record a score first'; };
  $('#ovr').onclick=async()=>{ const la=lastAI[id]||{p:0,band:'green'}; await api('POST','risk_scores',{episode_id:+id,model_version:'override',probability:la.p.toFixed(4),band:la.band,override_reason:'clinician judgement',provider_ack:1}); $('#hitl').textContent='override logged'; };
}
function renderMonSched(id,obs){ const el=$('#monsched'); if(!el) return;
  const last=(obs&&obs.length)?obs[obs.length-1]:null;
  const lt=last?new Date(String(last.obs_datetime||last.recorded_at||'').replace(' ','T')):null;
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
  if(ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const list=await api('GET','facilities').catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>Add a facility</h3>
    <div class="grid">
     <label>Name<input id="fnm" placeholder="Debre Tabor Health Center"></label>
     <label>Type<select id="fty"><option value="health_center">Health center</option><option value="primary_hospital">Primary hospital</option><option value="general_hospital">General hospital</option><option value="other">Other</option></select></label>
     <label>Kebele<input id="fke"></label><label>Woreda<input id="fwo"></label>
     <label>Zone<input id="fzo"></label><label>Region<input id="fre" value="Amhara"></label>
     <label>DHIS2 org-unit code<input id="fdh" placeholder="optional"></label>
    </div><button class="act" id="fadd" style="margin-top:10px">Create facility</button> <span class="muted" id="fm"></span></div>
    <div class="card"><h3>Bulk add facilities (CSV)</h3>
     <p class="muted">Columns (first row = headers): <code>name, facility_type, kebele, woreda, zone, region, dhis2_org_unit</code>. facility_type = health_center / primary_hospital / general_hospital / other.</p>
     <input type="file" id="fcsv" accept=".csv,text/csv"> <button class="sec" id="fcsvbtn">Upload CSV</button> <span class="muted" id="fcsvm"></span></div>
    <div class="card"><h3>Facilities</h3><table><tr><th>ID</th><th>Name</th><th>Type</th><th>Woreda</th><th>Zone</th><th>Region</th><th>DHIS2</th><th></th></tr>
     ${list.map(f=>`<tr><td>${f.id}</td><td>${esc(f.name)}</td><td>${esc(f.facility_type||'')}</td>
       <td>${esc(f.woreda||'')}</td><td>${esc(f.zone||'')}</td><td>${esc(f.region||'')}</td><td>${esc(f.dhis2_org_unit||'')}</td><td><a class="nav" href="#facilityedit/${f.id}">Edit</a> <button class="sec" data-del="${f.id}" data-nm="${esc(f.name)}">Delete</button></td></tr>`).join('')}
     </table><p class="muted">Each user and every patient belongs to a facility. Data is scoped per facility, and the dashboard/DHIS2 export roll up by facility.</p></div>`;
  $('#fadd').onclick=async()=>{ const r=await api('POST','facilities',{name:fnm.value,facility_type:fty.value,kebele:fke.value,woreda:fwo.value,zone:fzo.value,region:fre.value,dhis2_org_unit:fdh.value}); if(r.id){ facilities(); } else $('#fm').textContent=' '+(r.error||'error'); };
  $('#fcsvbtn').onclick=async()=>{ const fl=$('#fcsv').files[0]; if(!fl){ $('#fcsvm').textContent=' choose a CSV file first'; return; } const rows=parseCSV(await fl.text()).filter(r=>r.name); if(!rows.length){ $('#fcsvm').textContent=' no rows with a name found'; return; } $('#fcsvm').textContent=' uploading '+rows.length+'…'; try{ const r=await api('POST','facilities',rows); const n=(r.created||[]).length, e=(r.errors||[]).length; $('#fcsvm').textContent=' added '+n+(e?(', '+e+' skipped'):''); setTimeout(()=>facilities(),1000); }catch(err){ $('#fcsvm').textContent=' '+(err.message||'error'); } };
  document.querySelectorAll('#app button[data-del]').forEach(b=>b.onclick=async()=>{ if(confirm('Delete facility "'+b.dataset.nm+'"? This only works if it has no users or patients.')){ const r=await api('DELETE','facilities/'+b.dataset.del); if(r&&r.ok){ facilities(); } else alert((r&&r.error)||'error'); } });
}

async function users(){
  if(ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const [list,facs]=await Promise.all([api('GET','users').catch(()=>[]),api('GET','facilities').catch(()=>[])]);
  const facName=id=>{ const f=facs.find(x=>x.id==id); return f?f.name:(id||'—'); };
  app().innerHTML=nav()+`<div class="card"><h3>Add a user</h3>
    <div class="grid">
     <label>Username<input id="nu"></label><label>Full name<input id="nn"></label>
     <label>Password<input id="np" type="text"></label>
     <label>Role<select id="nr"><option value="recorder">Recorder</option><option value="provider">Provider</option><option value="observer">Observer</option><option value="supervisor">Supervisor</option><option value="admin">Admin</option></select></label>
     <label>Facility<select id="nf">${facs.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
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

async function dashboard(){
  let d; try{ d=await api('GET','analytics'); }catch(e){ app().innerHTML=nav()+'<div class="card">Could not load dashboard: '+esc(e.message||'error')+'</div>'; return; }
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
    ${block(pgRate,'Partograph completion rate (%)','down')}
    ${block(ckRate,'Safe-birth checklist rate (%)','down')}
    ${block(g('deliveries'),'Deliveries (count)','neutral')}
    ${block(sbRate,'Fresh stillbirths per 1,000 births','up')}
    ${block(g('red_alerts'),'Red AI alerts (count)','up')}`;
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
  app().innerHTML=nav()+`<div class="card"><h3>WHO Safe Childbirth Checklist — episode ${esc(id)}</h3>
    <div class="tabs" id="tabs">${Object.keys(CHK).map((k,i)=>`<button class="${i==0?'on':''}" data-k="${k}">${k.replace('_',' ')}</button>`).join('')}</div>
    <div id="items"></div><button class="act" id="save" style="margin-top:10px">Save pause point</button><span class="muted" id="m"></span></div>`;
  let cur='admission';
  const renderItems=()=>{$('#items').innerHTML=CHK[cur].map((t,i)=>`<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center">${t}
    <select data-i="${i}" style="width:120px"><option value="no">No</option><option value="yes">Yes</option><option value="na">N/A</option></select></label></div>`).join('');};
  renderItems();
  $('#tabs').onclick=e=>{ if(!e.target.dataset.k)return; cur=e.target.dataset.k; [...$('#tabs').children].forEach(b=>b.className=b.dataset.k===cur?'on':''); renderItems(); };
  $('#save').onclick=async()=>{ const rows=[...document.querySelectorAll('#items select')].map((s,i)=>({episode_id:+id,pause_point:cur,item_code:cur+'_'+i,response:s.value})); await api('POST','checklist',rows); $('#m').textContent=' saved'; };
}

async function danger(id){
  app().innerHTML=nav()+`<div class="card"><h3>Warning-sign sheet — episode ${esc(id)}</h3><div class="grid">
   <label>Headache<select id="ha"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Blurred vision<select id="bv"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Epigastric pain<select id="ep"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>DTR/clonus<select id="dtr"><option>+2</option><option>0</option><option>+1</option><option>+3</option><option>+4</option></select></label>
   <label>Vaginal bleeding<select id="vb"><option value="0">No</option><option value="1">Yes</option></select></label>
   <label>Remark<input id="rk"></label></div>
   <button class="act" id="s" style="margin-top:10px">Save</button><span class="muted" id="m"></span></div>`;
  $('#s').onclick=async()=>{ await api('POST','danger_signs',{episode_id:+id,obs_datetime:new Date().toISOString().slice(0,19).replace('T',' '),headache:+ha.value,blurred_vision:+bv.value,epigastric_pain:+ep.value,dtr_grade:dtr.value,vaginal_bleeding:+vb.value,remark:rk.value}); $('#m').textContent=' saved'; };
}

async function delivery(id){
  // MoH item 7 (Partograph used) is derived, not asked: Y only if maternal condition,
  // fetal condition AND progress of labour were all monitored.
  const obs=await api('GET','observations?episode='+id).catch(()=>[]);
  const pUsed=(obs||[]).some(o=>o.fetal_heart_rate) && (obs||[]).some(o=>o.cervix_cm!=null) &&
              (obs||[]).some(o=>o.bp_systolic||o.pulse||o.temperature) ? 'Y' : 'N';
  app().innerHTML=nav()+`<div class="card"><h3>Delivery summary — episode ${esc(id)}</h3><div class="grid">
   <label>Mode<select id="md"><option value="svd">SVD — spontaneous vaginal</option><option value="assisted">Forceps / vacuum assisted</option><option value="caesarean">Caesarean section</option><option value="other">Other</option></select></label>
   <label>If other, specify<input id="mot" placeholder="assisted breech, destructive…"></label>
   <label>Baby weight g<input id="bw" type="number" value="3000"></label>
   <label>Sex<select id="sx"><option value="female">Female</option><option value="male">Male</option></select></label>
   <label>APGAR 1<input id="a1" type="number" value="8"></label><label>APGAR 5<input id="a5" type="number" value="9"></label>
   <label>Outcome<select id="oc"><option value="live_birth">Live birth</option><option value="fresh_stillbirth">Fresh stillbirth</option><option value="macerated_stillbirth">Macerated stillbirth</option><option value="neonatal_death">Died after birth in facility</option></select></label>
   <label>Mother's status<select id="mo"><option value="well">Stable</option><option value="near_miss">Survived a near-miss</option><option value="referred">Unstable / deteriorated — referred</option><option value="death">Died</option></select></label>
   <label id="mdcw" style="display:none">Cause of maternal death<select id="mdc">${selOpts([['1','1. Haemorrhage'],['2','2. Pre-eclampsia / eclampsia'],['3','3. Obstructed labour'],['4','4. Sepsis'],['5','5. Anaemia'],['6','6. Other']])}</select></label>
   <label>Uterotonic within 1 min<select id="ut1"><option value="">-</option><option value="done">Done</option><option value="delayed">Delayed</option><option value="not">Not done</option></select></label>
   <label>Uterotonic type<select id="utt"><option value="">-</option><option value="oxytocin">Oxytocin</option><option value="misoprostol">Misoprostol</option><option value="ergometrine">Ergometrine</option><option value="other">Other</option></select></label>
   <label>Controlled cord traction<select id="cct"><option value="">-</option><option value="done">Done</option><option value="not">Not done</option><option value="noskill">Not done (no skilled attendant)</option></select></label>
   <label>Uterine tone<select id="utn"><option value="">Not assessed</option><option value="firm">Firm</option><option value="atonic">Atonic</option></select></label>
   <label>Massage if atony<select id="umsg"><option value="">-</option><option value="done">Done</option><option value="not_needed">Not needed</option><option value="not">Not done</option></select></label>
   <label>Placenta<select id="plc"><option value="">-</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option><option value="retained">Retained</option></select></label>
   <label>Est. blood loss (ml)<input id="ebl" type="number" placeholder="ml"></label>
   </div>
   <div class="ticks" style="margin-top:8px">${tick('epis','Episiotomy performed')}</div>

   <details class="moh" open><summary>Obstetric complications <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('cpe','Pre-eclampsia')}${tick('cec','Eclampsia')}${tick('cap','APH')}${tick('cpp','PPH')}${tick('cot','Other (obstructed labour, sepsis…)')}${tick('cref','Referred')}
   </div></details>

   <details class="moh"><summary>HIV <span class="muted">&mdash; MoH Delivery register</span></summary><div class="grid">
    <label>HIV test result<select id="dhtr">${selOpts([['P','Positive'],['N','Negative']])}</select></label>
   </div><div class="ticks">${tick('dhta','HIV testing accepted')}${tick('dhrt','HIV re-testing accepted')}${tick('dcfo','Counselled on feeding options')}</div>
   <div class="muted" style="font-size:12px;margin-top:6px">Linkage to PMTCT, ART regimen, target population and partner testing are held on the woman&rsquo;s record.</div></details>

   <details class="moh"><summary>Immediate postpartum family planning (0&ndash;48 hrs)</summary><div class="grid">
    <label>Acceptor type<select id="dacc">${selOpts(ACCEPTOR)}</select></label>
    <label>Method received<select id="dmth">${selOpts(IPPFP_METHODS)}</select></label>
   </div></details>

   <label>Remark<input id="drmk"></label>
   <div class="muted" style="font-size:12px;margin-top:8px">Partograph used (MoH item 7): <b>${pUsed==='Y'?'Yes':'No'}</b> &mdash; derived from the partograph record (maternal + fetal + progress all monitored).</div>
   <button class="act" id="s" style="margin-top:10px">Save &amp; send to PNC</button><span class="muted" id="m"></span></div>`;
  const syncDeath=()=>{ $('#mdcw').style.display=(mo.value==='death')?'':'none'; };
  mo.addEventListener('change',syncDeath); syncDeath();
  const MOH_STATUS={well:'stable',near_miss:'stable',referred:'unstable_referred',death:'died'};
  $('#s').onclick=async()=>{ const btn=$('#s'); btn.disabled=true;
    try{
      await api('POST','delivery',{episode_id:+id,delivery_datetime:new Date().toISOString().slice(0,19).replace('T',' '),mode:md.value,baby_weight_g:+bw.value,baby_sex:sx.value,apgar_1min:+a1.value,apgar_5min:+a5.value,outcome:oc.value,maternal_outcome:mo.value,amtsl_uterotonic:(ut1.value||null),amtsl_uterotonic_type:(utt.value||null),amtsl_cct:(cct.value||null),amtsl_uterine_tone:(utn.value||null),amtsl_massage:(umsg.value||null),amtsl_placenta:(plc.value||null),blood_loss_ml:(+ebl.value||null),
        partograph_used:pUsed,episiotomy:tk('epis'),mode_other_text:(md.value==='other'?mot.value:null),
        maternal_status:MOH_STATUS[mo.value]||null,maternal_death_cause:(mo.value==='death'?(+mdc.value||null):null),
        comp_preeclampsia:tk('cpe'),comp_eclampsia:tk('cec'),comp_aph:tk('cap'),comp_pph:tk('cpp'),comp_other:tk('cot'),referred:tk('cref'),
        hiv_test_accepted:tk('dhta'),hiv_retest_accepted:tk('dhrt'),hiv_test_result:(dhtr.value||null),cnsl_feeding_options:tk('dcfo'),
        ippfp_acceptor:(dacc.value||null),ippfp_method:(dmth.value||null),remark:drmk.value});
      // Newborn record is the source of truth for outcomes/analytics — create baby #1 here if none recorded yet.
      const existing=await api('GET','babies?episode='+id).catch(()=>[]);
      if(!(existing&&existing.length)) await api('POST','babies',{episode_id:+id,birth_order:1,sex:sx.value,weight_g:+bw.value||null,apgar_1min:+a1.value||null,apgar_5min:+a5.value||null,outcome:oc.value,resuscitated:0,prob_lbw:((+bw.value||0)>0&&(+bw.value)<2500)?1:0});
      await api('PATCH','episodes/'+id,{status:'delivered'});
      $('#m').textContent=' saved → PNC'; toast('Delivery recorded','ok'); setTimeout(()=>location.hash='#pnc',700);
    }catch(e){ toast('Could not save delivery — '+(e.message||'error')+'. Not saved.'); }
    finally{ $('#s').disabled=false; } };
  const note=document.createElement('p'); note.className='muted'; note.style.cssText='font-size:12px;margin-top:6px'; note.textContent='For twins/multiples, save this (baby 1), then add the others on the Newborn screen.'; $('#app').querySelector('.card').appendChild(note);
}

async function pnc(){
  const [rows,provs]=await Promise.all([api('GET','episodes?category=labour').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  const del=rows.filter(r=>r.status==='delivered');
  app().innerHTML=nav()+`<div class="card"><h3>Postnatal care</h3>
   <p class="muted">Women after delivery. WHO postnatal contacts: within 24 hours, day 3, day 7, and week 6. Open <b>PNC follow-up</b> to record the mother-and-newborn check.</p>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Provider</th><th>Actions</th></tr>
   ${del.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#pncvisit/${r.id}">PNC follow-up</a> &middot; <a class="nav" href="#baby/${r.id}">Newborn</a> &middot; <a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=5 class=muted>No postnatal women yet.</td></tr>'}
   </table></div>`;
  wireAssign();
}
const ANC_GROUPS={obstetric_history:'Obstetric history',current_pregnancy:'Current pregnancy',general_medical:'General medical'};
const ANC_ITEMS=[
 ['OBS_PREV_STILLBIRTH','obstetric_history','Previous stillbirth or neonatal loss'],
 ['OBS_3_ABORTIONS','obstetric_history','History of 3 or more consecutive spontaneous abortions'],
 ['OBS_BW_LT2500','obstetric_history','Birth weight of last baby < 2500 g'],
 ['OBS_BW_GT4500','obstetric_history','Birth weight of last baby > 4500 g'],
 ['OBS_PREV_PREECLAMPSIA','obstetric_history','Last pregnancy: admitted for pre-eclampsia or eclampsia'],
 ['OBS_PREV_SURGERY','obstetric_history','Previous surgery on the reproductive tract'],
 ['OBS_PREV_PPH','obstetric_history','Previous postpartum haemorrhage (PPH)'],
 ['OBS_PREV_OBSTRUCTED','obstetric_history','Previous obstructed or prolonged labour'],
 ['CUR_MULTIPLE','current_pregnancy','Suspected multiple pregnancy'],
 ['CUR_AGE_LT16','current_pregnancy','Age less than 16 years'],
 ['CUR_AGE_GT40','current_pregnancy','Age more than 40 years'],
 ['CUR_BLEEDING','current_pregnancy','Vaginal bleeding'],
 ['MED_DIABETES','general_medical','Diabetes mellitus'],
 ['MED_CHRONIC_HTN','general_medical','Chronic hypertension'],
 ['MED_OTHER_SEVERE','general_medical','Any other severe medical condition (TB, HIV, cancer, DVT...)']
];
async function ancScreen(id){
  const existing=await api('GET','anc_screening?episode='+id).catch(()=>[]);
  const prev={}; existing.forEach(r=>prev[r.item_code]=r.response);
  const notePrev=prev['PLAN_NOTE']||'';
  let html=nav()+`<div class="card"><h3>ANC risk screening — episode ${esc(id)} <span id="ancband" class="pill"></span></h3>
    <p class="muted">WHO/MCPC risk factors. This is decision support — a "Yes" flags a factor for the clinician's attention; the clinical decision and plan are the provider's.</p>`;
  Object.keys(ANC_GROUPS).forEach(gk=>{ html+=`<h4>${ANC_GROUPS[gk]}</h4>`;
    ANC_ITEMS.filter(it=>it[1]===gk).forEach(it=>{ const v=prev[it[0]]||'no';
      html+=`<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span>${esc(it[2])}</span>
        <select data-code="${it[0]}" data-group="${it[1]}" style="width:132px"><option value="no"${v==='no'?' selected':''}>No</option><option value="yes"${v==='yes'?' selected':''}>Yes</option><option value="unknown"${v==='unknown'?' selected':''}>Unknown</option></select></label></div>`; }); });
  html+=`<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)"><h4>Care plan</h4>
    <label>Notes (clinician's plan)<textarea id="ancnote" rows="3" placeholder="Birth plan, monitoring, referral decision, or any notes...">${esc(notePrev)}</textarea></label></div>`;
  html+=`<button class="act" id="ancsave" style="margin-top:12px">Save screening</button> <span class="muted" id="ancm"></span></div>`;
  app().innerHTML=html;
  const sels=()=>[...document.querySelectorAll('#app select[data-code]')];
  const evalBand=()=>{ const yes=sels().some(s=>s.value==='yes'); const b=$('#ancband');
    b.textContent=yes?'Higher-risk pregnancy':'Routine ANC'; b.className='pill '+(yes?'amber':'green'); };
  sels().forEach(s=>s.onchange=evalBand); evalBand();
  $('#ancsave').onclick=async()=>{ const rows=sels().map(s=>({episode_id:+id,item_code:s.dataset.code,item_group:s.dataset.group,response:s.value}));
    const nv=($('#ancnote').value||'').slice(0,255);
    if(nv) rows.push({episode_id:+id,item_code:'PLAN_NOTE',item_group:'care_plan',response:nv});
    const r=await api('POST','anc_screening',rows); $('#ancm').textContent=(r&&r.ids)?' saved ('+rows.length+' items)':' '+((r&&r.error)||'saved offline'); };
}

async function ancList(){
  const [rows,provs]=await Promise.all([api('GET','episodes?category=anc').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>Antenatal care</h3>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}${r.high_risk==1?' <span class="pill amber">Higher risk</span>':''}</td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a> <button class="sec" data-w="${r.woman_id}" data-to="labour">&rarr; Labour</button></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No antenatal women yet. Register one with service = ANC.</td></tr>'}
   </table><p class="muted">"&rarr; Labour" admits the woman into the labour ward. Higher-risk women are flagged automatically from their ANC screening and gathered under the High risk tab.</p></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_anc'));
  wireAssign();
}

async function highriskList(){
  const [rows,provs]=await Promise.all([api('GET','episodes?flag=highrisk').catch(()=>[]),api('GET','providers').catch(()=>[])]);
  app().innerHTML=nav()+`<div class="card"><h3>High-risk worklist</h3>
   <p class="muted">Women in antenatal care or labour who carry a risk factor &mdash; flagged automatically from their ANC risk screening. A live worklist to help prioritise who to see first; risk is a status, not a separate ward.</p>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Pathway</th><th>Status</th><th>Provider</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.service_category||'')}</td><td>${esc(r.status)} <span class="pill amber">Higher risk</span></td>
    <td><select class="asgn" data-ep="${r.id}" style="max-width:150px">${provOpts(provs,r.provider_id)}</select></td>
    <td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=7 class=muted>No higher-risk women right now. Women are flagged here automatically from their ANC risk screening.</td></tr>'}
   </table></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_highrisk'));
  wireAssign();
}

async function transfer(womanId,cat,from){
  const r=await api('POST','episodes',{woman_id:womanId,service_category:cat,status:cat==='labour'?'laboring':'active',admitted_from:from,provider_id:ME.role==='provider'?ME.id:null,admission_datetime:new Date().toISOString().slice(0,19).replace('T',' ')});
  if(r&&r.id){ location.hash=cat==='labour'?'#labour':(cat==='highrisk'?'#highrisk':'#antenatal'); route(); }
  else alert('Could not admit: '+((r&&r.error)||'error'));
}

// ================= workflow-parity modules =================
const nowStr=()=>new Date().toISOString().slice(0,19).replace('T',' ');
const today=()=>new Date().toISOString().slice(0,10);

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
  $('#rsave').onclick=async()=>{ const det=($('#rdet')||{}).value; const r=await api('POST','referrals',{episode_id:+id,referred_to:rto.value,reason:rrsn.value+(det?(' — '+det):''),urgency:rurg.value,transport:rtr.value});
    if(r&&(r.ids||r.queued)){ try{ await api('PATCH','episodes/'+id,{status:'referred'}); }catch(e){} $('#rm').textContent=' referred'; setTimeout(()=>referralScreen(id),500); } else $('#rm').textContent=' '+((r&&r.error)||'error'); };
}

async function ancVisits(id){
  const past=await api('GET','anc_visits?episode='+id).catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>ANC follow-up visit — episode ${esc(id)}</h3>
   <div class="grid">
    ${ecPicker('vd','Visit date',true)}
    <label>ANC contact<select id="cno"><option value="">-</option><option value="1">1st</option><option value="2">2nd</option><option value="3">3rd</option><option value="4">4th</option><option value="5">5th</option><option value="6">6th</option><option value="7">7th</option><option value="8">8th</option><option value="unscheduled">Unscheduled</option><option value="special">Special</option></select></label>
    <label>GA (weeks)<input id="ga" type="number"></label>
    <label>Weight (kg)<input id="wt" type="number" step="0.1"></label>
    <label>BP systolic<input id="bps" type="number"></label>
    <label>BP diastolic<input id="bpd" type="number"></label>
    <label>Fundal height (cm)<input id="fh" type="number"></label>
    <label>Fetal HR<input id="fhr" type="number"></label>
    <label>Presentation<input id="pres" placeholder="cephalic / breech"></label>
    <label>Urine protein<input id="up" placeholder="nil / +"></label>
    <label>Hgb (g/dl)<input id="hb" type="number" step="0.1"></label>
    <label>MUAC (cm)<input id="muac" type="number" step="0.1"></label>
    <label>Fetal movement<select id="fm"><option value="">Not assessed</option><option value="normal">Normal</option><option value="reduced">Reduced</option><option value="absent">Absent</option></select></label>
    <label>HIV status<select id="hiv"><option value="">Not tested</option><option value="negative">Negative</option><option value="positive">Positive</option><option value="unknown">Unknown</option></select></label>
    <label>Syphilis (RPR)<select id="syph"><option value="">Not done</option><option value="nonreactive">Non-reactive</option><option value="reactive">Reactive</option></select></label>
    <label>Tetanus / Td<select id="tt"><option value="">-</option><option value="TT1">TT1</option><option value="TT2">TT2</option><option value="TT3">TT3</option><option value="TT4">TT4</option><option value="TT5">TT5</option><option value="none">None</option></select></label>
    <label>Iron-folic acid<select id="ifa"><option value="">-</option><option value="given">Given</option><option value="not">Not given</option><option value="declined">Declined</option></select></label>
    <label>Malaria assessed<select id="mal"><option value="">Not assessed</option><option value="no">No symptoms/risk</option><option value="yes">Symptoms/risk - test</option></select></label>
    ${ecPicker('na','Next appointment')}
   </div><label>Danger signs / note<input id="dn"></label>

   <details class="moh" open><summary>Tests &amp; prophylaxis <span class="muted">&mdash; MoH ANC register</span></summary><div class="grid">
    <label>Ultrasound within 24 wks GA<select id="us"><option value="">-</option><option value="Y">Yes</option><option value="N">No</option></select></label>
    <label>Syphilis test result<select id="syr"><option value="">-</option><option value="R">Reactive</option><option value="NR">Non-reactive</option><option value="ND">Not done</option></select></label>
    <label>Hepatitis B test result<select id="hbr"><option value="">-</option><option value="R">Reactive</option><option value="NR">Non-reactive</option><option value="ND">Not done</option></select></label>
    <label>Td dose number<input id="tdn" type="number" min="1" max="5" placeholder="1-5"></label>
    <label>IFA tablets provided<input id="ift" type="number" min="0" placeholder="tablets"></label>
   </div><div class="ticks">
    ${tick('syt','Syphilis treatment given')}${tick('hbt','Hep B treatment given')}${tick('hbp','Hep B prophylaxis given')}${tick('dw','Deworming given (2nd/3rd trimester)')}
   </div></details>

   <details class="moh"><summary>HIV <span class="muted">&mdash; MoH ANC register</span></summary><div class="grid">
    <label>HIV test result<select id="htr"><option value="">-</option><option value="P">Positive</option><option value="N">Negative</option></select></label>
   </div><div class="ticks">
    ${tick('hta','HIV test accepted')}${tick('hpc','Result received with post-test counselling')}
   </div>
   <div class="muted" style="font-size:12px;margin-top:6px">Target population, linkage to PMTCT/ART and partner testing are held once on the woman&rsquo;s record &mdash; edit them from her profile.</div></details>

   <details class="moh"><summary>Counselling provided at this contact <span class="muted">&mdash; MoH ANC register</span></summary><div class="ticks">
    ${tick('c1','Danger signs')}${tick('c2','Maternal nutrition')}${tick('c3','Early childhood development')}${tick('c4','Breast / infant feeding')}${tick('c5','Family planning')}
   </div></details>

   <label>Remark<input id="rmk" placeholder="appointment or anything not covered above"></label>
   <button class="act" id="asave" style="margin-top:10px">Save visit</button> <span class="muted" id="am"></span><div class="muted" id="anccomp" style="margin-top:8px;font-size:12px"></div></div>
   <div class="card"><h3>Previous visits</h3><table><tr><th>Date</th><th>GA</th><th>Wt</th><th>BP</th><th>FH</th><th>FHR</th><th>Next</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.visit_date||'')}</td><td>${esc(p.ga_weeks||'')}</td><td>${esc(p.weight_kg||'')}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.fundal_height_cm||'')}</td><td>${esc(p.fetal_heart_rate||'')}</td><td>${esc(p.next_appointment||'')}</td></tr>`).join('')||'<tr><td colspan=7 class=muted>No visits yet.</td></tr>'}
   </table></div>`;
  const ancRec=['cno','ga','bps','muac','fm','hiv','syph','tt','ifa','up','hb'];
  const updComp=()=>{ let n=0; ancRec.forEach(k=>{const el=$('#'+k); if(el&&el.value&&el.value!=='') n++;}); const c=$('#anccomp'); if(c) c.textContent='ANC package: '+n+' of '+ancRec.length+' recommended items recorded'; };
  ancRec.forEach(k=>{const el=$('#'+k); if(el){ el.addEventListener('input',updComp); el.addEventListener('change',updComp); }}); updComp();
  $('#asave').onclick=async()=>{ const b=$('#asave'); b.disabled=true; try{ const r=await api('POST','anc_visits',{episode_id:+id,visit_date:ecGet('vd'),contact_no:(cno.value||null),ga_weeks:+ga.value||null,weight_kg:+wt.value||null,bp_systolic:+bps.value||null,bp_diastolic:+bpd.value||null,fundal_height_cm:+fh.value||null,fetal_heart_rate:+fhr.value||null,presentation:pres.value,urine_protein:up.value,hgb:+hb.value||null,muac:(+muac.value||null),fetal_movement:(fm.value||null),hiv_status:(hiv.value||null),syphilis:(syph.value||null),tetanus_td:(tt.value||null),iron_folic:(ifa.value||null),malaria_assessed:(mal.value||null),danger_note:dn.value,next_appointment:ecGet('na'),
    ultrasound_lt24w:(us.value||null),syphilis_result:(syr.value||null),syphilis_treated:tk('syt'),hepb_result:(hbr.value||null),hepb_treated:tk('hbt'),hepb_prophylaxis:tk('hbp'),td_dose_no:(+tdn.value||null),ifa_tabs:(+ift.value||null),deworming:tk('dw'),
    hiv_test_accepted:tk('hta'),hiv_test_result:(htr.value||null),hiv_posttest_counselled:tk('hpc'),
    cnsl_danger_signs:tk('c1'),cnsl_nutrition:tk('c2'),cnsl_ecd:tk('c3'),cnsl_infant_feeding:tk('c4'),cnsl_family_planning:tk('c5'),remark:rmk.value});
    $('#am').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>ancVisits(id),500); } finally{ b.disabled=false; } };
}

async function pncVisits(id){
  const [past,delv,bbs]=await Promise.all([api('GET','pnc_visits?episode='+id).catch(()=>[]),api('GET','delivery?episode='+id).catch(()=>[]),api('GET','babies?episode='+id).catch(()=>[])]);
  const dv=(delv&&delv[0])||null;
  app().innerHTML=nav()+`<div class="card"><h3>PNC follow-up visit — episode ${esc(id)}</h3>
   <div style="background:#e9f8f4;border-radius:10px;padding:8px 12px;margin-bottom:10px">
     <b>Delivery report</b> ${dv?('&middot; '+esc(dv.delivery_datetime||'')+' &middot; mode '+esc(dv.mode||'?')+' &middot; outcome '+esc(dv.outcome||'?')+' &middot; mother '+esc(dv.maternal_outcome||'?')):'<span class="muted">no delivery recorded yet</span>'}
     <div style="margin-top:4px"><b>Newborn record(s)</b> ${(bbs&&bbs.length)?bbs.map(b=>('#'+esc(b.birth_order||'?')+' '+esc(b.sex||'')+' '+esc(b.weight_g||'?')+'g Apgar '+esc(b.apgar_1min||'?')+'/'+esc(b.apgar_5min||'?')+' '+esc(b.outcome||''))).join(' &middot; '):'<span class="muted">no newborn record yet</span>'}</div>
   </div>
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
   </div><h4>Newborn</h4><div class="grid">
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
   <button class="act" id="psave" style="margin-top:10px">Save PNC visit</button> <span class="muted" id="pm"></span></div>
   <div class="card"><h3>Previous PNC visits</h3><table><tr><th>Date</th><th>Period</th><th>M temp</th><th>M BP</th><th>Condition</th><th>NB feeding</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.visit_date||'')}</td><td>${esc(p.visit_period||p.pnc_day||'')}</td><td>${esc(p.m_temp||'')}</td><td>${esc((p.m_bp_systolic||'')+'/'+(p.m_bp_diastolic||''))}</td><td>${esc(({'1':'Normal','2':'Complicated, managed','3':'Complicated, referred','4':'Died'})[String(p.maternal_condition||'')]||'')}</td><td>${esc(p.nb_feeding||'')}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No PNC visits yet.</td></tr>'}
   </table></div>`;
  const csv=(pre,codes)=>codes.filter(c=>tk(pre+c)).join(',')||null;   // MoH multi-code fields are comma-separated
  $('#psave').onclick=async()=>{ const b=$('#psave'); b.disabled=true; try{ const r=await api('POST','pnc_visits',{episode_id:+id,visit_date:ecGet('vd'),pnc_day:null,m_temp:+mt.value||null,m_bp_systolic:+bps.value||null,m_bp_diastolic:+bpd.value||null,m_pulse:+pl.value||null,bleeding:bl.value,breast:br.value,mood:md.value,uterine_tone:(ut.value||null),perineum:(pw.value||null),mother_breastfeeding:(mbf.value||null),pp_fp:(ppf.value||null),ifa_continued:(ifc.value||null),nb_temp:+nt.value||null,nb_feeding:nf.value,cord:cd.value,nb_convulsions:(ncv.value||null),nb_fast_breathing:(nfb.value||null),nb_chest_indrawing:(nci.value||null),nb_lethargy:(nlt.value||null),nb_jaundice:(njd.value||null),nb_kmc:(nkmc.value||null),nb_immunization:(nimm.value||null),nb_eid:(neid.value||null),danger_note:dn.value,
    visit_period:(vp.value||null),maternal_condition:(+mc.value||null),pph:tk('ppph'),other_obs_complication:(ooc.value||null),
    hiv_test_accepted:tk('phta'),hiv_retest_accepted:tk('phrt'),hiv_test_result:(phtr.value||null),
    cnsl_danger_signs:tk('pc1'),cnsl_breastfeeding:tk('pc2'),cnsl_newborn_care:tk('pc3'),cnsl_family_planning:tk('pc4'),cnsl_epi:tk('pc5'),cnsl_ecd:tk('pc6'),
    nb_weight_g:(+nwt.value||null),nb_problems:csv('np',[1,2,3,4,5,6,7,8,9,10,11]),nb_problem_other:(npo.value||null),nb_treatment:csv('nt',[1,2,3,4,5,6]),
    nb_treatment_outcome:(+nto.value||null),nb_death_age_days:(+ndd.value||null),nb_death_cause:(+ndc.value||null),
    ippfp_acceptor:(pacc.value||null),ippfp_method:(pmth.value||null),remark:prmk.value});
    $('#pm').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>pncVisits(id),500); } finally{ b.disabled=false; } };
}

async function babiesScreen(id){
  const past=await api('GET','babies?episode='+id).catch(()=>[]);
  const nextOrder=(past.length||0)+1;
  app().innerHTML=nav()+`<div class="card"><h3>Newborn record — episode ${esc(id)}</h3>
   <p class="muted">Add one row per baby (supports twins and multiples).</p>
   <div class="grid">
    <label>Birth order<input id="bo" type="number" value="${nextOrder}"></label>
    <label>Sex<select id="sx"><option value="female">Female</option><option value="male">Male</option><option value="ambiguous">Ambiguous</option></select></label>
    <label>Weight (g)<input id="wg" type="number" value="3000"></label>
    <label>APGAR 1<input id="a1" type="number" value="8"></label>
    <label>APGAR 5<input id="a5" type="number" value="9"></label>
    <label>Resuscitated<select id="rs"><option value="0">No</option><option value="1">Yes</option></select></label>
    <label>Outcome<select id="oc"><option value="live_birth">Live birth</option><option value="fresh_stillbirth">Fresh stillbirth</option><option value="macerated_stillbirth">Macerated stillbirth</option><option value="neonatal_death">Neonatal death</option></select></label>
    <label>Dried &amp; stimulated<select id="dr"><option value="">-</option><option value="done">Done</option><option value="not">Not done</option></select></label>
    <label>Breathing at birth<select id="brb"><option value="">-</option><option value="normal">Normal</option><option value="stimulation">Needed stimulation</option><option value="resus">Needed resuscitation</option></select></label>
    <label>Vitamin K<select id="vk"><option value="">-</option><option value="given">Given</option><option value="not">Not given</option></select></label>
    <label>Eye ointment (TTC)<select id="eo"><option value="">-</option><option value="given">Given</option><option value="not">Not given</option></select></label>
    <label>Cord care<select id="cc"><option value="">-</option><option value="chlorhexidine">Chlorhexidine</option><option value="dry">Dry</option><option value="other">Other</option></select></label>
    <label>Newborn ARV (HIV-exposed)<select id="arv"><option value="">N/A</option><option value="given">Given</option><option value="not">Not given</option></select></label>
    <label>Newborn MRN<input id="nmrn" placeholder="infant's MRN"></label>
    <label>Breastfeeding initiated<select id="bfi">${selOpts([['1','1. Within 1 hour'],['2','2. 1-2 hours'],['3','3. After 3 hours'],['4','4. Not at all'],['5','5. Other milk']])}</select></label>
   </div>

   <details class="moh" open><summary>Vaccinated at birth <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('vbcg','BCG')}${tick('vopv','OPV 0')}${tick('vhbv','HBV')}
   </div></details>

   <details class="moh" open><summary>Newborn problems identified <span class="muted">&mdash; MoH Delivery register</span></summary><div class="ticks">
    ${tick('bpre','Prematurity')}${tick('bsep','Sepsis / VSD')}${tick('brds','Respiratory distress / asphyxia')}${tick('bcon','Congenital malformation')}${tick('both','Other')}
   </div>
   <label>If other, specify<input id="bpot"></label>
   <div class="muted" style="font-size:12px;margin-top:6px">Low birth weight is derived automatically from the weight (&lt;2500 g).</div></details>

   <details class="moh"><summary>Outcome &amp; notification</summary><div class="ticks">
    ${tick('brsv','Resuscitated and survived')}${tick('bnot','Birth notification given to mother')}
   </div><div class="grid" style="margin-top:8px">
    <label>If died — age (days)<input id="bdd" type="number"></label>
    <label>If died — age (hours)<input id="bdh" type="number"></label>
    <label>If died — cause<select id="bdc">${selOpts([['1','1. Prematurity'],['2','2. Infection'],['3','3. Asphyxia'],['4','4. Other']])}</select></label>
   </div></details>

   <button class="act" id="bsave" style="margin-top:10px">Add baby</button> <span class="muted" id="bm"></span></div>
   <div class="card"><h3>Babies</h3><table><tr><th>#</th><th>Sex</th><th>Weight</th><th>APGAR</th><th>Resus</th><th>Outcome</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.birth_order||'')}</td><td>${esc(p.sex||'')}</td><td>${esc(p.weight_g||'')}</td><td>${esc((p.apgar_1min||'')+'/'+(p.apgar_5min||''))}</td><td>${p.resuscitated==1?'yes':'no'}</td><td>${esc(p.outcome||'')}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No babies recorded yet.</td></tr>'}
   </table></div>`;
  $('#bsave').onclick=async()=>{ const b=$('#bsave'); b.disabled=true; try{ const r=await api('POST','babies',{episode_id:+id,birth_order:+bo.value||1,sex:sx.value,weight_g:+wg.value||null,apgar_1min:+a1.value||null,apgar_5min:+a5.value||null,resuscitated:+rs.value,outcome:oc.value,enc_dried:(dr.value||null),enc_breathing:(brb.value||null),enc_vitamin_k:(vk.value||null),enc_eye_ointment:(eo.value||null),enc_cord_care:(cc.value||null),enc_arv:(arv.value||null),
    mrn:(nmrn.value||null),breastfeed_initiated:(+bfi.value||null),
    vacc_bcg:tk('vbcg'),vacc_opv0:tk('vopv'),vacc_hbv:tk('vhbv'),
    prob_prematurity:tk('bpre'),prob_sepsis_vsd:tk('bsep'),prob_resp_distress:tk('brds'),prob_congenital:tk('bcon'),prob_other:tk('both'),prob_other_text:(bpot.value||null),
    prob_lbw:((+wg.value||0)>0&&(+wg.value)<2500)?1:0,   // MoH item 55 — derived, never asked
    resuscitated_survived:tk('brsv'),birth_notification:tk('bnot'),
    death_age_days:(+bdd.value||null),death_age_hours:(+bdh.value||null),death_cause:(+bdc.value||null)});
    $('#bm').textContent=(r&&(r.ids||r.queued))?' added':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>babiesScreen(id),400); } finally{ b.disabled=false; } };
}

async function vitalsScreen(id){
  const past=await api('GET','maternal_vitals?episode='+id).catch(()=>[]);
  const hist=past.map(p=>{ const ms=meowsScore({sbp:p.bp_systolic,dbp:p.bp_diastolic,pulse:p.pulse,temp:p.temperature,rr:p.resp_rate,spo2:p.spo2}); return `<tr><td>${esc((p.obs_datetime||p.recorded_at||'').slice(0,16))}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.pulse||'')}</td><td>${esc(p.temperature||'')}</td><td>${esc(p.resp_rate||'')}</td><td>${esc(p.spo2||'')}</td><td><span class="pill ${ms.band}">${ms.total}</span></td></tr>`; }).join('')||'<tr><td colspan=7 class=muted>No vitals yet.</td></tr>';
  app().innerHTML=nav()+`<div class="card"><h3>Maternal vital signs — episode ${esc(id)}</h3>
   <div class="grid">
    <label>BP systolic<input id="bps" type="number" value="120"></label>
    <label>BP diastolic<input id="bpd" type="number" value="80"></label>
    <label>Pulse<input id="pl" type="number" value="80"></label>
    <label>Temp °C<input id="tp" type="number" step="0.1" value="37"></label>
    <label>Resp rate<input id="rr" type="number" value="18"></label>
    <label>SpO2 %<input id="sp" type="number" value="98"></label>
   </div><label>Note<input id="ntt"></label>
   <div id="meows" style="margin-top:10px"></div>
   <button class="act" id="vsave" style="margin-top:10px">Record vitals</button> <span class="muted" id="vm"></span></div>
   <div class="card"><h3>Vitals history</h3><table><tr><th>When</th><th>BP</th><th>Pulse</th><th>Temp</th><th>RR</th><th>SpO2</th><th>MEOWS</th></tr>
    ${hist}
   </table></div>`;
  const showMeows=()=>{ const ms=meowsScore({sbp:bps.value,dbp:bpd.value,pulse:pl.value,temp:tp.value,rr:rr.value,spo2:sp.value});
    const act=ms.band==='red'?'urgent review — escalate now':(ms.band==='amber'?'increase monitoring, review':'continue routine monitoring');
    $('#meows').innerHTML='<div style="border-top:0.5px solid #eee;padding-top:8px"><b class="muted">MEOWS early-warning</b> <span class="pill '+ms.band+'">score '+ms.total+'</span> <span class="muted">'+esc(act)+'</span>'+(ms.parts.length?('<div class="muted" style="font-size:12px;margin-top:3px">Triggers: '+ms.parts.map(x=>esc(x.label)+' (+'+x.pts+')').join(' &middot; ')+'</div>'):'')+'</div>'; };
  ['bps','bpd','pl','tp','rr','sp'].forEach(x=>{ const e=$('#'+x); if(e) e.oninput=showMeows; }); showMeows();
  $('#vsave').onclick=async()=>{ const b=$('#vsave'); b.disabled=true; try{ const r=await api('POST','maternal_vitals',{episode_id:+id,obs_datetime:nowStr(),bp_systolic:+bps.value||null,bp_diastolic:+bpd.value||null,pulse:+pl.value||null,temperature:+tp.value||null,resp_rate:+rr.value||null,spo2:+sp.value||null,note:ntt.value});
    $('#vm').textContent=(r&&(r.ids||r.queued))?' recorded':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>vitalsScreen(id),400); } finally{ b.disabled=false; } };
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
  $('#hsave').onclick=async()=>{ const to=document.getElementById('hto')?+hto.value:null; const r=await api('POST','handover',{episode_id:+id,from_provider_id:ME.id,to_provider_id:to,note:hn.value});
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
    <label>Height (cm)<input id="ht" type="number" value="${esc(w.height_cm||'')}"></label>
    <label>Woreda<input id="wo" value="${esc(w.woreda||'')}"></label>
    ${ecPicker('lnmp','Last menstrual period')}
   </div>

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
  $('#wsave').onclick=async()=>{ const _ln=ecGet('lnmp'); const r=await api('PATCH','women/'+wid,{first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value||null,phone:ph.value,kebele:kb.value,gravida:+gr.value||null,para:+pa.value||null,height_cm:(+ht.value||null),lnmp:(_ln||null),edd:(_ln?addDays(_ln,280):null),
    woreda:(wo.value||null),target_pop_code:(tp.value||null),hiv_known_positive:tk('hkp'),hiv_linked_pmtct:tk('lpm'),hiv_linked_pmtct_facility:(+lpf.value||null),hiv_linked_art:tk('lar'),art_regimen:(artr.value||null),
    partner_hiv_accepted:tk('pha'),partner_hiv_result:(phr.value||null),partner_target_pop_code:(ptp.value||null),partner_linked_art:tk('pla')});
    $('#wm').textContent=(r&&(r.ok||r.queued))?' saved':' '+((r&&r.error)||'error'); };
}

// ---- MoH paper-register export ----------------------------------------------
// Renders the official ANC / Delivery / PNC register from captured data, so the
// facility can print it instead of hand-writing it. Columns follow the MoH item order.
const REG_COLS={
  anc:[['S.N',(r,i)=>i+1],['MRN','mrn'],['Name',r=>((r.first_name||'')+' '+(r.father_name||'')).trim()],['Kebele','kebele'],
    ['Age','age'],['LNMP','lnmp'],['EDD','edd'],['Contact','contact_no'],['Date','visit_date'],['GA','ga_weeks'],
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
    ['NB MRN','mrn_baby'],['Vit K','enc_vitamin_k'],['TTC','enc_eye_ointment'],['Chlorhex','enc_cord_care'],
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
    ['IPPFP','ippfp_acceptor'],['Method','ippfp_method'],['Remark','remark']]
};
function tickCell(k){ return r=>(r[k]==1?'✓':''); }   // renders a boolean as the paper's tick

async function registersScreen(){
  const t=window._regType||'anc';
  const from=window._regFrom||new Date().toISOString().slice(0,8)+'01';
  const to=window._regTo||new Date().toISOString().slice(0,10);
  const opt=(v,n)=>`<option value="${v}"${t===v?' selected':''}>${n}</option>`;
  app().innerHTML=nav()+`<div class="card">
   <h3>MoH register export</h3>
   <p class="muted">The official Ethiopian MoH register, generated from what has been recorded. Print it, or export to CSV. Person-level items (target population, HIV linkage, partner testing) are filled in automatically on every row.</p>
   <div class="grid">
    <label>Register<select id="rt">${opt('anc','3. Antenatal care (ANC)')}${opt('delivery','4. Delivery')}${opt('pnc','5. Postnatal care (PNC)')}</select></label>
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
    $('#regout').innerHTML=`<div class="card"><h3>${esc(({anc:'ANC register',delivery:'Delivery register',pnc:'PNC register'})[d.type])}</h3>
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

async function reportScreen(id){
  const [ep,obs,chk,deliv,babies,anc,pnc,refs]=await Promise.all([
    api('GET','episodes').catch(()=>[]), api('GET','observations?episode='+id).catch(()=>[]),
    api('GET','checklist?episode='+id).catch(()=>[]), api('GET','delivery?episode='+id).catch(()=>[]),
    api('GET','babies?episode='+id).catch(()=>[]), api('GET','anc_screening?episode='+id).catch(()=>[]),
    api('GET','pnc_visits?episode='+id).catch(()=>[]), api('GET','referrals?episode='+id).catch(()=>[])]);
  const e=(ep||[]).find(x=>x.id==id)||{}; const d=(deliv||[])[0]||{}; const last=obs[obs.length-1]||{};
  const ancYes=(anc||[]).filter(a=>a.response==='yes').length;
  app().innerHTML=nav()+`<div class="card"><h3>Care summary — episode ${esc(id)}</h3>
   <p><b>${esc((e.first_name||'')+' '+(e.father_name||''))}</b> · MRN ${esc(e.mrn||'')} · G${esc(e.gravida||'?')}/P${esc(e.para||'?')} · ${esc(e.service_category||'')} · status ${esc(e.status||'')}</p>
   <p class="muted">Admitted ${esc((e.admission_datetime||'').slice(0,16))}${e.admitted_from&&e.admitted_from!=='new'?(' ('+esc(e.admitted_from)+')'):''}</p>
   <h4>Partograph</h4><p class="muted">${obs.length} observation(s). Last: cervix ${esc(last.cervix_cm||'—')} cm, FHR ${esc(last.fetal_heart_rate||'—')}, hrs ${esc(last.hours_since_active||'—')}.</p>
   <h4>ANC screening</h4><p class="muted">${anc.length?(ancYes?(ancYes+' risk factor(s) → specialised care'):'no risk factors → basic ANC'):'not screened'}</p>
   <h4>Safe-birth checklist</h4><p class="muted">${chk.length} item(s) recorded.</p>
   <h4>Delivery</h4><p class="muted">${d.delivery_datetime?('Mode '+esc(d.mode||'')+', outcome '+esc(d.outcome||'')+', mother '+esc(d.maternal_outcome||'')):'not delivered'}</p>
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
  $('#bsave').onclick=async()=>{ const rows=[...document.querySelectorAll('#app select[data-code]')].map(s=>({episode_id:+id,item_code:s.dataset.code,response:s.value}));
    const r=await api('POST','bemonc',rows); $('#bm').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error'); };
}

async function facilityEdit(id){
  if(ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
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
  const eps=await api('GET','episodes').catch(()=>[]);
  const e=(eps||[]).find(x=>x.id==id)||{}; const cat=e.service_category;
  const delivered=(String(e.status||'')==='delivered'); const isLab=(cat==='labour'||cat==='highrisk'); const postnatal=(cat==='pnc'||(isLab&&delivered));
  const tile=(href,txt)=>`<a class="hubx" href="${href}">${txt}</a>`;
  let tiles, fold='';
  if(ME.role==='observer') tiles=[tile('#report/'+id,'Care summary')];   // read-only role: view the summary, no data-entry screens
  else if(cat==='anc') tiles=[tile('#anc/'+id,'ANC screening'),tile('#ancvisit/'+id,'Follow-up visit'),tile('#vitals/'+id,'Vital signs'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary'),tile('#editwoman/'+e.woman_id,'Edit details')];
  else if(postnatal){ tiles=[tile('#pncvisit/'+id,'PNC follow-up'),tile('#baby/'+id,'Newborn'),tile('#vitals/'+id,'Vital signs'),tile('#danger/'+id,'Danger signs'),tile('#editwoman/'+e.woman_id,'Obstetric details'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary')];
    if(isLab&&delivered){ const lab=[tile('#partograph/'+id,'Partograph &amp; AI'),tile('#delivery/'+id,'Delivery'),tile('#checklist/'+id,'Safe-birth checklist'),tile('#bemonc/'+id,'Emergency care (BEmONC)'),tile('#handover/'+id,'Handover')];
      fold=`<details style="margin-top:10px;border:0.5px solid #e6eae8;border-radius:10px"><summary style="cursor:pointer;padding:10px 12px;font-size:13px;color:#334155">Labour &amp; delivery record <span class="muted">&mdash; for review</span></summary><div class="hubgrid" style="padding:0 12px 12px">${lab.join('')}</div></details>`; } }
  else tiles=[tile('#partograph/'+id,'Partograph &amp; AI'),tile('#vitals/'+id,'Vital signs'),tile('#checklist/'+id,'Safe-birth checklist'),tile('#danger/'+id,'Danger signs'),tile('#delivery/'+id,'Delivery'),tile('#baby/'+id,'Newborn'),tile('#bemonc/'+id,'Emergency care (BEmONC)'),tile('#handover/'+id,'Handover'),tile('#editwoman/'+e.woman_id,'Obstetric details'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary')];
  const _nm=((e.first_name||'')+' '+(e.father_name||'')).trim();
  const _ini=(_nm.split(/\s+/).map(s=>s[0]||'').join('').slice(0,2)||'—').toUpperCase();
  let _ga=''; if(e.edd){ const _d=(new Date(e.edd+'T00:00:00')-new Date())/86400000; const _w=Math.round((280-_d)/7); if(_w>0&&_w<=45) _ga=_w+' wga'; }
  window.CTX={id:+id, ini:_ini, name:_nm||('Episode '+id), meta:['MRN '+(e.mrn||''),'G'+(e.gravida||'?')+'/P'+(e.para||'?'),_ga,e.status].filter(Boolean).join(' · ')};
  app().innerHTML=nav()+`<div class="card"><h3>${esc((e.first_name||'')+' '+(e.father_name||''))||('Episode '+esc(id))}</h3>
    <p class="muted">MRN ${esc(e.mrn||'')} &middot; G${esc(e.gravida||'?')}/P${esc(e.para||'?')} &middot; ${esc(cat||'')} &middot; ${esc(e.status||'')}${e.admitted_from&&e.admitted_from!=='new'?(' &middot; admitted from '+esc(e.admitted_from)):''}</p>
    ${(isLab&&!delivered)?`<p class="muted" style="margin:2px 0 8px">Membranes: <select id="rmset"><option value="0">Intact</option><option value="1">Ruptured</option></select></p>`:''}
    <div class="hubgrid">${tiles.join('')}</div>${fold}</div>`;
  if(isLab&&!delivered){ const rs=$('#rmset'); if(rs){ rs.value=String(e.ruptured_membrane||0); rs.onchange=async()=>{ const r=await api('PATCH','episodes/'+id,{ruptured_membrane:+rs.value}); if(r&&(r.ok||r.queued)) toast('Membranes updated','ok'); }; } }
}

async function supervisorDash(){
  if(ME.role!=='supervisor'&&ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Supervisors only.</div>'; return; }
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
  if(ME.role!=='supervisor'&&ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Admins &amp; supervisors only.</div>'; return; }
  const list=await api('GET','reminders').catch(()=>[]);
  const pill=s=>s==='sent'?'green':s==='pending'?'amber':s==='failed'?'red':'';
  const rowsHtml=(list||[]).map(r=>`<tr><td>${esc((r.created_at||'').slice(0,16))}</td><td>${esc(((r.first_name||'')+' '+(r.father_name||'')).trim())}</td><td>${esc(r.kind||'')}</td><td>${esc(r.due_date||'')}</td><td>${esc(r.phone||'')}</td><td><span class="pill ${pill(r.status)}">${esc(r.status||'')}</span>${r.provider_note?(' <span class="muted" style="font-size:11px">'+esc(r.provider_note)+'</span>'):''}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No reminders yet. Add ANC follow-up visits with a next-appointment date, capture SMS consent, then run the scheduler.</td></tr>';
  app().innerHTML=nav()+`<div class="card"><h3>SMS reminders</h3>
   <p class="muted">ANC follow-up reminders (Amharic) for women who gave SMS consent and have a phone on file. Sending runs on a schedule; you can also run it now. Actual delivery goes through the configured SMS gateway.</p>
   ${ME.role==='admin'?'<button class="act" id="rrun">Generate &amp; send due reminders</button> <span class="muted" id="rmsg"></span>':''}</div>
   <div class="card"><h3>Recent reminders</h3><table><tr><th>Created</th><th>Woman</th><th>Type</th><th>Due</th><th>Phone</th><th>Status</th></tr>${rowsHtml}</table></div>`;
  const b=$('#rrun'); if(b) b.onclick=async()=>{ $('#rmsg').textContent=' running…'; try{ const r=await api('POST','reminders/run'); $('#rmsg').textContent=' generated '+r.generated+', sent '+r.sent+', skipped '+r.skipped+(r.failed?(', failed '+r.failed):''); setTimeout(()=>remindersScreen(),1000); }catch(e){ $('#rmsg').textContent=' '+(e.message||'error'); } };
}

if('serviceWorker' in navigator){ navigator.serviceWorker.register('./service-worker.js').catch(()=>{}); }
boot();
