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
  $('#who').textContent = ME?(' — '+ME.full_name+' ['+ME.role+']'+(ME.facility_name?' · '+ME.facility_name:'')+(ME._offline?' · offline':'')):'';
  $('#logout').style.display = ME?'inline-block':'none';
  if(!ME) return login();
  const h=(location.hash||'#home').slice(1); const [screen,arg]=h.split('/');
  ({home:home,register:register,antenatal:ancList,labour:labour,highrisk:highriskList,partograph:partograph,anc:ancScreen,
    checklist:checklist,danger:danger,delivery:delivery,pnc:pnc,dashboard:dashboard,users:users,facilities:facilities,
    referral:referralScreen,ancvisit:ancVisits,pncvisit:pncVisits,baby:babiesScreen,handover:handoverScreen,vitals:vitalsScreen,report:reportScreen,editwoman:editWoman,patient:patientHub}[screen]||home)(arg);
}

function login(){
  app().innerHTML='';
  const c=el(`<div class="card" style="max-width:360px;margin:48px auto">
    <h3 style="justify-content:center">Sign in</h3>
    <p class="muted" style="text-align:center;margin-top:-6px">ADHERE+ Maternal &amp; Newborn Care</p>
    <label>Username<input id="u" autocomplete="username" autofocus></label>
    <label style="margin-top:8px">Password<input id="p" type="password" autocomplete="current-password"></label>
    <button class="act" id="go" style="margin-top:14px;width:100%">Sign in</button>
    <p class="muted" id="msg" style="text-align:center"></p></div>`);
  app().appendChild(c);
  $('#go').onclick=async()=>{ try{ const r=await api('POST','login',{username:$('#u').value,password:$('#p').value}); ME=r.user; localStorage.me=JSON.stringify(ME); location.hash='#home'; route(); }catch(e){ $('#msg').textContent=e.message; } };
}

