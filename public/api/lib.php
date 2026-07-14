<?php
// CORS for the Android/native app origins (credentialed) + preflight
$__origin=$_SERVER['HTTP_ORIGIN']??'';
$__allow=['https://localhost','capacitor://localhost'];
if(!getenv('SITE_DOMAIN')){ $__allow[]='http://localhost'; $__allow[]='http://localhost:8080'; } // dev origins only when not in production
if(($__d=getenv('SITE_DOMAIN'))) $__allow[]='https://'.$__d;
if($__origin && in_array($__origin,$__allow,true)){
  header('Access-Control-Allow-Origin: '.$__origin);
  header('Vary: Origin');
  header('Access-Control-Allow-Credentials: true');
  header('Access-Control-Allow-Headers: Content-Type, X-Idempotency-Key');
  header('Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS');
}
if(($_SERVER['REQUEST_METHOD']??'')==='OPTIONS'){ http_response_code(204); exit; }
// CSRF defence: a browser CSRF attack always sends an Origin header; reject cross-origin state changes.
// (No Origin header at all = non-browser client, e.g. cron/curl — not a CSRF vector, allowed.)
$__method=$_SERVER['REQUEST_METHOD']??'GET';
if(in_array($__method,['POST','PUT','PATCH','DELETE'],true) && $__origin!=='' && !in_array($__origin,$__allow,true)){
  http_response_code(403); header('Content-Type: application/json'); echo json_encode(['error'=>'cross-origin request blocked']); exit;
}
$__secure=(!empty($_SERVER['HTTPS'])||($_SERVER['HTTP_X_FORWARDED_PROTO']??'')==='https');
if(is_dir('/var/adhere-sessions') && is_writable('/var/adhere-sessions')) session_save_path('/var/adhere-sessions'); // persist across container rebuilds
session_set_cookie_params(['httponly'=>true,'samesite'=>$__secure?'None':'Lax','secure'=>$__secure]);
session_start();
header('Content-Type: application/json');
function body(){ $b=json_decode(file_get_contents('php://input'), true); return is_array($b)?$b:[]; }
function out($d, $code=200){
  // Settle the idempotency claim taken by idem_guard().
  //   success -> mark 'done' and STORE the response, so a client that lost the original reply and
  //              retries gets the SAME answer back (including the new row's id) instead of a bare
  //              {duplicate:true}, which it could not use to navigate to the record it just created.
  //   failure -> RELEASE the claim, so a write that genuinely failed can be retried.
  if(!empty($GLOBALS['__idem_key'])){
    $k=$GLOBALS['__idem_key']; $GLOBALS['__idem_key']=null;
    try{
      if($code<300) db()->prepare("UPDATE idem_keys SET state='done', response=? WHERE k=?")->execute([json_encode($d),$k]);
      else          db()->prepare("DELETE FROM idem_keys WHERE k=? AND state='pending'")->execute([$k]);
    }catch(\PDOException $e){}
  }
  http_response_code($code); echo json_encode($d); exit;
}
function err($m,$code=400){ out(['error'=>$m], $code); }
function user(){ return $_SESSION['user'] ?? null; }
function require_auth(){ $u=user(); if(!$u) err('auth required',401); return $u; }
// A super_admin satisfies every gate an admin satisfies. Without this, promoting the system owner
// to super_admin would lock them out of every route that says require_role(['provider','admin']).
// It does NOT work the other way round: an admin never satisfies a super_admin gate.
function is_super($u=null){ $u=$u??user(); return ($u['role']??'')==='super_admin'; }
function require_role($roles){
  $u=require_auth(); $roles=(array)$roles;
  if(in_array($u['role'],$roles,true)) return $u;
  if($u['role']==='super_admin' && in_array('admin',$roles,true)) return $u;
  err('forbidden',403);
}
// The facility a caller is allowed to administer. A super_admin may name any facility; anyone else
// gets their own, whatever they asked for. This is the single choke point for the users route.
function admin_facility_scope($u, $requested=null){
  if(is_super($u)) return $requested!==null && $requested!=='' ? (int)$requested : (int)$u['facility_id'];
  return (int)$u['facility_id'];
}
function audit($action,$entity=null,$entity_id=null,$detail=null){
  $u=user(); $st=db()->prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail_json,ip_address) VALUES(?,?,?,?,?,?)");
  $st->execute([$u['id']??null,$action,$entity,$entity_id,$detail?json_encode($detail):null,$_SERVER['REMOTE_ADDR']??null]);
}
// Generic insert helper (whitelisted columns per table done by caller)
// THE CHOKE POINT FOR EVERY CLINICAL WRITE. Every POST/PATCH of an observation, visit, delivery,
// baby, referral, checklist item or vital passes through require_ep(). Rejecting a VOIDED episode
// here means a voided record cannot be written to from anywhere — including a device that was
// offline when it was voided and replays its queue afterwards. It reads as "not found", which is
// exactly what it is now.
function ep_facility_ok($eid){
  $u=user(); if(!$u) return false;
  $st=db()->prepare("SELECT facility_id, voided FROM episodes WHERE id=?");
  $st->execute([$eid]); $r=$st->fetch();
  return $r && $r['facility_id']==$u['facility_id'] && (int)($r['voided']??0)===0;
}
function require_ep($eid){ if(!ep_facility_ok($eid)) err('not found',404); }
// Facilities this user may READ across (aggregate). Supervisors widen by scope; others = own facility.
function scoped_facility_ids($u){
  if(($u['role']??'')==='supervisor'){
    $scope=$u['scope']??'facility';
    $f=db()->prepare("SELECT woreda,zone,region FROM facilities WHERE id=?"); $f->execute([$u['facility_id']]); $row=$f->fetch();
    if($row){
      if($scope==='woreda' && $row['woreda']!==null){ $q=db()->prepare("SELECT id FROM facilities WHERE woreda<=>?"); $q->execute([$row['woreda']]); }
      elseif($scope==='zone' && $row['zone']!==null){ $q=db()->prepare("SELECT id FROM facilities WHERE zone<=>?"); $q->execute([$row['zone']]); }
      elseif($scope==='region' && $row['region']!==null){ $q=db()->prepare("SELECT id FROM facilities WHERE region<=>?"); $q->execute([$row['region']]); }
      else { return [(int)$u['facility_id']]; }
      $ids=array_map(function($r){return (int)$r['id'];}, $q->fetchAll());
      return $ids?:[(int)$u['facility_id']];
    }
  }
  return [(int)$u['facility_id']];
}
// Idempotency: if the client sends a stable X-Idempotency-Key (used for offline-queued writes),
// record it once; a replay of the same key short-circuits so a lost-response write can't double-commit.
// Idempotency. The client sends a stable X-Idempotency-Key with every write, so a queued entry that
// is replayed — because the response was lost, or because two flushes raced — cannot double-commit.
//
// This USED TO BE check-then-act: SELECT the key, and if absent, write the clinical row and only
// then record the key. Nothing sat between the check and the claim, so two concurrent replays of the
// same key both passed the SELECT and both inserted. Duplicate episode. Duplicate visit. Phantom twin
// in the delivery register. The guard did not guard.
//
// Now the key is CLAIMED FIRST, atomically, on idem_keys' primary key. Whoever wins the INSERT owns
// the write; the loser returns the winner's answer without touching the clinical tables.
function idem_guard(){
  $k=$_SERVER['HTTP_X_IDEMPOTENCY_KEY']??'';
  if($k==='' || strlen($k)>64) return;
  try{
    // Reclaim any 'pending' claim whose request died mid-write (PHP fatal, container restart),
    // otherwise that key would be poisoned for ever and the entry could never be sent.
    db()->prepare("DELETE FROM idem_keys WHERE k=? AND state='pending' AND at < (NOW() - INTERVAL 2 MINUTE)")->execute([$k]);

    $ins=db()->prepare("INSERT INTO idem_keys(k,at,state) VALUES(?,NOW(),'pending')");
    try{
      $ins->execute([$k]);                        // WON the race — we own this write
      $GLOBALS['__idem_key']=$k;                  // settled by out(): 'done' on success, released on failure
      if(mt_rand(1,50)===1) db()->exec("DELETE FROM idem_keys WHERE state='done' AND at < (NOW() - INTERVAL 30 DAY)");
      return;
    }catch(\PDOException $e){
      if(($e->errorInfo[1]??0)!==1062) throw $e;   // 1062 = duplicate key = someone else got here first
    }

    // LOST the race, or this is a genuine replay of a write that already committed.
    $st=db()->prepare("SELECT state,response FROM idem_keys WHERE k=?"); $st->execute([$k]);
    $row=$st->fetch();
    if($row && $row['state']==='done'){
      $prev=$row['response']?json_decode($row['response'],true):null;
      out(is_array($prev)?$prev:['duplicate'=>true], 200);   // hand back the ORIGINAL answer
    }
    // Still 'pending': an identical request is in flight right now. Do not write. Tell the client to
    // come back — flush() treats 5xx as "retry later" and keeps the entry queued, so nothing is lost.
    out(['error'=>'this entry is already being saved — retrying shortly'], 503);
  }catch(\PDOException $e){ return; }              // table missing pre-migration -> behave as before
}
// ================================================================================================
// HIGH RISK — ONE DEFINITION, IN ONE PLACE.
//
// There were two. The worklist (/episodes?flag=highrisk) resolved risk BY WOMAN and included severe
// hypertension (>=160/110) and any positive proteinuria. The dashboard (/overview) resolved it BY
// EPISODE and had neither arm. So the two disagreed in production — the dashboard said 12 high-risk
// women and the worklist listed 8 — and a provider had no way to tell which number was the lie.
//
// Resolving by WOMAN is the correct one: her risk follows her from her ANC episode into labour, and
// an episode-scoped rule loses it at exactly the moment it matters most. Both callers now use this.
//
// The expression assumes the query has `women w` in scope. It contains no user input.
function hr_sql(){
  $ancEx=function($cond){ return "EXISTS(SELECT 1 FROM anc_visits av JOIN episodes e2 ON e2.voided=0 AND e2.id=av.episode_id WHERE e2.woman_id=w.id AND ($cond))"; };
  $scrEx=function($cond){ return "EXISTS(SELECT 1 FROM anc_risk_screening a JOIN episodes e3 ON e3.voided=0 AND e3.id=a.episode_id WHERE e3.woman_id=w.id AND ($cond))"; };
  return "(w.prior_cs='yes' OR w.prior_stillbirth='yes' OR w.prior_pph='yes' OR w.prior_preeclampsia='yes' OR w.prior_obstructed='yes' OR w.chronic_htn='yes' OR w.diabetes='yes' OR w.cardiac_renal='yes'"
    ." OR (w.age IS NOT NULL AND (w.age<19 OR w.age>35)) OR w.pregnancy_planned=0 OR w.rh_factor='neg' OR w.hiv_known_positive=1"
    ." OR ".$ancEx("av.anaemia_grade IN ('moderate','severe') OR av.muac_flag=1")
    ." OR ".$ancEx("av.bp_systolic>=160 OR av.bp_diastolic>=110")
    ." OR ".$ancEx("av.urine_protein IN ('+','++','+++')")
    ." OR ".$scrEx("a.response='yes'")
    .")";
}

