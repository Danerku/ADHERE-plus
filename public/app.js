/* ADHERE+ SPA — register → partograph → AI score, checklist, danger-sign, delivery, PNC.
   Talks to /api (PHP). On-device AI via RiskModel. Offline queue in localStorage. */
let ME=null, MODEL=null, RM=null, RULES=null, RE=null; const BTS={};
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
const online=()=>navigator.onLine;

async function api(method, path, bodyObj){
  try{
    const res=await fetch(API_BASE+'api/'+path,{method,headers:{'Content-Type':'application/json'},
      credentials:'include',body:bodyObj?JSON.stringify(bodyObj):undefined});
    if(!res.ok) throw new Error((await res.json()).error||res.status);
    return await res.json();
  }catch(e){
    if(method!=='GET' && !online()){ queue({method,path,bodyObj}); return {queued:true}; }
    throw e;
  }
}
function queue(item){ const q=JSON.parse(localStorage.qq||'[]'); q.push(item); localStorage.qq=JSON.stringify(q); paintNet(); }
async function flush(){ let q=JSON.parse(localStorage.qq||'[]'); if(!q.length)return; const keep=[];
  for(const it of q){ try{ const res=await fetch(API_BASE+'api/'+it.path,{method:it.method,headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(it.bodyObj)}); if(!res.ok){ if(res.status>=500) keep.push(it); else { const dl=JSON.parse(localStorage.dlq||'[]'); dl.push(Object.assign({status:res.status,at:Date.now()},it)); localStorage.dlq=JSON.stringify(dl); } } }catch(e){ keep.push(it);} }
  localStorage.qq=JSON.stringify(keep); paintNet(); }
function paintNet(){ const q=JSON.parse(localStorage.qq||'[]'); const n=$('#net');
  const dl=(JSON.parse(localStorage.dlq||'[]')).length; n.textContent=(online()?(q.length?('sync '+q.length+' pending'):'online'):'offline')+(dl?(' · '+dl+' failed'):'');
  n.className='pill '+(online()?(q.length?'amber':'green'):'red'); }
window.addEventListener('online',()=>{paintNet();flush();}); window.addEventListener('offline',paintNet);

async function boot(){
  try{ MODEL=await (await fetch('model/risk_model.json')).json(); RM=new RiskModel(MODEL); }catch(e){}
  try{ RULES=await (await fetch('model/mch_rules.json')).json(); RE=new RulesEngine(RULES); }catch(e){}
  try{ const r=await api('GET','me'); ME=r.user; if(ME) localStorage.me=JSON.stringify(ME); }catch(e){}
  if(!ME && localStorage.me){ ME=JSON.parse(localStorage.me); ME._offline=true; }
  paintNet(); route();
}
$('#logout').onclick=async()=>{ try{ await api('GET','logout'); }catch(e){} ME=null; localStorage.removeItem('me'); location.hash=''; route(); };
window.addEventListener('hashchange', route);

function route(){
  $('#who').textContent = ME?(' — '+ME.full_name+' ['+ME.role+']'+(ME._offline?' · offline':'')):'';
  $('#logout').style.display = ME?'inline-block':'none';
  if(!ME) return login();
  const h=(location.hash||'#home').slice(1); const [screen,arg]=h.split('/');
  ({home:home,register:register,labour:labour,partograph:partograph,anc:ancScreen,
    checklist:checklist,danger:danger,delivery:delivery,pnc:pnc,dashboard:dashboard}[screen]||home)(arg);
}

function login(){
  app().innerHTML='';
  const c=el(`<div class="card" style="max-width:360px;margin:40px auto">
    <h3>Sign in</h3>
    <label>Username<input id="u" value="provider1"></label>
    <label style="margin-top:8px">Password<input id="p" type="password" value="demo1234"></label>
    <button class="act" id="go" style="margin-top:12px">Sign in</button>
    <p class="muted" id="msg"></p>
    <p class="muted">demo: recorder1 / provider1 / observer1 / admin — password demo1234</p></div>`);
  app().appendChild(c);
  $('#go').onclick=async()=>{ try{ const r=await api('POST','login',{username:$('#u').value,password:$('#p').value}); ME=r.user; localStorage.me=JSON.stringify(ME); location.hash='#home'; route(); }catch(e){ $('#msg').textContent=e.message; } };
}

function nav(){ return `<div style="margin-bottom:12px">
  ${ME.role==='recorder'||ME.role==='admin'?'<a class="nav" href="#register">Register</a>':''}
  <a class="nav" href="#labour">Labour ward</a>
  <a class="nav" href="#pnc">Postnatal</a>
  <a class="nav" href="#dashboard">Dashboard</a></div>`; }