function nav(){ const h=(location.hash||'#home').split('/')[0]; const on=x=>h===x?' on':'';
  const L=(href,txt)=>`<a class="nav${on(href)}" href="${href}">${txt}</a>`;
  return `<nav class="navbar">
  ${ME.role==='recorder'||ME.role==='admin'?L('#register','Register'):''}
  ${L('#antenatal','Antenatal')}
  ${L('#labour','Labour ward')}
  ${L('#highrisk','High risk')}
  ${L('#pnc','Postnatal')}
  ${L('#dashboard','Dashboard')}
  ${ME.role==='admin'?L('#facilities','Facilities'):''}
  ${ME.role==='admin'?L('#users','Users'):''}</nav>`; }

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
    <td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=5 class=muted>No women in labour. Register one.</td></tr>'}
   </table></div>`;
}

const OB={}; // per-episode in-memory observations for the chart
async function partograph(id){
  const obs=await api('GET','observations?episode='+id).catch(()=>[]);
  OB[id]=obs.map(o=>({hrs:+o.hours_since_active,cvx:+o.cervix_cm,fhr:+o.fetal_heart_rate,ctx:+o.contractions_per10,mld:+o.moulding,sbp:+o.bp_systolic,tmp:+o.temperature,dsc:(o.descent_head==null?null:+o.descent_head),amn:o.amniotic_fluid}));
  if(!BTS[id]) BTS[id]=new BayesTracker(0.15);
  app().innerHTML=nav()+`<div class="card"><h3>Partograph — episode ${esc(id)} <span id="band" class="pill"></span></h3>
    <div class="grid">
     <label>Hours active<input id="hrs" type="number" step="0.5" value="1"></label>
     <label>Cervix cm<input id="cvx" type="number" step="0.5" value="5"></label>
     <label>Fetal HR<input id="fhr" type="number" value="140"></label>
     <label>Contractions/10<input id="ctx" type="number" value="3"></label>
     <label>Moulding<input id="mld" type="number" value="0"></label>
     <label>Descent — fifths palpable<input id="dsc" type="number" min="0" max="5" placeholder="5→0 (optional)"></label>
     <label>Amniotic fluid<select id="amn"><option value="">Not assessed</option><option value="I">Intact</option><option value="C">Clear</option><option value="M">Meconium</option><option value="B">Blood</option><option value="A">Absent</option></select></label>
     <label>Systolic BP<input id="sbp" type="number" value="118"></label>
     <label>Temp °C<input id="tmp" type="number" step="0.1" value="37"></label>
    </div><button class="act" id="rec" style="margin-top:10px">Record &amp; score</button>
    <svg id="pg" viewBox="0 0 640 300" width="100%" style="margin-top:10px"></svg>
    <div class="muted" style="font-size:12px">Cervicograph — X = cervical dilatation, O = descent (fifths palpable), with alert &amp; action lines.</div>
    <svg id="pgv" viewBox="0 0 640 220" width="100%" style="margin-top:8px"></svg>
    <div class="muted" style="font-size:12px">Fetal heart rate (normal band 110–160 bpm) and contractions per 10 min.</div>
    <div id="ai" style="display:none;border-top:0.5px solid #eee;padding-top:8px;margin-top:8px">
     <b class="muted">Intrapartum risk (AI)</b> estimate <b id="prob" style="font-size:20px"></b> <span class="muted" id="drv"></span><div class="muted" style="font-size:11px;margin-top:2px">Clinical decision support — an aid to the provider's judgement, not a diagnosis.</div>
     <div style="margin-top:6px"><button class="sec" id="ack">Acknowledge</button><button class="sec" id="ovr">Override</button> <span class="muted" id="hitl"></span></div>
    </div></div>
    <div class="card"><b class="muted">Risk trajectory</b><div id="traj"></div></div>
    <div class="card"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div id="gauge"></div>
      <div style="flex:1"><b class="muted">Guideline adherence</b><div id="prompts" class="muted">record an observation to evaluate</div></div></div></div>`;
  drawPG(id); drawVitals(id); renderTraj(id);
  $('#rec').onclick=async()=>{
    const o={hrs:+hrs.value,cvx:+cvx.value,fhr:+fhr.value,ctx:+ctx.value,mld:+mld.value,sbp:+sbp.value,tmp:+tmp.value,dsc:(dsc.value===''?null:+dsc.value),amn:(amn.value||null)};
    OB[id].push(o); OB[id].sort((a,b)=>a.hrs-b.hrs); drawPG(id); drawVitals(id);
    const feat=Object.assign({},FEAT_DEFAULTS,{hrs:o.hrs,cvx:o.cvx,cvx_rate:o.hrs>0?(o.cvx-4)/o.hrs:1,fhr:o.fhr,ctx:o.ctx,mld:o.mld,sbp:o.sbp,dbp:Math.round(o.sbp*0.65),temp:o.tmp});
    const r=RM?RM.predict(feat):{probability:0,band:'green'};
    const cf=clinicalFlags(o); const finalBand=escalate(r.band,cf.band);   // safety guardrail
    $('#ai').style.display='block'; $('#prob').textContent=Math.round(r.probability*100)+'%'; $('#prob').className=finalBand;
    const bd=$('#band'); bd.textContent=finalBand.toUpperCase()+(finalBand!==r.band?' (clinical override)':''); bd.className='pill '+finalBand;
    $('#drv').textContent=(cf.reasons.length?('red-flags: '+cf.reasons.join(', ')):'AI band '+r.band);
    await api('POST','observations',{episode_id:+id,obs_datetime:new Date().toISOString().slice(0,19).replace('T',' '),hours_since_active:o.hrs,cervix_cm:o.cvx,fetal_heart_rate:o.fhr,contractions_per10:o.ctx,moulding:['0','+1','+2','+3'][Math.max(0,Math.min(3,o.mld))],descent_head:o.dsc,amniotic_fluid:o.amn,bp_systolic:o.sbp,temperature:o.tmp});
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
    <div class="card"><h3>Facilities</h3><table><tr><th>ID</th><th>Name</th><th>Type</th><th>Woreda</th><th>Zone</th><th>Region</th><th>DHIS2</th></tr>
     ${list.map(f=>`<tr><td>${f.id}</td><td>${esc(f.name)}</td><td>${esc(f.facility_type||'')}</td>
       <td>${esc(f.woreda||'')}</td><td>${esc(f.zone||'')}</td><td>${esc(f.region||'')}</td><td>${esc(f.dhis2_org_unit||'')}</td></tr>`).join('')}
     </table><p class="muted">Each user and every patient belongs to a facility. Data is scoped per facility, and the dashboard/DHIS2 export roll up by facility.</p></div>`;
  $('#fadd').onclick=async()=>{ const r=await api('POST','facilities',{name:fnm.value,facility_type:fty.value,kebele:fke.value,woreda:fwo.value,zone:fzo.value,region:fre.value,dhis2_org_unit:fdh.value}); if(r.id){ facilities(); } else $('#fm').textContent=' '+(r.error||'error'); };
}