// ================================================================================================
// MEASUREMENT RANGES — ENFORCED HERE, NOT ONLY IN THE BROWSER.
//
// A clinician typed a height of 1700000. The browser now stops that; the SERVER did not, and the
// server is the only thing that actually protects the record. Anything that reaches the API by any
// other path — a queued write replayed after an app update, a stale tablet running an older build,
// a bad merge in the form code — could still store it. Three women in production carry heights of
// 65, 45 and 55 cm, which is how we know this is not hypothetical.
//
// It matters beyond tidiness: height feeds BMI, weight and BP feed the risk model, and a number like
// 1700000 does not produce a wrong score so much as a meaningless one.
//
// Bounds are deliberately GENEROUS — the job is to reject the impossible, not to second-guess an
// unusual patient. Zero is a real reading for some of these (fetal heart, contractions, APGAR), so
// the floor is 0 where that is clinically true, and empty/NULL always passes: "not measured" is a
// legitimate answer and must never be blocked.
// ================================================================================================
// EVERY KEY BELOW MUST BE A REAL COLUMN NAME. check_ranges() looks the key up in the row it was given,
// so a key that matches no column is a bound that can never fire — and it is invisible, because the
// browser maps its own field ids onto these names and validates locally, so the form looks protected.
// Four of them were wrong (`fundal_height` vs fundal_height_cm, `fetal_heart` vs fetal_heart_rate,
// `contractions` vs contractions_per10, `cd4` vs cd4_count) and one (`hours_labour`) named no column at
// all: on the server, none of those five had ever rejected anything.
function ranges(){
  return [
    'height_cm'=>[120,200,'Height (cm)'],        'weight_kg'=>[30,200,'Weight (kg)'],
    'age'=>[10,60,'Age'],                        'ga_weeks'=>[4,43,'Gestational age (weeks)'],
    'bp_systolic'=>[60,250,'Systolic BP'],       'bp_diastolic'=>[30,160,'Diastolic BP'],
    'pulse'=>[30,200,'Pulse'],                   'temperature'=>[30,43,'Temperature (°C)'],
    'resp_rate'=>[6,60,'Respiratory rate'],      'spo2'=>[50,100,'SpO2 (%)'],
    'fundal_height_cm'=>[10,45,'Fundal height (cm)'], 'fetal_heart_rate'=>[0,220,'Fetal heart rate'],
    'hgb'=>[3,20,'Haemoglobin'],                 'muac'=>[10,45,'MUAC (cm)'],
    // labour monitoring (Labour Care Guide, and the legacy partograph rows)
    'cervix_cm'=>[0,10,'Cervical dilatation'],   'contractions_per10'=>[0,10,'Contractions / 10 min'],
    'hours_since_active'=>[0,48,'Hours in active labour'],
    'oxytocin_units'=>[0,100,'Oxytocin (units)'], 'oxytocin_drops'=>[0,120,'Oxytocin (drops/min)'],
    // LCG additions. `fhr_baseline` is the LCG's name for what the partograph called fetal_heart_rate;
    // both are bounded, because the model reads whichever one exists.
    'fhr_baseline'=>[0,220,'Fetal heart rate'],
    'contraction_dur_sec'=>[0,180,'Duration of contractions (seconds)'],
    'descent_fifths'=>[0,5,'Descent (fifths palpable)'],
    'apgar_1min'=>[0,10,'APGAR (1 min)'],
    'apgar_5min'=>[0,10,'APGAR (5 min)'],        'weight_g'=>[300,6000,'Birth weight (g)'],
    'blood_loss_ml'=>[0,5000,'Blood loss (ml)'], 'td_dose_no'=>[1,5,'TD dose'],
    'ifa_tabs'=>[0,200,'IFA tablets'],           'gravida'=>[0,20,'Gravida'],
    'para'=>[0,20,'Para'],
    // POSTNATAL VITALS. The whole postnatal vitals set — mother and newborn — had no server bound at
    // all: the columns are prefixed m_/nb_ and nothing in this table matched them. A postnatal
    // temperature of 400 or a newborn weighing 30 kg would have been stored without complaint, and
    // puerperal sepsis is diagnosed on exactly these numbers.
    'm_temp'=>[30,43,'Temperature (°C)'],        'm_pulse'=>[30,200,'Pulse'],
    'm_bp_systolic'=>[60,250,'Systolic BP'],     'm_bp_diastolic'=>[30,160,'Diastolic BP'],
    'nb_temp'=>[30,43,'Newborn temperature (°C)'],'nb_weight_g'=>[300,8000,'Newborn weight (g)'],
    // `viral_load` IS NOT A NUMBER and must never be listed here. The ANC contact stores
    // suppressed/unsuppressed/pending/not_done and the PMTCT follow-up stores undetectable/detectable.
    // While it was in this table, check_ranges() refused the whole write with "Viral load must be a
    // number" — so a PMTCT viral-load follow-up could not be saved at all, and vl_suppressed on the
    // facility dashboard could never be populated. The numeric copies/mL is a different column.
    'vl_value'=>[0,10000000,'Viral load (copies/mL)'],
    'cd4_count'=>[0,2000,'CD4 count'],
    // PRECONCEPTION CARE. These are the numbers the guideline's advice actually turns on — the folic
    // acid dose, "contraception until fasting glucose is 80-110", the WHO cardiac class, severe renal
    // disease. A mistyped creatinine of 31 instead of 3.1 does not just look wrong, it changes what
    // the woman is told, so it is refused at the door and not merely in the browser.
    //
    // `height_cm` and `weight_kg` ARE DELIBERATELY NOT REDECLARED HERE. They are already bounded at the
    // top of this table (120-200 cm, 30-200 kg) and those bounds are the right ones for an adult woman
    // — which is who a preconception client is. A PHP array literal silently keeps the LAST duplicate
    // key, so re-declaring them here to "widen for PCC" quietly widened them for REGISTRATION and for
    // EVERY ANC CONTACT as well, and nothing would have warned us. One column, one bound, declared once.
    'bmi'=>[10,70,'BMI'],                        // also guards anc_visits.bmi, which is derived
    'dm_fbs'=>[20,600,'Fasting blood glucose (mg/dL)'],
    'dm_hba1c'=>[3,20,'HbA1c (%)'],
    'creatinine'=>[0.1,20,'Creatinine (mg/dL)'],
    'coffee_cups'=>[0,30,'Cups of coffee per day'],
    'activity_min_week'=>[0,2000,'Physical activity (min/week)'],
    'td_doses'=>[0,5,'Td doses'],                'hbv_vaccine_doses'=>[0,3,'Hepatitis B vaccine doses'],
    'parity'=>[0,20,'Parity'],
  ];
}
// The woman-level equivalent of require_ep(). Preconception care is NOT an episode — it happens
// before there is a pregnancy to have an episode of — so it needs its own choke point, and it needs
// the same two properties: she must belong to the caller's facility, and she must not be voided. A
// tablet that was offline when a record was voided will replay its queue afterwards, and this is
// what stops that replay from writing to a record that no longer exists.
function woman_facility_ok($wid){
  $u=user(); if(!$u) return false;
  $st=db()->prepare("SELECT facility_id, voided FROM women WHERE id=?");
  $st->execute([$wid]); $r=$st->fetch();
  return $r && $r['facility_id']==$u['facility_id'] && (int)($r['voided']??0)===0;
}
function require_woman($wid){ if(!woman_facility_ok($wid)) err('not found',404); }

