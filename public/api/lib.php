<?php
// CORS for the Android/native app origins (credentialed) + preflight
$__origin=$_SERVER['HTTP_ORIGIN']??'';
$__allow=['https://localhost','capacitor://localhost','http://localhost','http://localhost:8080'];
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
function out($d, $code=200){ http_response_code($code); echo json_encode($d); exit; }
function err($m,$code=400){ out(['error'=>$m], $code); }
function user(){ return $_SESSION['user'] ?? null; }
function require_auth(){ $u=user(); if(!$u) err('auth required',401); return $u; }
function require_role($roles){ $u=require_auth(); if(!in_array($u['role'],(array)$roles)) err('forbidden',403); return $u; }
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
function idem_guard(){
  $k=$_SERVER['HTTP_X_IDEMPOTENCY_KEY']??'';
  if($k==='' || strlen($k)>64) return;
  try{ db()->prepare("INSERT INTO idem_keys(k) VALUES(?)")->execute([$k]); }
  catch(\PDOException $e){ if($e->getCode()==='23000'){ out(['duplicate'=>true],200); } /* else: table missing -> ignore */ }
}
function insert($table,$data){
  $cols=array_keys($data); $ph=implode(',',array_fill(0,count($cols),'?'));
  $sql="INSERT INTO `$table` (`".implode('`,`',$cols)."`) VALUES ($ph)";
  db()->prepare($sql)->execute(array_values($data));
  return db()->lastInsertId();
}