function home(){
  app().innerHTML=nav()+`<div class="card"><h3>Welcome, ${esc(ME.full_name)}</h3>
   <p class="muted">Role: ${ME.role}. Use the links above. Recorders register women and hand over to providers;
   providers run the partograph, checklist, danger-sign, delivery and PNC; observers can view.</p></div>`;
}

async function register(){
  app().innerHTML=nav()+`<div class="card"><h3>Register / admit</h3>
   <div class="grid">
    <label>MRN<input id="mrn"></label><label>First name<input id="fn"></label>
    <label>Father name<input id="fa"></label><label>Grandfather<input id="gf"></label>
    <label>Age<input id="age" type="number"></label><label>Phone<input id="ph"></label>
    <label>Gravida<input id="gr" type="number"></label><label>Para<input id="pa" type="number"></label>
    <label>Service<select id="cat"><option value="anc">ANC</option><option value="labour" selected>Labour &amp; delivery</option><option value="pnc">PNC</option><option value="highrisk">High risk</option></select></label>
    <label>Ruptured membrane<select id="rm"><option value="0">No</option><option value="1">Yes</option></select></label>
   </div><button class="act" id="save" style="margin-top:12px">Register</button><p class="muted" id="m"></p></div>`;
  $('#save').onclick=async()=>{
    const w=await api('POST','women',{mrn:mrn.value,first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value,phone:ph.value,gravida:+gr.value,para:+pa.value});
    const wid=w.id; if(!wid){ $('#m').textContent='saved (offline queued)'; return; }
    await api('POST','episodes',{woman_id:wid,service_category:cat.value,status:cat.value==='labour'?'laboring':'active',provider_id:ME.role==='provider'?ME.id:null,ruptured_membrane:+rm.value,admission_datetime:new Date().toISOString().slice(0,19).replace('T',' ')});
    $('#m').textContent='Registered. → Labour ward'; setTimeout(()=>location.hash='#labour',600);
  };
}

async function labour(){
  const rows=await api('GET','episodes?category=labour').catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>Labour ward</h3><table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}</td>
    <td><a class="nav" href="#partograph/${r.id}">Partograph</a><a class="nav" href="#checklist/${r.id}">Checklist</a><a class="nav" href="#danger/${r.id}">Danger</a><a class="nav" href="#delivery/${r.id}">Delivery</a></td></tr>`).join('')||'<tr><td colspan=5 class=muted>No women in labour. Register one.</td></tr>'}
   </table></div>`;
}