// THE CONTRACEPTION SHE ACCEPTED AFTER A PREGNANCY LOSS MUST REACH THE FAMILY PLANNING REGISTER.
// Otherwise the implant she is walking out with is invisible to the FP room and she cannot be followed
// up or removed from. Called from BOTH the abortion POST and the PATCH — the method is often decided as
// a correction after the loss is first recorded, and the PATCH path used to drop it on the floor.
// Dedup: fp_visits has no unique key, so a second save / a replay would double-count the method mix.
// One post-abortion FP visit per abortion care_date is the guard.
function abortion_to_fp(array $row, array $u): void {
  $meth = $row['pac_fp_method'] ?? null;
  if(!$meth || $meth==='none') return;
  $wid = woman_of_episode((int)($row['episode_id']??0)); if(!$wid) return;
  $w = db()->prepare("SELECT mrn, TRIM(CONCAT_WS(' ',first_name,father_name)) nm, age FROM women WHERE id=?");
  $w->execute([$wid]); $wr = $w->fetch(); if(!$wr) return;
  $care = $row['care_date'] ?? date('Y-m-d');
  $c = db()->prepare("SELECT id FROM fp_clients WHERE woman_id=? AND facility_id=?");
  $c->execute([$wid,(int)$u['facility_id']]); $cr = $c->fetch();
  $cid = $cr ? (int)$cr['id'] : (int)insert('fp_clients',[
    'facility_id'=>(int)$u['facility_id'],'woman_id'=>$wid,'mrn'=>$wr['mrn'],'name'=>$wr['nm'],
    'age'=>$wr['age'],'sex'=>'F','reg_date'=>$care,'acceptor'=>'new']);
  // Already recorded this post-abortion visit? Update the method rather than add a second row.
  $ex = db()->prepare("SELECT id FROM fp_visits WHERE fp_client_id=? AND visit_date=? AND remark LIKE 'accepted after a pregnancy loss%'");
  $ex->execute([$cid,$care]); $old = $ex->fetch();
  if($old){ db()->prepare("UPDATE fp_visits SET method=? WHERE id=?")->execute([$meth,(int)$old['id']]); return; }
  insert('fp_visits',['fp_client_id'=>$cid,'visit_date'=>$care,'method'=>$meth,
    'remark'=>'accepted after a pregnancy loss (post-abortion care)','recorded_by'=>$u['id']]);
}