async function users(){
  if(ME.role!=='admin'){ app().innerHTML=nav()+'<div class="card">Admins only.</div>'; return; }
  const [list,facs]=await Promise.all([api('GET','users').catch(()=>[]),api('GET','facilities').catch(()=>[])]);
  const facName=id=>{ const f=facs.find(x=>x.id==id); return f?f.name:(id||'—'); };
  app().innerHTML=nav()+`<div class="card"><h3>Add a user</h3>
    <div class="grid">
     <label>Username<input id="nu"></label><label>Full name<input id="nn"></label>
     <label>Password<input id="np" type="text"></label>
     <label>Role<select id="nr"><option value="recorder">Recorder</option><option value="provider">Provider</option><option value="observer">Observer</option><option value="admin">Admin</option></select></label>
     <label>Facility<select id="nf">${facs.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
     <label>Cadre<input id="nc" placeholder="midwife / health officer / IESO"></label>
    </div><button class="act" id="add" style="margin-top:10px">Create user</button> <span class="muted" id="m"></span>
    ${facs.length?'':'<p class="muted">No facilities yet — add one on the Facilities screen first.</p>'}</div>
    <div class="card"><h3>Users</h3><table><tr><th>Username</th><th>Name</th><th>Role</th><th>Facility</th><th>Active</th><th>Actions</th></tr>
     ${list.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td>
       <td>${esc(String(facName(u.facility_id)))}</td>
       <td>${u.is_active==1?'<span style="color:#0f6e56">yes</span>':'<span style="color:#a32d2d">no</span>'}</td>
       <td><button class="sec" data-act="toggle" data-id="${u.id}" data-a="${u.is_active}">${u.is_active==1?'Deactivate':'Activate'}</button>
           <button class="sec" data-act="pw" data-id="${u.id}">Reset password</button></td></tr>`).join('')}
     </table><p class="muted">Deactivating disables login but keeps the audit trail (safer than deleting).</p></div>`;
  $('#add').onclick=async()=>{ const r=await api('POST','users',{username:nu.value,full_name:nn.value,password:np.value,role:nr.value,cadre:nc.value,facility_id:document.getElementById('nf')?nf.value:null}); if(r.id){ users(); } else $('#m').textContent=' '+(r.error||'error'); };
  document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{ const id=b.dataset.id;
    if(b.dataset.act==='toggle'){ await api('PATCH','users/'+id,{is_active:b.dataset.a=='1'?0:1}); users(); }
    else { const pw=prompt('New password for this user:'); if(pw){ await api('PATCH','users/'+id,{password:pw}); alert('Password reset.'); } } });
}

async function dashboard(){
  let d; try{ d=await api('GET','analytics'); }catch(e){ d={months:[],indicators:{},anomalies:{}}; }
  const mo=d.months.map(m=>m.slice(5));
  const block=(k,label)=>{ const v=(d.indicators[k]||[]); const flag=d.anomalies[k];
    return `<div class="card"><b>${label}</b> ${flag?'<span class="pill red">anomaly</span>':''}
      ${Charts.bars(v.map((n,i)=>({x:mo[i],v:n,flag:flag&&i===v.length-1})))}</div>`; };
  app().innerHTML=nav()+`<div class="card"><h3>Facility dashboard</h3>
    <p class="muted">Monthly indicators with automatic anomaly flags. Export: <a class="nav" href="${API_BASE}api/dhis2">DHIS2</a></p></div>
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
  app().innerHTML=nav()+`<div class="card"><h3>Postnatal care</h3><table><tr><th>MRN</th><th>Name</th><th>Status</th><th>Actions</th></tr>
   ${del.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.status)}</td><td><a class="nav" href="#patient/${r.id}">Open</a></td></tr>`).join('')||'<tr><td colspan=4 class=muted>No postnatal women yet.</td></tr>'}</table></div>`;
}
const ANC_GROUPS={obstetric_history:'Obstetric history',current_pregnancy:'Current pregnancy',general_medical:'General medical'};
const ANC_ITEMS=[
 ['OBS_PREV_STILLBIRTH','obstetric_history','Previous stillbirth or neonatal loss'],
 ['OBS_3_ABORTIONS','obstetric_history','History of 3 or more consecutive spontaneous abortions'],
 ['OBS_BW_LT2500','obstetric_history','Birth weight of last baby < 2500 g'],
 ['OBS_BW_GT4500','obstetric_history','Birth weight of last baby > 4500 g'],
 ['OBS_PREV_PREECLAMPSIA','obstetric_history','Last pregnancy: admitted for pre-eclampsia or eclampsia'],
 ['OBS_PREV_SURGERY','obstetric_history','Previous surgery on the reproductive tract'],
 ['CUR_MULTIPLE','current_pregnancy','Diagnosed or suspected multiple pregnancy'],
 ['CUR_AGE_LT16','current_pregnancy','Age less than 16 years'],
 ['CUR_AGE_GT40','current_pregnancy','Age more than 40 years'],
 ['CUR_RH_ISO','current_pregnancy','Rh (-) isoimmunisation in current or previous pregnancy'],
 ['CUR_BLEEDING','current_pregnancy','Vaginal bleeding'],
 ['CUR_PELVIC_MASS','current_pregnancy','Pelvic mass'],
 ['CUR_DBP_GE90','current_pregnancy','Diastolic blood pressure 90 mmHg or more at booking'],
 ['MED_DIABETES','general_medical','Diabetes mellitus'],
 ['MED_RENAL','general_medical','Renal disease'],
 ['MED_CARDIAC','general_medical','Cardiac disease'],
 ['MED_CHRONIC_HTN','general_medical','Chronic hypertension'],
 ['MED_OTHER_SEVERE','general_medical','Any other severe medical condition (TB, HIV, cancer, DVT...)']
];
async function ancScreen(id){
  const existing=await api('GET','anc_screening?episode='+id).catch(()=>[]);
  const prev={}; existing.forEach(r=>prev[r.item_code]=r.response);
  let html=nav()+`<div class="card"><h3>ANC risk screening — episode ${esc(id)} <span id="ancband" class="pill"></span></h3>
    <p class="muted">WHO/MCPC classifying form. Any "Yes" means the woman needs specialised (hospital) care rather than basic ANC.</p>`;
  Object.keys(ANC_GROUPS).forEach(gk=>{ html+=`<h4>${ANC_GROUPS[gk]}</h4>`;
    ANC_ITEMS.filter(it=>it[1]===gk).forEach(it=>{ const v=prev[it[0]]||'no';
      html+=`<div style="padding:6px 0;border-bottom:0.5px solid #eee"><label style="display:flex;justify-content:space-between;align-items:center;gap:10px">${esc(it[2])}
        <select data-code="${it[0]}" data-group="${it[1]}" style="width:132px"><option value="no"${v==='no'?' selected':''}>No</option><option value="yes"${v==='yes'?' selected':''}>Yes</option><option value="unknown"${v==='unknown'?' selected':''}>Unknown</option></select></label></div>`; }); });
  html+=`<button class="act" id="ancsave" style="margin-top:12px">Save screening</button> <span class="muted" id="ancm"></span></div>`;
  app().innerHTML=html;
  const sels=()=>[...document.querySelectorAll('#app select[data-code]')];
  const evalBand=()=>{ const yes=sels().some(s=>s.value==='yes'); const b=$('#ancband'); b.textContent=yes?'Specialised care needed':'Basic ANC'; b.className='pill '+(yes?'red':'green'); };
  sels().forEach(s=>s.onchange=evalBand); evalBand();
  $('#ancsave').onclick=async()=>{ const rows=sels().map(s=>({episode_id:+id,item_code:s.dataset.code,item_group:s.dataset.group,response:s.value}));
    const r=await api('POST','anc_screening',rows); $('#ancm').textContent=(r&&r.ids)?' saved ('+rows.length+' items)':' '+((r&&r.error)||'saved offline'); };
}

async function ancList(){
  const rows=await api('GET','episodes?category=anc').catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>Antenatal care</h3>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>Status</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.status)}</td>
    <td><a class="nav" href="#patient/${r.id}">Open</a> <button class="sec" data-w="${r.woman_id}" data-to="labour">&rarr; Labour</button> <button class="sec" data-w="${r.woman_id}" data-to="highrisk">&rarr; High risk</button></td></tr>`).join('')||'<tr><td colspan=5 class=muted>No antenatal women yet. Register one with service = ANC.</td></tr>'}
   </table><p class="muted">"&rarr; Labour / High risk" admits the woman into that stream (recorded as an admission from ANC).</p></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_anc'));
}

