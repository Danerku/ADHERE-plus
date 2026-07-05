<?php
require __DIR__.'/lib.php'; require __DIR__.'/db.php';
$m = $_SERVER['REQUEST_METHOD'];
$path = trim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
$path = preg_replace('#^.*api/#','',$path);           // normalise to route after /api/
$parts = explode('/', $path);
$r = $parts[0] ?? '';
$id = $parts[1] ?? null;

try {
  // ---- auth ----
  if ($r==='login' && $m==='POST'){
    $b=body(); $st=db()->prepare("SELECT u.*, f.name AS facility_name FROM users u LEFT JOIN facilities f ON f.id=u.facility_id WHERE u.username=? AND u.is_active=1");
    $st->execute([$b['username']??'']); $u=$st->fetch();
    if(!$u || !password_verify($b['password']??'', $u['password_hash'])) err('invalid credentials',401);
    unset($u['password_hash']); session_regenerate_id(true); $_SESSION['user']=$u;
    db()->prepare("UPDATE users SET last_login=NOW() WHERE id=?")->execute([$u['id']]);
    audit('login','users',$u['id']); out(['user'=>$u]);
  }
  if ($r==='logout'){ audit('logout'); $_SESSION=[]; session_destroy(); out(['ok'=>true]); }
  if ($r==='me'){ out(['user'=>user()]); }
  require_auth(); // everything below requires a session

  // ---- users (admin only) ----
  if ($r==='users'){ require_role(['admin']);
    if($m==='GET'){ $st=db()->query("SELECT id,username,full_name,role,cadre,facility_id,is_active,last_login FROM users ORDER BY id"); out($st->fetchAll()); }
    if($m==='POST'){ $b=body();
      if(empty($b['username'])||empty($b['password'])||empty($b['role'])) err('username, password and role are required');
      if(!in_array($b['role'],['recorder','provider','observer','admin'])) err('invalid role');
      $me=user(); $ex=db()->prepare("SELECT id FROM users WHERE username=?"); $ex->execute([$b['username']]); if($ex->fetch()) err('username already taken',409);
      $nid=insert('users',['username'=>$b['username'],'password_hash'=>password_hash($b['password'],PASSWORD_DEFAULT),'full_name'=>$b['full_name']??$b['username'],'role'=>$b['role'],'cadre'=>$b['cadre']??null,'facility_id'=>$b['facility_id']??$me['facility_id']]);
      audit('create_user','users',$nid); out(['id'=>$nid],201); }
    if($m==='PATCH' && $id){ $b=body(); $me=user();
      if(isset($b['is_active'])){ if((int)$id===(int)$me['id'] && !$b['is_active']) err('you cannot deactivate your own account'); db()->prepare("UPDATE users SET is_active=? WHERE id=?")->execute([$b['is_active']?1:0,$id]); }
      if(isset($b['role']) && in_array($b['role'],['recorder','provider','observer','admin'])){ db()->prepare("UPDATE users SET role=? WHERE id=?")->execute([$b['role'],$id]); }
      if(!empty($b['password'])){ db()->prepare("UPDATE users SET password_hash=? WHERE id=?")->execute([password_hash($b['password'],PASSWORD_DEFAULT),$id]); }
      audit('update_user','users',$id); out(['ok'=>true]); }
  }
  if ($r==='facilities'){ require_role(['admin']);
    if($m==='GET'){ out(db()->query("SELECT id,name,facility_type,kebele,woreda,zone,region,dhis2_org_unit FROM facilities ORDER BY id")->fetchAll()); }
    if($m==='POST'){ $b=body();
      if(empty($b['name'])) err('facility name is required');
      $ft=in_array($b['facility_type']??'',['primary_hospital','health_center','general_hospital','other'])?$b['facility_type']:'health_center';
      $nid=insert('facilities',['name'=>$b['name'],'facility_type'=>$ft,'kebele'=>$b['kebele']??null,'woreda'=>$b['woreda']??null,'zone'=>$b['zone']??null,'region'=>$b['region']??'Amhara','dhis2_org_unit'=>$b['dhis2_org_unit']??null]);
      audit('create_facility','facilities',$nid); out(['id'=>$nid],201); }
    if($m==='PATCH' && $id){ $b=body();
      if(isset($b['facility_type']) && !in_array($b['facility_type'],['primary_hospital','health_center','general_hospital','other'])) unset($b['facility_type']);
      $fields=array_intersect_key($b,array_flip(['name','facility_type','kebele','woreda','zone','region','dhis2_org_unit']));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE facilities SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      audit('update_facility','facilities',$id); out(['ok'=>true]); }
    if($m==='DELETE' && $id){
      $uc=db()->prepare("SELECT COUNT(*) c FROM users WHERE facility_id=?"); $uc->execute([$id]);
      $wc=db()->prepare("SELECT COUNT(*) c FROM women WHERE facility_id=?"); $wc->execute([$id]);
      if(($uc->fetch()['c']??0)>0 || ($wc->fetch()['c']??0)>0) err('facility still has users or patients — reassign them first',409);
      db()->prepare("DELETE FROM facilities WHERE id=?")->execute([$id]);
      audit('delete_facility','facilities',$id); out(['ok'=>true]); }
  }

  // ---- self-service password change (any logged-in user) ----
  if ($r==='password' && $m==='POST'){ $u=user(); $b=body();
    if(empty($b['current'])||empty($b['new'])) err('current and new password required');
    if(strlen($b['new'])<6) err('new password must be at least 6 characters');
    $st=db()->prepare("SELECT password_hash FROM users WHERE id=?"); $st->execute([$u['id']]); $row=$st->fetch();
    if(!$row || !password_verify($b['current'],$row['password_hash'])) err('current password is incorrect',403);
    db()->prepare("UPDATE users SET password_hash=? WHERE id=?")->execute([password_hash($b['new'],PASSWORD_DEFAULT),$u['id']]);
    audit('change_own_password','users',$u['id']); out(['ok'=>true]); }

  // ---- women (registration) ----
  if ($r==='women'){
    if($m==='GET' && $id){ $u=user(); $st=db()->prepare("SELECT * FROM women WHERE id=? AND facility_id=?"); $st->execute([$id,$u['facility_id']]); out($st->fetch()?:[]); }
    if($m==='GET'){ $u=user(); $q='%'.($_GET['q']??'').'%'; $st=db()->prepare("SELECT * FROM women WHERE facility_id=? AND (mrn LIKE ? OR first_name LIKE ?) ORDER BY id DESC LIMIT 100"); $st->execute([$u['facility_id'],$q,$q]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['recorder','admin']); $b=body(); $b['created_by']=$u['id']; $b['facility_id']=$u['facility_id'];
      $wid=insert('women',array_intersect_key($b,array_flip(['mrn','first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','children_alive','lnmp','edd','facility_id','created_by'])));
      audit('create','women',$wid); out(['id'=>$wid],201); }
    if($m==='PATCH' && $id){ $u=require_role(['recorder','admin']); $b=body();
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $wc->execute([$id,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      $fields=array_intersect_key($b,array_flip(['first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','children_alive','lnmp','edd']));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE women SET `$k`=? WHERE id=?")->execute([$v,$id]); } audit('update','women',$id,array_keys($fields)); out(['ok'=>true]); }
  }

  // ---- providers list (for handover picker; any logged-in user) ----
  if ($r==='providers' && $m==='GET'){ $u=user(); $st=db()->prepare("SELECT id,full_name,role FROM users WHERE is_active=1 AND role IN ('provider','admin') AND facility_id=? ORDER BY full_name"); $st->execute([$u['facility_id']]); out($st->fetchAll()); }

  // ---- episodes ----
  if ($r==='episodes'){
    if($m==='GET'){ $u=user(); $cat=$_GET['category']??null; $sql="SELECT e.*, w.first_name,w.father_name,w.mrn,w.gravida,w.para,w.age,w.lnmp,w.edd FROM episodes e JOIN women w ON w.id=e.woman_id WHERE e.facility_id=?";
      $args=[$u['facility_id']]; if($cat){ $sql.=" AND e.service_category=?"; $args[]=$cat; } $sql.=" ORDER BY e.id DESC LIMIT 200";
      $st=db()->prepare($sql); $st->execute($args); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $wc->execute([$b['woman_id']??0,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      $b['created_by']=$u['id']; $b['facility_id']=$u['facility_id'];
      $eid=insert('episodes',array_intersect_key($b,array_flip(['woman_id','service_category','status','provider_id','admitted_from','ruptured_membrane','admission_datetime','facility_id','created_by'])));
      audit('create','episodes',$eid); out(['id'=>$eid],201); }
    if($m==='PATCH' && $id){ require_role(['recorder','provider','admin']); require_ep($id); $b=body(); $fields=array_intersect_key($b,array_flip(['status','provider_id']));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE episodes SET `$k`=? WHERE id=?")->execute([$v,$id]); } audit('update','episodes',$id,$fields); out(['ok'=>true]); }
  }

  // ---- partograph observations ----
  if ($r==='observations'){
    if($m==='GET'){ require_ep($_GET['episode']??0); $st=db()->prepare("SELECT * FROM partograph_obs WHERE episode_id=? ORDER BY obs_datetime"); $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['provider','admin']); $b=body(); require_ep($b['episode_id']??0); $b['recorded_by']=$u['id'];
      $oid=insert('partograph_obs',array_intersect_key($b,array_flip(['episode_id','obs_datetime','hours_since_active','fetal_heart_rate','amniotic_fluid','moulding','cervix_cm','descent_head','contractions_per10','contraction_strength','oxytocin_units','oxytocin_drops','drugs_iv_fluids','bp_systolic','bp_diastolic','pulse','temperature','urine_protein','urine_acetone','urine_volume','recorded_by'])));
      audit('create_obs','partograph_obs',$oid); out(['id'=>$oid],201); }
  }

  // ---- AI risk score (server-stored; scoring done on-device) ----
  if ($r==='risk_scores' && $m==='POST'){ $u=require_role(['provider','admin']); $b=body(); require_ep($b['episode_id']??0); $b=array_intersect_key($b,array_flip(['episode_id','obs_id','model_version','probability','band','features_json','provider_ack','override_reason']));
    if(isset($b['features_json'])&&is_array($b['features_json'])) $b['features_json']=json_encode($b['features_json']);
    $sid=insert('risk_scores',$b); audit('risk_score','risk_scores',$sid,['band'=>$b['band']??null]); out(['id'=>$sid],201); }

  if ($r==='risk_scores' && $m==='PATCH' && $id){ require_role(['provider','admin']);
    $q=db()->prepare("SELECT episode_id FROM risk_scores WHERE id=?"); $q->execute([$id]); $sr=$q->fetch(); if(!$sr) err('not found',404); require_ep($sr['episode_id']);
    db()->prepare("UPDATE risk_scores SET provider_ack=1 WHERE id=?")->execute([$id]);
    audit('ack','risk_scores',$id); out(['ok'=>true]); }

  // ---- checklist / danger signs / delivery / anc screening / handover / messages ----
  $simple=['checklist'=>['checklist_responses',['episode_id','pause_point','item_code','response','recorded_by']],
           'danger_signs'=>['danger_signs',['episode_id','obs_datetime','headache','blurred_vision','epigastric_pain','dtr_grade','vaginal_bleeding','remark','recorded_by']],
           'delivery'=>['delivery_summary',['episode_id','delivery_datetime','mode','baby_weight_g','baby_sex','apgar_1min','apgar_5min','outcome','maternal_outcome','complications','recorded_by']],
           'anc_screening'=>['anc_risk_screening',['episode_id','item_code','item_group','response','recorded_by']],
           'handover'=>['handovers',['episode_id','from_provider_id','to_provider_id','note']],
           'referrals'=>['referrals',['episode_id','referred_to','reason','urgency','transport','feedback','recorded_by']],
           'anc_visits'=>['anc_visits',['episode_id','visit_date','ga_weeks','weight_kg','bp_systolic','bp_diastolic','fundal_height_cm','fetal_heart_rate','presentation','urine_protein','hgb','danger_note','next_appointment','recorded_by']],
           'pnc_visits'=>['pnc_visits',['episode_id','visit_date','pnc_day','m_temp','m_bp_systolic','m_bp_diastolic','m_pulse','bleeding','breast','mood','nb_temp','nb_feeding','cord','danger_note','recorded_by']],
           'babies'=>['babies',['episode_id','birth_order','sex','weight_g','apgar_1min','apgar_5min','resuscitated','outcome','note','recorded_by']],
           'maternal_vitals'=>['maternal_vitals',['episode_id','obs_datetime','bp_systolic','bp_diastolic','pulse','temperature','resp_rate','spo2','note','recorded_by']],
           'bemonc'=>['bemonc_care',['episode_id','item_code','response','note','recorded_by']],
           'messages'=>['messages',['episode_id','from_user_id','to_user_id','body']]];
  if(isset($simple[$r])){
    [$tbl,$allow]=$simple[$r];
    if($m==='GET'){ require_ep($_GET['episode']??0); $st=db()->prepare("SELECT * FROM `$tbl` WHERE episode_id=? ORDER BY id"); $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    if($m==='POST'){ $clin=['checklist_responses','danger_signs','delivery_summary','anc_risk_screening','referrals','anc_visits','pnc_visits','babies','maternal_vitals','bemonc_care']; $u = in_array($tbl,$clin)?require_role(['provider','admin']):require_auth(); $b=body();
      $rows = isset($b[0])?$b:[$b];  // accept single object or array (checklist batch)
      foreach($rows as $row){ require_ep($row['episode_id']??0); }
      $ids=[]; foreach($rows as $row){ if(in_array('recorded_by',$allow)) $row['recorded_by']=$u['id']; $ids[]=insert($tbl,array_intersect_key($row,array_flip($allow))); }
      audit('create',$tbl,$ids[0]??null); out(['ids'=>$ids],201); }
  }


  // ---- Module 4: operational intelligence (monthly time-series + anomaly flags) ----
  if ($r==='analytics' && $m==='GET'){ require_auth();
    $months=[]; for($i=5;$i>=0;$i--){ $months[]=date('Y-m', strtotime("-$i month")); }
    $series=function($sql) use($months){ $out=[]; foreach($months as $mo){ $st=db()->prepare($sql); $st->execute([$mo]); $out[]=(int)($st->fetch()['c']??0);} return $out; };
    $ind=[
      'deliveries'=>$series("SELECT COUNT(*) c FROM delivery_summary WHERE DATE_FORMAT(delivery_datetime,'%Y-%m')=?"),
      'red_alerts'=>$series("SELECT COUNT(*) c FROM risk_scores WHERE band='red' AND DATE_FORMAT(scored_at,'%Y-%m')=?"),
      'stillbirths'=>$series("SELECT COUNT(*) c FROM delivery_summary WHERE outcome='fresh_stillbirth' AND DATE_FORMAT(delivery_datetime,'%Y-%m')=?"),
      'partographs'=>$series("SELECT COUNT(DISTINCT episode_id) c FROM partograph_obs WHERE DATE_FORMAT(recorded_at,'%Y-%m')=?"),
    ];
    // EWMA anomaly flag: last point > mean + 2*std of the series
    $flags=[]; foreach($ind as $k=>$v){ $n=count($v); $mean=array_sum($v)/max(1,$n);
      $var=0; foreach($v as $x){$var+=($x-$mean)**2;} $sd=sqrt($var/max(1,$n));
      $flags[$k] = ($sd>0 && end($v) > $mean+2*$sd); }
    out(['months'=>$months,'indicators'=>$ind,'anomalies'=>$flags]);
  }

  // ---- DHIS2 indicator export (aggregate) ----
  if ($r==='dhis2' && $m==='GET'){ require_auth();
    $fac=$_GET['facility']??null; $period=$_GET['period']??date('Y-m');
    $one=function($sql,$p){ $st=db()->prepare($sql); $st->execute([$p]); return (int)($st->fetch()['c']??0); };
    $ind=[
      'deliveries'=>$one("SELECT COUNT(*) c FROM delivery_summary WHERE DATE_FORMAT(delivery_datetime,'%Y-%m')=?",$period),
      'fresh_stillbirths'=>$one("SELECT COUNT(*) c FROM delivery_summary WHERE outcome='fresh_stillbirth' AND DATE_FORMAT(delivery_datetime,'%Y-%m')=?",$period),
      'red_alerts'=>$one("SELECT COUNT(*) c FROM risk_scores WHERE band='red' AND DATE_FORMAT(scored_at,'%Y-%m')=?",$period),
    ];
    out(['facility'=>$fac,'period'=>$period,'indicators'=>$ind]);
  }

  // ---- FHIR-style Encounter export (interop sample) ----
  if ($r==='fhir' && $id){ require_ep($id);
    $st=db()->prepare("SELECT e.*,w.mrn,w.first_name,w.father_name FROM episodes e JOIN women w ON w.id=e.woman_id WHERE e.id=?"); $st->execute([$id]); $e=$st->fetch(); if(!$e) err('not found',404);
    out(['resourceType'=>'Encounter','id'=>"episode-$id",'status'=>$e['status'],
         'class'=>['code'=>strtoupper($e['service_category'])],
         'subject'=>['reference'=>'Patient/'.$e['mrn'],'display'=>trim($e['first_name'].' '.$e['father_name'])],
         'period'=>['start'=>$e['admission_datetime']]]);
  }

  // ---- offline sync (batch apply queued entries) ----
  if ($r==='sync' && $m==='POST'){ $u=require_role(['provider','admin']); $items=body()['items']??[]; $applied=[];
    foreach($items as $it){ $ep=$it['entity']??''; $payload=$it['payload']??[];
      $map=['observations'=>'partograph_obs','checklist'=>'checklist_responses','danger_signs'=>'danger_signs'];
      $sallow=['partograph_obs'=>['episode_id','obs_datetime','hours_since_active','fetal_heart_rate','moulding','cervix_cm','contractions_per10','bp_systolic','temperature','recorded_by'],'checklist_responses'=>['episode_id','pause_point','item_code','response','recorded_by'],'danger_signs'=>['episode_id','obs_datetime','headache','blurred_vision','epigastric_pain','dtr_grade','vaginal_bleeding','remark','recorded_by']];
      if(isset($map[$ep])){ require_ep($payload['episode_id']??0); $payload['recorded_by']=$u['id']; $payload=array_intersect_key($payload,array_flip($sallow[$map[$ep]])); $applied[]=['uuid'=>$it['client_uuid']??null,'id'=>insert($map[$ep],$payload)]; } }
    audit('sync',null,null,['count'=>count($applied)]); out(['applied'=>$applied]);
  }

  err('not found: '.$r, 404);
} catch (Throwable $ex) { error_log('ADHERE API: '.$ex->getMessage()); err('server error', 500); }
