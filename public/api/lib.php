<?php
// CORS for the Android/native app origins (credentialed) + preflight
$__origin=$_SERVER['HTTP_ORIGIN']??'';
$__allow=['https://localhost','capacitor://localhost','http://localhost','http://localhost:8080'];
if(($__d=getenv('SITE_DOMAIN'))) $__allow[]='https://'.$__d;
if($__origin && in_array($__origin,$__allow,true)){
  header('Access-Control-Allow-Origin: '.$__origin);
  header('Vary: Origin');
  header('Access-Control-Allow-Credentials: true');
  header('Access-Control-Allow-Headers: Content-Type');
  header('Access-Control-Allow-Methods: GET,POST,PATCH,OPTIONS');
}
if(($_SERVER['REQUEST_METHOD']??'')==='OPTIONS'){ http_response_code(204); exit; }
$__secure=(!empty($_SERVER['HTTPS'])||($_SERVER['HTTP_X_FORWARDED_PROTO']??'')==='https');
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
function insert($table,$data){
  $cols=array_keys($data); $ph=implode(',',array_fill(0,count($cols),'?'));
  $sql="INSERT INTO `$table` (`".implode('`,`',$cols)."`) VALUES ($ph)";
  db()->prepare($sql)->execute(array_values($data));
  return db()->lastInsertId();
}
