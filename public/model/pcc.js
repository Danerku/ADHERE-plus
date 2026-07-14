// =================================================================================================
// PRECONCEPTION CARE — COMPONENTS, THRESHOLDS AND READINESS
//
// Source: National Preconception Care Guideline, FMOH Ethiopia, June 2024.
// This file is the ONE place the preconception rules live. The screen, the care plan, the print
// view, the register export and the indicators all read from here. Nothing else in the tool is
// allowed to have its own opinion about what "optimised" means.
//
// THERE IS NO MODEL HERE, AND THAT IS DELIBERATE.
// The guideline's logic is fully specified — a dose, a target, a threshold, a referral. The outcomes
// it exists to prevent (neural tube defect, congenital anomaly) are rare and sit years downstream of
// the contact. There is nothing here we could honestly learn from data we have, and a score would
// only dress up a rule the guideline already states plainly. So: rules, named, traceable to the page
// they came from. If prediction is ever wanted here it should be a study, not a side-effect.
//
// TWO THINGS THIS FILE REFUSES TO DO:
//   1. It will not let a MISSING TEST read as a NORMAL TEST. A woman whose HBsAg was never run is
//      not a woman who is HBsAg-negative. She comes back `incomplete`, with the gap named.
//   2. It will not tell a health centre to manage what the guideline sends elsewhere. Every
//      component carries the level of care that owns it (Table 5); below that level the action is
//      "refer", not "treat".
// =================================================================================================
(function(global){
  'use strict';

  // ---- Level of care (Table 5) -----------------------------------------------------------------
  // c = community (HEW) · p = primary (health centre) · s = secondary · t = tertiary.
  // `owns` is the LOWEST level that MANAGES the component. Anything below it assesses and refers.
  const L = { c:0, p:1, s:2, t:3 };

  // ---- The fifteen components (Table 4 · job aid Table 9) ---------------------------------------
  // `uptake` maps the component to its item number on the MoH ANC uptake checklist (Table 8), which
  // is what lets a woman's own PCC record pre-fill the checklist she is asked at ANC.
  const COMPONENTS = [
    { key:'fp',          n:1,  label:'Family planning & reproductive life plan', owns:L.c, uptake:'i1_family_planning',
      assess:'Reproductive life plan; history of unintended pregnancy or abortion; infertility; disability' },
    { key:'nutrition',   n:2,  label:'Nutrition',                                owns:L.c, uptake:'i2_nutrition_bmi',
      assess:'Diet & dietary diversity; anthropometry (BMI); anaemia; iodised salt' },
    { key:'folate',      n:3,  label:'Iron-folic acid supplementation',          owns:L.c, uptake:'i3_folic_acid',
      assess:'Eligibility for routine (0.4 mg) or high-dose (5 mg) folic acid' },
    { key:'chronic',     n:4,  label:'Chronic disease',                          owns:L.c, uptake:'i4_chronic_disease',
      assess:'Diabetes; hypertension; cardiac disease; chronic kidney disease; epilepsy',
      note:'Diabetes, hypertension and cardiac disease are managed from community level; CKD and epilepsy from primary level up.' },
    { key:'substance',   n:5,  label:'Substance use',                            owns:L.p, uptake:'i5_substance_use',
      assess:'Alcohol, khat, cigarettes, recreational drugs, street medication, coffee' },
    { key:'activity',    n:6,  label:'Physical activity',                        owns:L.c, uptake:'i6_physical_activity',
      assess:'Weekly activity; BMI' },
    { key:'cxca',        n:7,  label:'Reproductive organ anomalies & cervical cancer', owns:L.p, uptake:'i7_repro_cxca',
      assess:'Cervical cancer screening status; HPV immunisation; reproductive organ anomalies' },
    { key:'gbv',         n:8,  label:'Sexual health, GBV & FGM',                 owns:L.c, uptake:'i8_sexual_gbv_fgm',
      assess:'Current, recent or past physical, sexual or emotional violence; FGM; sexual dysfunction',
      note:'Ask in private, or do not ask at all.' },
    { key:'infection',   n:9,  label:'Infectious disease',                       owns:L.c, uptake:'i9_infectious',
      assess:'STI history; syphilis; HIV; TB; malaria; hepatitis B' },
    { key:'vaccine',     n:10, label:'Vaccine-preventable disease',              owns:L.c, uptake:'i10_vaccine',
      assess:'Td status (Table 3); HBsAg and hepatitis B vaccination' },
    { key:'genetic',     n:11, label:'Genetic risk',                             owns:L.p, uptake:'i11_genetic',
      assess:'Three-generation family history of both parents-to-be; consanguinity; prior neural tube defect' },
    { key:'medicines',   n:12, label:'Medicines with adverse pregnancy effect',  owns:L.c, uptake:'i12_medication',
      assess:'Prescribed, over-the-counter, herbal and weight-loss medicines' },
    { key:'mental',      n:13, label:'Mental health',                            owns:L.c, uptake:'i13_mental_health',
      assess:'Depression, anxiety, stress; known mental illness' },
    { key:'environment', n:14, label:'Environmental / occupational exposure',    owns:L.c, uptake:'i14_environmental',
      assess:'Pets; X-ray or radiation; heavy metals and workplace chemicals' },
    { key:'dental',      n:15, label:'Dental & oral health',                     owns:L.p, uptake:'i15_dental',
      assess:'Bleeding or swollen gums, pain on chewing, loose teeth' },
  ];

  // ---- Thresholds, every one of them from the guideline -----------------------------------------
  const T = {
    BMI_UNDER: 18.5,          // Table 1
    BMI_OVER:  25,            // Table 1 — counsel from here; also the trigger to screen for diabetes
    BMI_OBESE: 30,            // Table 1
    HGB_ANAEMIA: 12.0,        // g/dL, non-pregnant woman
    FBS_MAX: 110,             // mg/dL — preconception target 80-110
    FBS_MIN: 80,
    HBA1C_MIN: 5.0,           // % — target 5-7, measured monthly until achieved
    HBA1C_MAX: 7.0,
    SBP: 140, DBP: 90,        // hypertension
    CREAT_SEVERE: 2.5,        // mg/dL — severe chronic renal disease: avoid pregnancy before treatment
    CREAT_MOD: 1.4,           // moderate
    COFFEE_MAX: 3,            // fewer than 3 cups per day
    ACTIVITY_MIN: 150,        // min/week moderate aerobic, plus strengthening 2 days/week
    TD_DOSES: 3,              // Td1, +4 weeks, +6 months (Table 3) — protection from Td3
    HBV_DOSES: 3,
    FOLATE_MONTHS: 3,         // "at least three months before conception" — both doses
    BIRTH_INTERVAL_M: 24,     // at least 24 months between births
  };

  // Medicines the guideline asks us to catch. This is a PROMPT TO REVIEW, not a verdict: the action
  // is "refer for medication review before conception", never "stop this drug". Half of these are
  // drugs a woman must not simply come off (epilepsy, cardiac, autoimmune) — telling her to stop
  // would do more harm than the pregnancy risk it was meant to avoid.
  const TERATOGENIC = [
    'valproate','valproic','depakine','carbamazepine','phenytoin','phenobarbital','topiramate',
    'warfarin','isotretinoin','retinoid','methotrexate','thalidomide','lithium',
    'enalapril','lisinopril','captopril','ramipril','losartan','valsartan',
    'misoprostol','danazol','finasteride','tetracycline','doxycycline','fluconazole',
    'statin','atorvastatin','simvastatin','androgen','testosterone',
  ];

  function flagsMedicines(text){
    if(!text) return [];
    const s = String(text).toLowerCase();
    return TERATOGENIC.filter(d => s.indexOf(d) >= 0);
  }

  // ---- BMI --------------------------------------------------------------------------------------
  function bmi(height_cm, weight_kg){
    const h = +height_cm, w = +weight_kg;
    if(!h || !w || h < 100 || h > 220 || w < 25 || w > 250) return null;
    return Math.round((w / Math.pow(h/100, 2)) * 10) / 10;
  }
  function bmiClass(b){
    if(b == null) return null;
    if(b < T.BMI_UNDER) return 'underweight';
    if(b < T.BMI_OVER)  return 'normal';
    if(b < T.BMI_OBESE) return 'overweight';
    return 'obese';
  }

  // ---- Folic acid dose --------------------------------------------------------------------------
  // 0.4 mg is the routine dose. 5 mg is indicated where the guideline names an indication — and the
  // indications are the reason the dose exists, so they are returned WITH it. A provider who is told
  // "5 mg" and not told why cannot check whether we are right.
  function folateDose(a){
    a = a || {};
    const why = [];
    if(a.prior_ntd)                                    why.push('previous neural tube defect');
    if(a.dm_known)                                     why.push('diabetes');
    if(bad(a.dm_fbs)      && +a.dm_fbs   > T.FBS_MAX)  why.push('raised fasting blood glucose');
    if(bad(a.dm_hba1c)    && +a.dm_hba1c > T.HBA1C_MAX)why.push('HbA1c above target');
    if(a.epilepsy)                                     why.push('epilepsy');
    if(a.family_hx_genetic)                            why.push('family history of genetic disorder');
    if(a.prior_apo)                                    why.push('previous adverse pregnancy outcome (' + String(a.prior_apo).slice(0,60) + ')');
    return { dose: why.length ? '5mg' : '0.4mg', high: why.length > 0, reasons: why };
  }
  function bad(v){ return v !== null && v !== undefined && v !== '' && !isNaN(+v); }

  // The 3-month clock. This is the single most actionable number in the whole module: it is the date
  // she can be told it is safe to try. Everything else is advice; this is a date.
  function folateClock(start_date){
    if(!start_date) return null;
    const d = new Date(String(start_date).slice(0,10) + 'T00:00:00');
    if(isNaN(d)) return null;
    const ready = new Date(d); ready.setMonth(ready.getMonth() + T.FOLATE_MONTHS);
    const days = Math.ceil((ready - new Date()) / 86400000);
    return {
      start: iso(d),
      conception_from: iso(ready),
      days_remaining: days > 0 ? days : 0,
      complete: days <= 0,
    };
  }
  function iso(d){ return d.toISOString().slice(0,10); }

  // ---- READINESS ---------------------------------------------------------------------------------
  // Four states, in strict precedence:
  //
  //   defer      — the guideline says do not conceive yet, and says it about THIS condition:
  //                WHO cardiac class III/IV, severe chronic renal disease. Contraception, and refer.
  //   optimize   — she can conceive, but something must be brought to target first, and the target
  //                is stated so she and the provider can both see when it has been met.
  //   incomplete — something the guideline requires was not assessed. NOT the same as normal, and it
  //                must never be allowed to look like it.
  //   ready      — assessed, and nothing is outstanding.
  //
  // Every reason is a sentence a provider can act on. There is no score, and there is no bare label.
  function readiness(a){
    a = a || {};
    const defer = [], optimize = [], cannot = [], advise = [];

    // ---------- defer: the guideline's own words ----------
    if(a.cardiac_who_class === 'III' || a.cardiac_who_class === 'IV'){
      defer.push('Modified WHO cardiac risk class ' + a.cardiac_who_class +
                 ' — pregnancy carries a high or unacceptable risk. Refer, and start effective contraception until cardiac function is optimised.');
    }
    if(bad(a.creatinine) && +a.creatinine >= T.CREAT_SEVERE){
      defer.push('Creatinine ' + a.creatinine + ' mg/dL — severe chronic renal disease. The guideline is to avoid pregnancy until it is treated. Refer.');
    }

    // ---------- optimize: a target, and the number she is at ----------
    if(bad(a.bp_systolic) && bad(a.bp_diastolic) && (+a.bp_systolic >= T.SBP || +a.bp_diastolic >= T.DBP)){
      optimize.push('Blood pressure ' + a.bp_systolic + '/' + a.bp_diastolic +
                    ' — hypertension. Contraception until it is controlled; lifestyle and weight advice; review medication for drugs that must not be used in pregnancy.');
    }
    if(bad(a.dm_fbs) && +a.dm_fbs > T.FBS_MAX){
      optimize.push('Fasting glucose ' + a.dm_fbs + ' mg/dL — above the preconception target of ' + T.FBS_MIN + '-' + T.FBS_MAX +
                    ' mg/dL. Contraception until it is in range; 5 mg folic acid.');
    }
    if(bad(a.dm_hba1c) && (+a.dm_hba1c > T.HBA1C_MAX)){
      optimize.push('HbA1c ' + a.dm_hba1c + '% — above the 5-7% target. Recheck monthly until satisfactory control is achieved.');
    }
    if(a.epilepsy && flagsMedicines(a.epilepsy_drug).length){
      optimize.push('On ' + a.epilepsy_drug + ' — refer for review before conception; the guideline names valproate as the drug to avoid. 5 mg folic acid daily. Do not stop the drug on our advice.');
    } else if(a.epilepsy){
      optimize.push('Epilepsy — 5 mg folic acid daily for at least 3 months before conception, and refer for medication review.');
    }
    const med = flagsMedicines(a.current_medicines);
    if(med.length){
      optimize.push('Current medicine flagged for review before conception (' + med.join(', ') + '). Refer — do not stop it on our advice.');
    }
    const b = a.bmi != null && a.bmi !== '' ? +a.bmi : bmi(a.height_cm, a.weight_kg);
    const bc = bmiClass(b);
    if(bc === 'obese')       optimize.push('BMI ' + b + ' — obese. Counsel on weight, diet and activity; screen for diabetes. Raised risk in pregnancy, and of infertility.');
    else if(bc === 'overweight') optimize.push('BMI ' + b + ' — overweight. Counsel on diet and activity; screen for diabetes.');
    else if(bc === 'underweight') optimize.push('BMI ' + b + ' — underweight. Nutrition counselling and follow-up.');
    if(bad(a.hgb) && +a.hgb < T.HGB_ANAEMIA){
      optimize.push('Haemoglobin ' + a.hgb + ' g/dL — anaemia. Iron-folic acid and follow-up; look for a cause.');
    }
    if(a.hbsag === 'positive'){
      optimize.push('HBsAg positive — link her to a facility where hepatitis B treatment is available.');
    }
    if(a.syphilis === 'positive'){
      optimize.push('Syphilis positive — treat her and her partner before conception.');
    }
    if(a.hiv_status === 'positive'){
      optimize.push('HIV positive — link to PMTCT and confirm she is established on ART before she conceives.');
    }
    if(a.tb_screen === 'presumptive'){
      optimize.push('Presumptive TB — investigate and treat before conception.');
    }
    if(bad(a.td_doses) && +a.td_doses < T.TD_DOSES){
      optimize.push('Td ' + a.td_doses + ' of ' + T.TD_DOSES + ' — complete the schedule (Td1, then 4 weeks, then 6 months).');
    }
    if(a.hbsag === 'negative' && bad(a.hbv_vaccine_doses) && +a.hbv_vaccine_doses < T.HBV_DOSES){
      optimize.push('HBsAg negative and hepatitis B vaccination incomplete (' + a.hbv_vaccine_doses + ' of 3) — offer the three-dose course.');
    }
    if(a.gbv_positive){
      optimize.push('Discloses violence — safety first, then the referral pathway. Do not record details that could put her at risk.');
    }
    if(a.alcohol === 'frequent' || a.other_substance){
      optimize.push('Substance use — counsel on cessation and refer; alcohol and drug management sits at primary level and above.');
    }
    if(a.tobacco === 'frequent' || a.khat === 'frequent'){
      optimize.push('Tobacco or khat use — cessation counselling.');
    }
    if(bad(a.coffee_cups) && +a.coffee_cups >= T.COFFEE_MAX){
      advise.push('Coffee ' + a.coffee_cups + ' cups a day — the guideline advises fewer than 3.');
    }
    if(bad(a.activity_min_week) && +a.activity_min_week < T.ACTIVITY_MIN){
      advise.push('Activity ' + a.activity_min_week + ' min/week — advise at least 150 minutes of moderate activity a week plus strengthening on 2 days.');
    }
    if(a.mh_depression || a.mh_anxiety){
      optimize.push('Screens positive for depression or anxiety — counsel on the risk of relapse around pregnancy, and refer.');
    }
    if(a.dental_problem){
      advise.push('Dental problem — refer for oral health care before conception.');
    }
    if(a.cxca_screened === 'due' || a.cxca_screened === 'no'){
      advise.push('Cervical cancer screening not up to date — screen or refer for screening.');
    }
    if(a.fgm === 'yes'){
      advise.push('FGM — counsel her and the family on the consequences, and plan for delivery.');
    }

    // ---------- cannot assess: a gap, said out loud ----------
    // The guideline screens EVERY preconception woman for HIV, syphilis and hepatitis B. If they were
    // not done, we do not know, and we say so. The remaining tests are conditional: we only demand
    // the test where her own findings make the guideline ask for it.
    if(!a.hiv_status || a.hiv_status === 'unknown')  cannot.push('HIV status not known');
    if(!a.syphilis   || a.syphilis   === 'not_done') cannot.push('Syphilis test not done');
    if(!a.hbsag      || a.hbsag      === 'not_done') cannot.push('HBsAg not done');
    const dmRisk = a.dm_known || (b != null && b >= T.BMI_OVER) || /gdm|gestational diabetes|stillbirth|macrosom/i.test(String(a.prior_apo||''));
    if(dmRisk && !bad(a.dm_fbs) && !bad(a.dm_hba1c)) cannot.push('Diabetes screening indicated but no blood glucose recorded');
    if(a.dm_known && !bad(a.dm_hba1c))               cannot.push('Known diabetes but no HbA1c — control cannot be judged');
    if(a.ckd_known && !bad(a.creatinine))            cannot.push('Known kidney disease but no creatinine — severity cannot be judged');
    if(a.cardiac_symptoms && (!a.cardiac_who_class || a.cardiac_who_class === 'unknown'))
      cannot.push('Cardiac symptoms but no WHO risk class — refer for assessment');
    if(!bad(a.bp_systolic) || !bad(a.bp_diastolic))  cannot.push('Blood pressure not measured');
    if(b == null)                                    cannot.push('BMI not calculated (height or weight missing)');

    let state = 'ready';
    if(cannot.length)   state = 'incomplete';
    if(optimize.length) state = 'optimize';
    if(defer.length)    state = 'defer';

    return {
      state: state,
      defer: defer,
      optimize: optimize,
      cannot_assess: cannot,
      advise: advise,
      reasons: defer.concat(optimize),            // what drove the state
      folate: folateDose(a),
      bmi: b, bmi_class: bc,
      // Contraception is not a footnote here. If she must not conceive yet, the tool has to say what
      // she does in the meantime, or the advice is incomplete and she conceives anyway.
      contraception_indicated: (defer.length > 0 || optimize.length > 0) && a.plans_pregnancy !== 'no',
    };
  }

  const STATE_LABEL = {
    ready:      'Ready to conceive',
    optimize:   'Optimise before conception',
    defer:      'Defer pregnancy — refer',
    incomplete: 'Assessment incomplete',
  };

  // ---- Completeness: has this contact actually delivered PCC? -------------------------------------
  // Used by the screen (progress) and by the "PCC service delivered" indicator. A contact that
  // touched two components is a contact, not a preconception assessment.
  function componentDone(key, a){
    a = a || {};
    switch(key){
      case 'fp':          return !!(a.plans_pregnancy || a.fp_counselled || a.fp_current_method);
      case 'nutrition':   return !!(a.height_cm && a.weight_kg) || bad(a.hgb) || !!a.diet_counselled;
      case 'folate':      return !!a.folate_dose;
      case 'chronic':     return bad(a.bp_systolic) || bad(a.dm_fbs) || a.dm_known != null || a.htn_known != null;
      case 'substance':   return !!(a.alcohol || a.khat || a.tobacco);
      case 'activity':    return bad(a.activity_min_week);
      case 'cxca':        return !!a.cxca_screened;
      case 'gbv':         return a.gbv_screened != null;
      case 'infection':   return !!(a.hiv_status || a.syphilis || a.hbsag || a.tb_screen);
      case 'vaccine':     return bad(a.td_doses) || bad(a.hbv_vaccine_doses);
      case 'genetic':     return a.consanguinity != null || a.prior_ntd != null || !!a.family_hx_genetic;
      case 'medicines':   return a.current_medicines != null && a.current_medicines !== '' ? true : (a.teratogenic_flag != null);
      case 'mental':      return a.mh_depression != null || a.mh_anxiety != null;
      case 'environment': return a.exposure_pets != null || a.exposure_radiation != null || a.exposure_chemicals != null || a.exposure_counselled != null;
      case 'dental':      return a.dental_problem != null;
      default:            return false;
    }
  }
  function completeness(a){
    const done = COMPONENTS.filter(c => componentDone(c.key, a));
    return { done: done.length, total: COMPONENTS.length, keys: done.map(c => c.key),
             missing: COMPONENTS.filter(c => !componentDone(c.key, a)).map(c => c.label) };
  }

  // ---- Uptake at ANC (Table 8) --------------------------------------------------------------------
  // none    = none of the 15
  // partial = at least one
  // optimal = folic acid PLUS at least one other
  // Written exactly as the guideline states it, because this is a national indicator and a helpful
  // reinterpretation of it is just a wrong number that agrees with itself.
  const UPTAKE_ITEMS = COMPONENTS.map(c => ({ n:c.n, key:c.uptake, label:c.label }));

  function uptakeStatus(u){
    u = u || {};
    const yes = UPTAKE_ITEMS.filter(i => u[i.key] === 1 || u[i.key] === true || u[i.key] === '1');
    if(!yes.length) return 'none';
    const folate = u.i3_folic_acid === 1 || u.i3_folic_acid === true || u.i3_folic_acid === '1';
    if(folate && yes.length >= 2) return 'optimal';
    return 'partial';
  }
  const UPTAKE_LABEL = { none:'No PCC uptake', partial:'Partial PCC uptake', optimal:'Optimal PCC uptake' };

  // Pre-fill the ANC checklist from her OWN preconception record, where we have one. The provider
  // still confirms every line — this fills the form, it does not answer for her. Only components
  // that were actually delivered (not merely asked about) pre-tick.
  function uptakeFromAssessment(a){
    if(!a) return null;
    const u = {};
    u.i1_family_planning   = a.fp_counselled ? 1 : 0;
    u.i2_nutrition_bmi     = (a.diet_counselled || a.bmi) ? 1 : 0;
    u.i3_folic_acid        = (a.folate_dose && a.folate_dose !== 'none') ? 1 : 0;
    u.i4_chronic_disease   = (a.dm_known || a.htn_known || a.ckd_known || a.epilepsy || a.cardiac_who_class) ? 1 : 0;
    u.i5_substance_use     = (a.alcohol || a.khat || a.tobacco) ? 1 : 0;
    u.i6_physical_activity = (a.activity_min_week != null && a.activity_min_week !== '') ? 1 : 0;
    u.i7_repro_cxca        = (a.cxca_screened === 'yes') ? 1 : 0;
    u.i8_sexual_gbv_fgm    = a.gbv_screened ? 1 : 0;
    u.i9_infectious        = (a.hiv_status && a.hiv_status !== 'unknown') ? 1 : 0;
    u.i10_vaccine          = (a.td_doses != null && a.td_doses !== '') ? 1 : 0;
    u.i11_genetic          = (a.consanguinity != null || a.prior_ntd != null) ? 1 : 0;
    u.i12_medication       = (a.current_medicines != null && a.current_medicines !== '') ? 1 : 0;
    u.i13_mental_health    = (a.mh_depression != null || a.mh_anxiety != null) ? 1 : 0;
    u.i14_environmental    = (a.exposure_counselled != null) ? 1 : 0;
    u.i15_dental           = (a.dental_problem != null) ? 1 : 0;
    u.status = uptakeStatus(u);
    return u;
  }

  // ---- Td schedule (Table 3) -----------------------------------------------------------------------
  function tdNextDue(doses, last_date){
    const d = +doses || 0;
    if(d >= 5) return null;
    if(!last_date) return null;
    const base = new Date(String(last_date).slice(0,10) + 'T00:00:00');
    if(isNaN(base)) return null;
    const next = new Date(base);
    if(d === 1) next.setDate(next.getDate() + 28);        // Td2: at least 4 weeks after Td1
    else if(d === 2) next.setMonth(next.getMonth() + 6);  // Td3: at least 6 months after Td2
    else next.setFullYear(next.getFullYear() + 1);        // Td4/Td5: at least a year on
    return iso(next);
  }

  global.PCC = {
    COMPONENTS, UPTAKE_ITEMS, T, TERATOGENIC, L,
    bmi, bmiClass, folateDose, folateClock, flagsMedicines,
    readiness, STATE_LABEL, completeness, componentDone,
    uptakeStatus, uptakeFromAssessment, UPTAKE_LABEL, tdNextDue,
  };
})(window);
