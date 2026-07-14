// =================================================================================================
// THE LABOUR CARE GUIDE — THRESHOLDS AND ALERTS
//
// Ethiopia's endorsed Intrapartum Care Guideline (2025) replaces the partograph with the WHO Labour
// Care Guide. This file is the ONE place the alert column lives. Every threshold below is taken from
// that guideline, item by item. The screen uses it, the record stores what it fired, and nothing else
// in the tool is allowed to have its own opinion about what "abnormal" means.
//
// THE ORDER OF AUTHORITY, AND WHY IT MATTERS:
//   1. The alert column (this file) is the guideline. It fires on the recorded value alone.
//   2. The AI score is advisory. It can draw attention; it can NEVER suppress an alert.
// A tool that lets a model talk a midwife out of a threshold is a liability, not a decision aid.
//
// WHAT CHANGED FROM THE PARTOGRAPH: the 1 cm/hour alert line and its action line are gone. Poor
// progress is now a fact about HOW LONG SHE HAS STOOD STILL at the dilatation she is at — a lag time
// per centimetre — not about where a pen mark sits relative to a diagonal drawn for someone else.
// =================================================================================================
(function(global){
  'use strict';

  // ---- Section 5: the lag time at each centimetre of the active first stage (>= 5 cm) ----------
  // "5cm >=6hrs, 6cms >=5hrs, 7cms >=3hrs, 8cm >=2.5hrs, 9cms >=2hrs" — Intrapartum Care Guideline.
  const LAG_HOURS = { 5: 6, 6: 5, 7: 3, 8: 2.5, 9: 2 };

  // Second stage: birth not completed within 3 h (nulliparous) or 2 h (multiparous) from the start
  // of the ACTIVE second stage — i.e. from when pushing began.
  const SECOND_STAGE_HOURS = { nulliparous: 3, multiparous: 2 };

  // ---- The alert column, section by section ----------------------------------------------------
  // Each rule: does this single recorded value meet the criterion in the guideline's Alert column?
  const RULES = [
    // Section 2 — supportive care. These are alerts in the guideline, and they are alerts here.
    // A woman labouring alone, in pain, or flat on her back is a deviation to be acted on.
    { code:'NO_COMPANION',  field:'companion',   label:'No labour companion',
      test:v=>v==='N', action:'Offer to find a companion of her choice.' },
    { code:'NO_PAIN_RELIEF',field:'pain_relief', label:'No pain relief',
      test:v=>v==='N', action:'Offer pain relief — pharmacological or not — according to her preference.' },
    { code:'NO_ORAL_FLUID', field:'oral_fluid',  label:'No oral fluid',
      test:v=>v==='N', action:'Encourage her to drink and to take a light diet as she wishes.' },
    { code:'SUPINE',        field:'posture',     label:'Supine posture',
      test:v=>v==='SP', action:'Encourage her to move freely and support the position she chooses.' },

    // Section 3 — the baby.
    { code:'FHR',           field:'fhr_baseline', label:'Fetal heart rate',
      test:v=>v!=null && v!=='' && (+v < 110 || +v >= 160),
      action:'Turn her onto her left side, then alert a senior provider and follow the guideline.' },
    { code:'DECEL_LATE',    field:'fhr_decel',    label:'Late decelerations',
      test:v=>v==='L',
      action:'Left lateral, prolonged auscultation, alert a senior provider.' },
    { code:'FLUID',         field:'amniotic_fluid', label:'Amniotic fluid',
      test:v=>v==='M+++' || v==='B',
      action:'Thick meconium or blood-stained fluid — alert a senior provider and follow the guideline.' },
    { code:'POSITION',      field:'fetal_position', label:'Fetal position',
      test:v=>v==='P' || v==='T',
      action:'Occiput posterior or transverse — alert a senior provider.' },
    { code:'CAPUT',         field:'caput',        label:'Caput +++',
      test:v=>v==='+++', action:'Marked caput — alert a senior provider and follow local protocol.' },
    { code:'MOULDING',      field:'moulding',     label:'Moulding +++',
      test:v=>v==='+++', action:'Sutures overlapped and not reducible — a sign of obstruction. Alert a senior provider.' },

    // Section 4 — the woman.
    { code:'PULSE',   field:'pulse',        label:'Pulse',
      test:v=>v!=null && v!=='' && (+v < 60 || +v >= 120),
      action:'Alert a senior provider and look for the cause — pain, dehydration, fever, bleeding.' },
    { code:'SBP',     field:'bp_systolic',  label:'Systolic BP',
      test:v=>v!=null && v!=='' && (+v < 80 || +v >= 140),
      action:'Alert a senior provider. Low may be shock or haemorrhage; high may be hypertension.' },
    { code:'DBP',     field:'bp_diastolic', label:'Diastolic BP',
      test:v=>v!=null && v!=='' && (+v >= 90),
      action:'Alert a senior provider — this may be hypertension.' },
    { code:'TEMP',    field:'temperature',  label:'Temperature',
      test:v=>v!=null && v!=='' && (+v < 35.0 || +v >= 37.5),
      action:'Alert a senior provider and follow local guidelines.' },
    { code:'URINE_P', field:'urine_protein', label:'Proteinuria',
      test:v=>v==='++'||v==='+++'||v==='++++',
      action:'Interpret with a full clinical examination — this may be pre-eclampsia. Alert a senior provider.' },
    { code:'URINE_A', field:'urine_acetone', label:'Ketonuria',
      test:v=>v==='++'||v==='+++'||v==='++++',
      action:'May be dehydration or prolonged labour. Interpret clinically and alert a senior provider.' },

    // Section 5 — labour progress (the two that need no history).
    { code:'CTX_FREQ', field:'contractions_per10', label:'Contractions per 10 min',
      test:v=>v!=null && v!=='' && (+v < 2 || +v > 5),
      action:'Verify over another 10 minutes. If confirmed, alert a senior provider. Fewer than 2 may indicate inadequate uterine activity; more than 5 suggests obstruction or hyperstimulation.' },
    { code:'CTX_DUR',  field:'contraction_dur_sec', label:'Duration of contractions',
      test:v=>v!=null && v!=='' && (+v < 20 || +v > 60),
      action:'Verify over another 10 minutes. If confirmed, alert a senior provider.' },
  ];

  // ---- Cervix: the alert that needs her history, not just this reading -------------------------
  // "The alert will be triggered when lag time for current cervical dilatation is exceeded WITH NO
  // PROGRESS." So it is not "how long has she been in labour" — it is "how long has she been AT THIS
  // CENTIMETRE". Measure from the first assessment at the current dilatation (or from the start of
  // active labour, if that reading is the first one).
  function cervixStall(series, now, activeStart){
    const withCvx = (series||[]).filter(o=>o.cervix_cm!=null && o.cervix_cm!=='');
    if(!withCvx.length) return null;
    const last = withCvx[withCvx.length-1];
    const cm = Math.floor(+last.cervix_cm);
    const limit = LAG_HOURS[cm];
    if(!limit) return null;                       // 10 cm is second stage; below 5 cm is not active labour
    // Walk back while the dilatation has not increased — that is the "no progress" window.
    let since = last.obs_datetime;
    for(let i=withCvx.length-1; i>=0; i--){
      if(Math.floor(+withCvx[i].cervix_cm) < cm) break;   // she progressed to cm here — the clock starts after this
      since = withCvx[i].obs_datetime;
    }
    const t0 = new Date(String(since).replace(' ','T'));
    const t1 = new Date(String(now||last.obs_datetime).replace(' ','T'));
    const hours = (t1 - t0) / 3600000;
    if(!(hours >= limit)) return null;
    return { code:'CERVIX_LAG', label:'Cervix '+cm+' cm', value:round1(hours)+' h at '+cm+' cm',
      detail:'Lag time for '+cm+' cm is '+limit+' h and there has been no progress.',
      action:'Poor progress. Alert a senior provider, assess for obstruction, and follow the guideline.' };
  }

  // Second stage: from when pushing began.
  function secondStageStall(series, now, parity){
    const push = (series||[]).find(o=>+o.pushing_started===1);
    if(!push) return null;
    const limit = (+parity===0) ? SECOND_STAGE_HOURS.nulliparous : SECOND_STAGE_HOURS.multiparous;
    const t0 = new Date(String(push.obs_datetime).replace(' ','T'));
    const t1 = new Date(String(now||new Date()).replace(' ','T'));
    const hours = (t1 - t0) / 3600000;
    if(!(hours >= limit)) return null;
    return { code:'SECOND_STAGE_LAG', label:'Second stage', value:round1(hours)+' h pushing',
      detail:'Birth is not completed within '+limit+' h of the active second stage ('+((+parity===0)?'nulliparous':'multiparous')+').',
      action:'Alert a senior provider and follow the guideline.' };
  }

  // ---- The whole alert column for one assessment ------------------------------------------------
  // `obs` is the assessment being checked. `series` is everything recorded on this guide so far
  // (including obs), used only for the two alerts that are about time, not about a value.
  function alertsFor(obs, series, opts){
    opts = opts || {};
    const out = [];
    RULES.forEach(r=>{
      const v = obs ? obs[r.field] : null;
      if(v===null || v===undefined || v==='') return;      // not assessed is not an alert
      if(r.test(v)) out.push({ code:r.code, label:r.label, value:String(v), detail:'', action:r.action });
    });
    const stall = cervixStall(series, obs && obs.obs_datetime, opts.activeStart);
    if(stall) out.push(stall);
    const ss = secondStageStall(series, obs && obs.obs_datetime, opts.parity);
    if(ss) out.push(ss);
    return out;
  }

  // Does THIS value, on its own, meet the alert criterion? Used to paint a single cell in the grid.
  function cellAlerts(field, value){
    if(value===null || value===undefined || value==='') return false;
    return RULES.some(r=>r.field===field && r.test(value));
  }

  // ---- What is due, and when -------------------------------------------------------------------
  // Frequencies from the guideline. Supportive care hourly. FHR and contractions every 30 min in the
  // first stage — every 5 and 15 minutes in the second. Pulse, BP, temperature and urine 4-hourly.
  // The vaginal-examination group (cervix, position, caput, moulding, descent) 4-hourly.
  const SCHEDULE = [
    { key:'supportive', label:'Supportive care',      fields:['companion','pain_relief','oral_fluid','posture'], first:60,  second:60  },
    { key:'fhr',        label:'Fetal heart rate',     fields:['fhr_baseline','fhr_decel'],                       first:30,  second:5   },
    { key:'ctx',        label:'Contractions',         fields:['contractions_per10','contraction_dur_sec'],       first:30,  second:15  },
    { key:'vitals',     label:'Pulse, BP, temperature', fields:['pulse','bp_systolic','bp_diastolic','temperature'], first:240, second:240 },
    { key:'urine',      label:'Urine',                fields:['urine_protein','urine_acetone'],                  first:240, second:240 },
    { key:'ve',         label:'Cervix, position, caput, moulding, descent',
      fields:['cervix_cm','fetal_position','caput','moulding','descent_fifths'],                                 first:240, second:240 },
  ];

  function dueNow(series, stage, now){
    const t1 = new Date(String(now||new Date()).replace(' ','T'));
    const out = [];
    SCHEDULE.forEach(s=>{
      const every = (stage==='second') ? s.second : s.first;
      let last = null;
      (series||[]).forEach(o=>{
        if(s.fields.some(f=>o[f]!==null && o[f]!==undefined && o[f]!=='')) last = o.obs_datetime;
      });
      if(!last){ out.push({ key:s.key, label:s.label, mins:every, overdue:true, since:null }); return; }
      const mins = (t1 - new Date(String(last).replace(' ','T'))) / 60000;
      if(mins >= every) out.push({ key:s.key, label:s.label, mins:every, overdue:true, since:Math.round(mins) });
    });
    return out;
  }

  function round1(n){ return Math.round(n*10)/10; }

  // ---- What the RISK MODEL is given about progress ---------------------------------------------
  // The model no longer receives `cvx_rate` — the (cervix - 4) / hours of the partograph era, which
  // was anchored on a 4 cm start that the guideline has abolished. It receives what the guideline
  // itself reasons about: how long she has stood still at THIS centimetre, and how that compares
  // with the lag time allowed for it. lag_ratio >= 1 is the alert.
  function stallInfo(series, now){
    const withCvx=(series||[]).filter(o=>o.cervix_cm!=null && o.cervix_cm!=='');
    if(!withCvx.length) return {cm:null, stall_h:null, lag_ratio:null};
    const last=withCvx[withCvx.length-1];
    const cm=Math.floor(+last.cervix_cm);
    let since=last.obs_datetime;
    for(let i=withCvx.length-1;i>=0;i--){
      if(Math.floor(+withCvx[i].cervix_cm) < cm) break;
      since=withCvx[i].obs_datetime;
    }
    const t0=new Date(String(since).replace(' ','T'));
    const t1=new Date(String(now||last.obs_datetime).replace(' ','T'));
    const stall=Math.max(0,(t1-t0)/3600000);
    const limit=LAG_HOURS[cm];
    return { cm:cm, stall_h:round1(stall), lag_ratio: limit ? Math.round((stall/limit)*100)/100 : null };
  }

  global.LCG = {
    LAG_HOURS, SECOND_STAGE_HOURS, RULES, SCHEDULE,
    alertsFor, cellAlerts, cervixStall, secondStageStall, dueNow, stallInfo,
    lagLimit: cm => LAG_HOURS[Math.floor(+cm)] || null,
  };
})(window);