async function highriskList(){
  const rows=await api('GET','episodes?category=highrisk').catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>High-risk &amp; latent care</h3>
   <p class="muted">Women admitted to close monitoring (high-risk pregnancy or latent-phase labour). The AI risk score on the partograph helps prioritise who to see first.</p>
   <table><tr><th>MRN</th><th>Name</th><th>G/P</th><th>From</th><th>Status</th><th>Actions</th></tr>
   ${rows.map(r=>`<tr><td>${esc(r.mrn)}</td><td>${esc(r.first_name)} ${esc(r.father_name)}</td><td>${esc(r.gravida)}/${esc(r.para)}</td><td>${esc(r.admitted_from||'new')}</td><td>${esc(r.status)}</td>
    <td><a class="nav" href="#patient/${r.id}">Open</a> <button class="sec" data-w="${r.woman_id}" data-to="labour">&rarr; Labour</button></td></tr>`).join('')||'<tr><td colspan=6 class=muted>No high-risk women. Admit from Antenatal, or Register with service = High risk.</td></tr>'}
   </table></div>`;
  document.querySelectorAll('#app button[data-to]').forEach(b=>b.onclick=()=>transfer(+b.dataset.w,b.dataset.to,'from_highrisk'));
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
    <label>Reason<input id="rrsn" placeholder="e.g. obstructed labour"></label>
   </div><button class="act" id="rsave" style="margin-top:10px">Save referral</button> <span class="muted" id="rm"></span></div>
   <div class="card"><h3>Referral history</h3><table><tr><th>When</th><th>To</th><th>Urgency</th><th>Reason</th></tr>
    ${past.map(p=>`<tr><td>${esc((p.recorded_at||'').slice(0,16))}</td><td>${esc(p.referred_to||'')}</td><td>${esc(p.urgency||'')}</td><td>${esc(p.reason||'')}</td></tr>`).join('')||'<tr><td colspan=4 class=muted>No referrals yet.</td></tr>'}
   </table></div>`;
  $('#rsave').onclick=async()=>{ const r=await api('POST','referrals',{episode_id:+id,referred_to:rto.value,reason:rrsn.value,urgency:rurg.value,transport:rtr.value});
    if(r&&(r.ids||r.queued)){ try{ await api('PATCH','episodes/'+id,{status:'referred'}); }catch(e){} $('#rm').textContent=' referred'; setTimeout(()=>referralScreen(id),500); } else $('#rm').textContent=' '+((r&&r.error)||'error'); };
}

