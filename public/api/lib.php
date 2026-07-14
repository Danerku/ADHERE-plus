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
function ranges(){
  return [
    'height_cm'=>[120,200,'Height (cm)'],        'weight_kg'=>[30,200,'Weight (kg)'],
    'age'=>[10,60,'Age'],                        'ga_weeks'=>[4,43,'Gestational age (weeks)'],
    'bp_systolic'=>[60,250,'Systolic BP'],       'bp_diastolic'=>[30,160,'Diastolic BP'],
    'pulse'=>[30,200,'Pulse'],                   'temperature'=>[30,43,'Temperature (°C)'],
    'resp_rate'=>[6,60,'Respiratory rate'],      'spo2'=>[50,100,'SpO2 (%)'],
    'fundal_height'=>[10,45,'Fundal height (cm)'],'fetal_heart'=>[0,220,'Fetal heart rate'],
    'hgb'=>[3,20,'Haemoglobin'],                 'muac'=>[10,45,'MUAC (cm)'],
    'cervix_cm'=>[0,10,'Cervical dilatation'],   'contractions'=>[0,10,'Contractions / 10 min'],
    'hours_labour'=>[0,48,'Hours in labour'],    'apgar_1min'=>[0,10,'APGAR (1 min)'],
    'apgar_5min'=>[0,10,'APGAR (5 min)'],        'weight_g'=>[300,6000,'Birth weight (g)'],
    'blood_loss_ml'=>[0,5000,'Blood loss (ml)'], 'td_dose_no'=>[1,5,'TD dose'],
    'ifa_tabs'=>[0,200,'IFA tablets'],           'gravida'=>[0,20,'Gravida'],
    'para'=>[0,20,'Para'],
    // `viral_load` IS NOT A NUMBER and must never be listed here. The ANC contact stores
    // suppressed/unsuppressed/pending/not_done and the PMTCT follow-up stores undetectable/detectable.
    // While it was in this table, check_ranges() refused the whole write with "Viral load must be a
    // number" — so a PMTCT viral-load follow-up could not be saved at all, and vl_suppressed on the
    // facility dashboard could never be populated. The numeric copies/mL is a different column.
    'vl_value'=>[0,10000000,'Viral load (copies/mL)'],
    'cd4_count'=>[0,2000,'CD4 count'],
  ];
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
  if(isset($row['bp_systolic'],$row['bp_diastolic']) && is_numeric($row['bp_systolic']) && is_numeric($row['bp_diastolic'])
     && $row['bp_systolic']!=='' && $row['bp_diastolic']!=='' && ($row['bp_diastolic']+0) >= ($row['bp_systolic']+0)){
    err('Diastolic BP must be lower than systolic BP.');
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