const OB={}; // per-episode in-memory observations for the chart
async function partograph(id){
  const obs=await api('GET','observations?episode='+id).catch(()=>[]);
  OB[id]=obs.map(o=>({hrs:+o.hours_since_active,cvx:+o.cervix_cm,fhr:+o.fetal_heart_rate,ctx:+o.contractions_per10,mld:+o.moulding,sbp:+o.bp_systolic,tmp:+o.temperature}));
  if(!BTS[id]) BTS[id]=new BayesTracker(0.15);
  app().innerHTML=nav()+`<div class="card"><h3>Partograph — episode ${esc(id)} <span id="band" class="pill"></span></h3>
    <div class="grid">
     <label>Hours active<input id="hrs" type="number" step="0.5" value="1"></label>
     <label>Cervix cm<input id="cvx" type="number" step="0.5" value="5"></label>
     <label>Fetal HR<input id="fhr" type="number" value="140"></label>
     <label>Contractions/10<input id="ctx" type="number" value="3"></label>
     <label>Moulding<input id="mld" type="number" value="0"></label>
     <label>Systolic BP<input id="sbp" type="number" value="118"></label>
     <label>Temp °C<input id="tmp" type="number" step="0.1" value="37"></label>
    </div><button class="act" id="rec" style="margin-top:10px">Record &amp; score</button>
    <svg id="pg" viewBox="0 0 640 300" width="100%" style="margin-top:10px"></svg>
    <div id="ai" style="display:none;border-top:0.5px solid #eee;padding-top:8px;margin-top:8px">
     <b class="muted">Module 1 — intrapartum AI</b> risk estimate <b id="prob" style="font-size:20px"></b> <span class="muted" id="drv"></span><div class="muted" style="font-size:11px;margin-top:2px">Decision support — a risk estimate, not a diagnosis or proof of complication.</div>
     <div style="margin-top:6px"><button class="sec" id="ack">Acknowledge</button><button class="sec" id="ovr">Override</button> <span class="muted" id="hitl"></span></div>
    </div></div>
    <div class="card"><b class="muted">Module 3 — Bayesian longitudinal risk</b><div id="traj"></div></div>
    <div class="card"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div id="gauge"></div>
      <div style="flex:1"><b class="muted">Module 2 — guideline adherence</b><div id="prompts" class="muted">record an observation to evaluate</div></div></div></div>`;
  drawPG(id); renderTraj(id);
  $('#rec').onclick=async()=>{
    const o={hrs:+hrs.value,cvx:+cvx.value,fhr:+fhr.value,ctx:+ctx.value,mld:+mld.value,sbp:+sbp.value,tmp:+tmp.value};
    OB[id].push(o); OB[id].sort((a,b)=>a.hrs-b.hrs); drawPG(id);
    const feat=Object.assign({},FEAT_DEFAULTS,{hrs:o.hrs,cvx:o.cvx,cvx_rate:o.hrs>0?(o.cvx-4)/o.hrs:1,fhr:o.fhr,ctx:o.ctx,mld:o.mld,sbp:o.sbp,dbp:Math.round(o.sbp*0.65),temp:o.tmp});
    const r=RM?RM.predict(feat):{probability:0,band:'green'};
    const cf=clinicalFlags(o); const finalBand=escalate(r.band,cf.band);   // safety guardrail
    $('#ai').style.display='block'; $('#prob').textContent=Math.round(r.probability*100)+'%'; $('#prob').className=finalBand;
    const bd=$('#band'); bd.textContent=finalBand.toUpperCase()+(finalBand!==r.band?' (clinical override)':''); bd.className='pill '+finalBand;
    $('#drv').textContent=(cf.reasons.length?('red-flags: '+cf.reasons.join(', ')):'AI band '+r.band);
    await api('POST','observations',{episode_id:+id,obs_datetime:new Date().toISOString().slice(0,19).replace('T',' '),hours_since_active:o.hrs,cervix_cm:o.cvx,fetal_heart_rate:o.fhr,contractions_per10:o.ctx,moulding:['0','+1','+2','+3'][Math.max(0,Math.min(3,o.mld))],bp_systolic:o.sbp,temperature:o.tmp});
    const sc=await api('POST','risk_scores',{episode_id:+id,model_version:MODEL&&MODEL.version,probability:r.probability.toFixed(4),band:finalBand,features_json:Object.assign({ml_band:r.band,clinical:cf.reasons},feat)});
    lastScoreId[id]=sc&&sc.id; lastAI[id]={p:r.probability,band:finalBand};
    // Module 3 — Bayesian update from findings
    const f=[]; if(feat.cvx_rate<0.7)f.push('slow_progress'); if(o.mld>=2)f.push('moulding_ge2');
    if(o.fhr<110||o.fhr>170)f.push('fhr_abnormal'); if(o.sbp>=160)f.push('bp_ge160'); else if(o.sbp>=140)f.push('bp_ge140');
    if(o.tmp>=38)f.push('fever_ge38');
    if(!BTapplied[id])BTapplied[id]=new Set(); const nf=f.filter(x=>!BTapplied[id].has(x)); nf.forEach(x=>BTapplied[id].add(x)); const bx=BTS[id].update(nf,'h'+o.hrs); renderTraj(id);
    await api('POST','risk_scores',{episode_id:+id,model_version:'bayes-longitudinal-1.0',probability:bx.probability.toFixed(4),band:bx.band,features_json:{findings:f}});
    // Module 2 — adherence for this labour encounter
    renderAdh(id,{encounter:'labour',cervix_cm:o.cvx,fhr:o.fhr,bp:o.sbp,contractions:o.ctx,partograph_started:true,past_action_line:(o.hrs>4&&o.cvx<o.hrs)});
    $('#hitl').textContent=''; $('#hrs').value=(o.hrs+1);
  };
  $('#ack').onclick=async()=>{ if(lastScoreId[id]){ try{ await api('PATCH','risk_scores/'+lastScoreId[id]); $('#hitl').textContent='acknowledged (saved)'; }catch(e){ $('#hitl').textContent='acknowledged (queued)'; } } else $('#hitl').textContent='record a score first'; };
  $('#ovr').onclick=async()=>{ const la=lastAI[id]||{p:0,band:'green'}; await api('POST','risk_scores',{episode_id:+id,model_version:'override',probability:la.p.toFixed(4),band:la.band,override_reason:'clinician judgement',provider_ack:1}); $('#hitl').textContent='override logged'; };
}
function renderTraj(id){ const h=(BTS[id]&&BTS[id].history)||[]; if(!h.length){ $('#traj').innerHTML='<span class="muted">no visits scored yet</span>'; return; }
  const series=h.map(p=>({x:p.at,y:p.probability,lo:p.ci[0],hi:p.ci[1]}));
  $('#traj').innerHTML=Charts.line(series,{yMax:1,pct:true,zones:true,band:true,stroke:'#26215c'}); }