// PCC uptake status (MoH PCC guideline, Table 8), derived on the server whatever the client sent:
//   none    = none of the fifteen components
//   partial = at least one
//   optimal = folic acid PLUS at least one other
// Written exactly as the guideline states it. This is a national indicator: a helpful
// reinterpretation of it is just a wrong number that agrees with itself.
function pcc_uptake_items(){
  return ['i1_family_planning','i2_nutrition_bmi','i3_folic_acid','i4_chronic_disease','i5_substance_use',
          'i6_physical_activity','i7_repro_cxca','i8_sexual_gbv_fgm','i9_infectious','i10_vaccine',
          'i11_genetic','i12_medication','i13_mental_health','i14_environmental','i15_dental'];
}
function pcc_uptake_status(array $b){
  $yes=0;
  foreach(pcc_uptake_items() as $k){ if(isset($b[$k]) && $b[$k]!==null && $b[$k]!=='' && $b[$k]!=='0' && (int)$b[$k]===1) $yes++; }
  if(!$yes) return 'none';
  $folate = isset($b['i3_folic_acid']) && (int)$b['i3_folic_acid']===1;
  return ($folate && $yes>=2) ? 'optimal' : 'partial';
}
// Rejects a row that carries an impossible measurement. Call it BEFORE the insert/update.
//
// $skip exists because the same COLUMN NAME does not always mean the same THING. `age` on a woman is
// a mother's age (10-60). `age` on an immunization client is an INFANT (0) or an HPV girl (9-14) —
// applying the maternal bound there would have refused every child in the immunization register.
// So the generic clinical handler skips `age`, and it is enforced on the woman record, where it is
// unambiguous and where it feeds the risk flag.
function check_ranges(array $row, array $skip=[]){
  foreach(ranges() as $col=>[$min,$max,$label]){
    if(in_array($col,$skip,true)) continue;
    if(!array_key_exists($col,$row)) continue;
    $v=$row[$col];
    if($v===null || $v==='' ) continue;                       // "not measured" is a valid answer
    if(!is_numeric($v)) err("$label must be a number.");
    $n=$v+0;
    // Echo the number back EXACTLY as it was typed. (A naive rtrim of trailing zeros turns 1700000
    // into "17" — which makes the one message the clinician needs to understand a nonsense.)
    if($n<$min || $n>$max){
      $shown = (floor($n)==$n && abs($n)<1e15) ? (string)(int)$n : rtrim(rtrim(number_format($n,2,'.',''),'0'),'.');
      err("$label must be between $min and $max. You entered $shown.");
    }
  }
  // A diastolic at or above the systolic is a transposition or a typo, never a reading.
  // Checked on BOTH BP pairs: the postnatal columns are m_bp_* and were not covered.
  foreach([['bp_systolic','bp_diastolic'],['m_bp_systolic','m_bp_diastolic']] as [$sys,$dia]){
    if(isset($row[$sys],$row[$dia]) && is_numeric($row[$sys]) && is_numeric($row[$dia])
       && $row[$sys]!=='' && $row[$dia]!=='' && ($row[$dia]+0) >= ($row[$sys]+0)){
      err('Diastolic BP must be lower than systolic BP.');
    }
  }
}
// An empty string is not a measurement — it is "not measured", which is NULL. MySQL in strict mode
// rejects '' for a numeric column, so a provider clearing a field she filled in by mistake got an
// opaque "one of the values is not valid" instead of a cleared field.
function blank_to_null(array $row){
  foreach(ranges() as $col=>$x){ if(array_key_exists($col,$row) && $row[$col]==='') $row[$col]=null; }
  return $row;
}
function insert($table,$data){
  $cols=array_keys($data); $ph=implode(',',array_fill(0,count($cols),'?'));
  $sql="INSERT INTO `$table` (`".implode('`,`',$cols)."`) VALUES ($ph)";
  db()->prepare($sql)->execute(array_values($data));
  return db()->lastInsertId();
}