async function ancVisits(id){
  const past=await api('GET','anc_visits?episode='+id).catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>ANC follow-up visit — episode ${esc(id)}</h3>
   <div class="grid">
    <label>Visit date<input id="vd" type="date" value="${today()}"></label>
    <label>GA (weeks)<input id="ga" type="number"></label>
    <label>Weight (kg)<input id="wt" type="number" step="0.1"></label>
    <label>BP systolic<input id="bps" type="number"></label>
    <label>BP diastolic<input id="bpd" type="number"></label>
    <label>Fundal height (cm)<input id="fh" type="number"></label>
    <label>Fetal HR<input id="fhr" type="number"></label>
    <label>Presentation<input id="pres" placeholder="cephalic / breech"></label>
    <label>Urine protein<input id="up" placeholder="nil / +"></label>
    <label>Hgb (g/dl)<input id="hb" type="number" step="0.1"></label>
    <label>Next appointment<input id="na" type="date"></label>
   </div><label>Danger signs / note<input id="dn"></label>
   <button class="act" id="asave" style="margin-top:10px">Save visit</button> <span class="muted" id="am"></span></div>
   <div class="card"><h3>Previous visits</h3><table><tr><th>Date</th><th>GA</th><th>Wt</th><th>BP</th><th>FH</th><th>FHR</th><th>Next</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.visit_date||'')}</td><td>${esc(p.ga_weeks||'')}</td><td>${esc(p.weight_kg||'')}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.fundal_height_cm||'')}</td><td>${esc(p.fetal_heart_rate||'')}</td><td>${esc(p.next_appointment||'')}</td></tr>`).join('')||'<tr><td colspan=7 class=muted>No visits yet.</td></tr>'}
   </table></div>`;
  $('#asave').onclick=async()=>{ const r=await api('POST','anc_visits',{episode_id:+id,visit_date:vd.value||null,ga_weeks:+ga.value||null,weight_kg:+wt.value||null,bp_systolic:+bps.value||null,bp_diastolic:+bpd.value||null,fundal_height_cm:+fh.value||null,fetal_heart_rate:+fhr.value||null,presentation:pres.value,urine_protein:up.value,hgb:+hb.value||null,danger_note:dn.value,next_appointment:na.value||null});
    $('#am').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>ancVisits(id),500); };
}