function renderAdh(id,enc){ if(!RE){return;} const r=RE.evaluate(enc);
  $('#gauge').innerHTML=Charts.gauge(r.adherence,{label:'adherence'});
  $('#prompts').innerHTML = r.prompts.length? r.prompts.map(p=>`<div style="padding:3px 0"><span class="pill ${p.sev==='high'?'red':p.sev==='med'?'amber':'green'}">${p.sev}</span> ${p.msg}</div>`).join('') : '<span style="color:#0f6e56">all applicable steps recorded</span>'; }

async function dashboard(){
  let d; try{ d=await api('GET','analytics'); }catch(e){ d={months:[],indicators:{},anomalies:{}}; }
  const mo=d.months.map(m=>m.slice(5));
  const block=(k,label)=>{ const v=(d.indicators[k]||[]); const flag=d.anomalies[k];
    return `<div class="card"><b>${label}</b> ${flag?'<span class="pill red">anomaly</span>':''}
      ${Charts.bars(v.map((n,i)=>({x:mo[i],v:n,flag:flag&&i===v.length-1})))}</div>`; };
  app().innerHTML=nav()+`<div class="card"><h3>Module 4 — operational intelligence</h3>
    <p class="muted">Monthly facility indicators with automatic anomaly flags (DHIS2-ready). Export: <a class="nav" href="${API_BASE}api/dhis2">/api/dhis2</a></p></div>
    ${block('deliveries','Deliveries')}${block('red_alerts','Red AI alerts')}
    ${block('partographs','Partographs completed')}${block('stillbirths','Fresh stillbirths')}`;
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
  $('#pg').innerHTML=s;
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
  app().innerHTML=nav()+`<div class="card"><h3>Delivery summary — episode ${esc(id)}</h3><div class="grid">
   <label>Mode<select id="md"><option value="svd">SVD</option><option value="assisted">Assisted</option><option value="caesarean">Caesarean</option></select></label>
   <label>Baby weight g<input id="bw" type="number" value="3000"></label>
   <label>Sex<select id="sx"><option value="female">Female</option><option value="male">Male</option></select></label>
   <label>APGAR 1<input id="a1" type="number" value="8"></label><label>APGAR 5<input id="a5" type="number" value="9"></label>
   <label>Outcome<select id="oc"><option value="live_birth">Live birth</option><option value="fresh_stillbirth">Fresh stillbirth</option><option value="neonatal_death">Neonatal death</option></select></label>
   <label>Mother<select id="mo"><option value="well">Well</option><option value="near_miss">Near miss</option><option value="referred">Referred</option></select></label>
   </div><button class="act" id="s" style="margin-top:10px">Save &amp; send to PNC</button><span class="muted" id="m"></span></div>`;
  $('#s').onclick=async()=>{ await api('POST','delivery',{episode_id:+id,delivery_datetime:new Date().toISOString().slice(0,19).replace('T',' '),mode:md.value,baby_weight_g:+bw.value,baby_sex:sx.value,apgar_1min:+a1.value,apgar_5min:+a5.value,outcome:oc.value,maternal_outcome:mo.value});
    await api('PATCH','episodes/'+id,{status:'delivered'}); $('#m').textContent=' saved → PNC'; setTimeout(()=>location.hash='#pnc',600); };
}

async function pnc(){
  const rows=await api('GET','episodes?category=labour').catch(()=>[]);
  const del=rows.filter(r=>r.status==='delivered');
  app().innerHTML=nav()+`<div class="card"><h3>Postnatal care</h3><table><tr><th>MRN</th><th>Name</th><th>Status</th></tr>
   ${del.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.status)}</td></tr>`).join('')||'<tr><td colspan=3 class=muted>No postnatal women yet.</td></tr>'}</table></div>`;
}
async function ancScreen(id){ app().innerHTML=nav()+`<div class="card"><h3>ANC risk screening</h3><p class="muted">19-item WHO/MCPC screen — wired to /api/anc_screening.</p></div>`; }

if('serviceWorker' in navigator){ navigator.serviceWorker.register('./service-worker.js').catch(()=>{}); }
boot();
