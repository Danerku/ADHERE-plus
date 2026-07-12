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
function ep_facility_ok($eid){ $u=user(); if(!$u)return false; $st=db()->prepare("SELECT facility_id FROM episodes WHERE id=?"); $st->execute([$eid]); $r=$st->fetch(); return $r && $r['facility_id']==$u['facility_id']; }
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
function insert($table,$data){
  $cols=array_keys($data); $ph=implode(',',array_fill(0,count($cols),'?'));
  $sql="INSERT INTO `$table` (`".implode('`,`',$cols)."`) VALUES ($ph)";
  db()->prepare($sql)->execute(array_values($data));
  return db()->lastInsertId();
}