async function pncVisits(id){
  const past=await api('GET','pnc_visits?episode='+id).catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>PNC follow-up visit — episode ${esc(id)}</h3>
   <h4>Mother</h4><div class="grid">
    <label>Visit date<input id="vd" type="date" value="${today()}"></label>
    <label>PNC day<input id="pd" type="number" placeholder="1 / 3 / 7 / 42"></label>
    <label>Temp °C<input id="mt" type="number" step="0.1"></label>
    <label>BP systolic<input id="bps" type="number"></label>
    <label>BP diastolic<input id="bpd" type="number"></label>
    <label>Pulse<input id="pl" type="number"></label>
    <label>Lochia<select id="bl"><option value="normal">Normal</option><option value="heavy">Heavy</option><option value="offensive">Offensive / foul-smelling</option></select></label>
    <label>Breasts<select id="br"><option value="normal">Normal</option><option value="engorged">Engorged</option><option value="cracked">Cracked nipples</option><option value="mastitis">Mastitis</option></select></label>
    <label>Mood<select id="md"><option value="normal">Normal</option><option value="low">Low mood</option><option value="support">Needs support</option></select></label>
   </div><h4>Newborn</h4><div class="grid">
    <label>Temp °C<input id="nt" type="number" step="0.1"></label>
    <label>Breastfeeding<select id="nf"><option value="well">Feeding well</option><option value="difficulty">Difficulty</option><option value="none">Not feeding</option></select></label>
    <label>Cord<select id="cd"><option value="clean">Clean &amp; dry</option><option value="infected">Red / discharging</option><option value="bleeding">Bleeding</option></select></label>
   </div><label>Danger signs / note<input id="dn"></label>
   <button class="act" id="psave" style="margin-top:10px">Save PNC visit</button> <span class="muted" id="pm"></span></div>
   <div class="card"><h3>Previous PNC visits</h3><table><tr><th>Date</th><th>Day</th><th>M temp</th><th>M BP</th><th>Bleeding</th><th>NB feeding</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.visit_date||'')}</td><td>${esc(p.pnc_day||'')}</td><td>${esc(p.m_temp||'')}</td><td>${esc((p.m_bp_systolic||'')+'/'+(p.m_bp_diastolic||''))}</td><td>${esc(p.bleeding||'')}</td><td>${esc(p.nb_feeding||'')}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No PNC visits yet.</td></tr>'}
   </table></div>`;
  $('#psave').onclick=async()=>{ const r=await api('POST','pnc_visits',{episode_id:+id,visit_date:vd.value||null,pnc_day:+pd.value||null,m_temp:+mt.value||null,m_bp_systolic:+bps.value||null,m_bp_diastolic:+bpd.value||null,m_pulse:+pl.value||null,bleeding:bl.value,breast:br.value,mood:md.value,nb_temp:+nt.value||null,nb_feeding:nf.value,cord:cd.value,danger_note:dn.value});
    $('#pm').textContent=(r&&(r.ids||r.queued))?' saved':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>pncVisits(id),500); };
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
   </div><button class="act" id="bsave" style="margin-top:10px">Add baby</button> <span class="muted" id="bm"></span></div>
   <div class="card"><h3>Babies</h3><table><tr><th>#</th><th>Sex</th><th>Weight</th><th>APGAR</th><th>Resus</th><th>Outcome</th></tr>
    ${past.map(p=>`<tr><td>${esc(p.birth_order||'')}</td><td>${esc(p.sex||'')}</td><td>${esc(p.weight_g||'')}</td><td>${esc((p.apgar_1min||'')+'/'+(p.apgar_5min||''))}</td><td>${p.resuscitated==1?'yes':'no'}</td><td>${esc(p.outcome||'')}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No babies recorded yet.</td></tr>'}
   </table></div>`;
  $('#bsave').onclick=async()=>{ const r=await api('POST','babies',{episode_id:+id,birth_order:+bo.value||1,sex:sx.value,weight_g:+wg.value||null,apgar_1min:+a1.value||null,apgar_5min:+a5.value||null,resuscitated:+rs.value,outcome:oc.value});
    $('#bm').textContent=(r&&(r.ids||r.queued))?' added':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>babiesScreen(id),400); };
}

async function vitalsScreen(id){
  const past=await api('GET','maternal_vitals?episode='+id).catch(()=>[]);
  app().innerHTML=nav()+`<div class="card"><h3>Maternal vital signs — episode ${esc(id)}</h3>
   <div class="grid">
    <label>BP systolic<input id="bps" type="number" value="120"></label>
    <label>BP diastolic<input id="bpd" type="number" value="80"></label>
    <label>Pulse<input id="pl" type="number" value="80"></label>
    <label>Temp °C<input id="tp" type="number" step="0.1" value="37"></label>
    <label>Resp rate<input id="rr" type="number" value="18"></label>
    <label>SpO2 %<input id="sp" type="number" value="98"></label>
   </div><label>Note<input id="ntt"></label>
   <button class="act" id="vsave" style="margin-top:10px">Record vitals</button> <span class="muted" id="vm"></span></div>
   <div class="card"><h3>Vitals history</h3><table><tr><th>When</th><th>BP</th><th>Pulse</th><th>Temp</th><th>RR</th><th>SpO2</th></tr>
    ${past.map(p=>`<tr><td>${esc((p.obs_datetime||p.recorded_at||'').slice(0,16))}</td><td>${esc((p.bp_systolic||'')+'/'+(p.bp_diastolic||''))}</td><td>${esc(p.pulse||'')}</td><td>${esc(p.temperature||'')}</td><td>${esc(p.resp_rate||'')}</td><td>${esc(p.spo2||'')}</td></tr>`).join('')||'<tr><td colspan=6 class=muted>No vitals yet.</td></tr>'}
   </table></div>`;
  $('#vsave').onclick=async()=>{ const r=await api('POST','maternal_vitals',{episode_id:+id,obs_datetime:nowStr(),bp_systolic:+bps.value||null,bp_diastolic:+bpd.value||null,pulse:+pl.value||null,temperature:+tp.value||null,resp_rate:+rr.value||null,spo2:+sp.value||null,note:ntt.value});
    $('#vm').textContent=(r&&(r.ids||r.queued))?' recorded':' '+((r&&r.error)||'error'); if(r&&r.ids) setTimeout(()=>vitalsScreen(id),400); };
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
   </div><button class="act" id="wsave" style="margin-top:10px">Save changes</button> <span class="muted" id="wm"></span></div>`;
  $('#wsave').onclick=async()=>{ const r=await api('PATCH','women/'+wid,{first_name:fn.value,father_name:fa.value,grandfather_name:gf.value,age:+age.value||null,phone:ph.value,kebele:kb.value,gravida:+gr.value||null,para:+pa.value||null});
    $('#wm').textContent=(r&&(r.ok||r.queued))?' saved':' '+((r&&r.error)||'error'); };
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

async function patientHub(id){
  const eps=await api('GET','episodes').catch(()=>[]);
  const e=(eps||[]).find(x=>x.id==id)||{}; const cat=e.service_category;
  const tile=(href,txt)=>`<a class="hubx" href="${href}">${txt}</a>`;
  let tiles;
  if(cat==='anc') tiles=[tile('#anc/'+id,'ANC screening'),tile('#ancvisit/'+id,'Follow-up visit'),tile('#vitals/'+id,'Vital signs'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary'),tile('#editwoman/'+e.woman_id,'Edit details')];
  else if(cat==='pnc') tiles=[tile('#pncvisit/'+id,'PNC follow-up'),tile('#baby/'+id,'Newborn'),tile('#vitals/'+id,'Vital signs'),tile('#danger/'+id,'Danger signs'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary')];
  else tiles=[tile('#partograph/'+id,'Partograph &amp; AI'),tile('#vitals/'+id,'Vital signs'),tile('#checklist/'+id,'Safe-birth checklist'),tile('#danger/'+id,'Danger signs'),tile('#delivery/'+id,'Delivery'),tile('#baby/'+id,'Newborn'),tile('#handover/'+id,'Handover'),tile('#referral/'+id,'Refer'),tile('#report/'+id,'Care summary')];
  app().innerHTML=nav()+`<div class="card"><h3>${esc((e.first_name||'')+' '+(e.father_name||''))||('Episode '+esc(id))}</h3>
    <p class="muted">MRN ${esc(e.mrn||'')} &middot; G${esc(e.gravida||'?')}/P${esc(e.para||'?')} &middot; ${esc(cat||'')} &middot; ${esc(e.status||'')}${e.admitted_from&&e.admitted_from!=='new'?(' &middot; admitted from '+esc(e.admitted_from)):''}</p>
    <div class="hubgrid">${tiles.join('')}</div></div>`;
}

if('serviceWorker' in navigator){ navigator.serviceWorker.register('./service-worker.js').catch(()=>{}); }
boot();
