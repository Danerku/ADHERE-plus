<?php
require __DIR__.'/lib.php'; require __DIR__.'/db.php';

// =====================================================================================
// CONTINUUM LINKS
//
// A journey audit traced every path a woman can take through this tool and found that the
// modules did not talk to each other. Facts learned in one room stayed in that room:
//
//   * Risk screening was keyed to an EPISODE. When she moved from her ANC episode to a
//     labour episode, the high-risk rule and the AI model looked at the new episode, found
//     no screening, and she arrived on the labour ward with no risk flag. Her previous
//     caesarean was in the database the whole time, attached to a record nobody was reading.
//   * A positive HIV test was written onto the VISIT. At her next contact the tool offered
//     her an HIV test again, she never reached the high-risk worklist, and nothing ever
//     suggested PMTCT.
//   * A Td dose given in the ANC room never reached the Td register.
//   * An HIV-exposed baby recorded in the delivery room never reached the HEI cohort.
//
// These four functions are the links. They are called on write, so a fact learned anywhere
// lands on the person it belongs to and follows her.
// =====================================================================================

// Close an episode of care. The schema has always had `closed` and `closed_datetime`; nothing in
// the application ever wrote either, so no episode in ADHERE+ has ever ended. Closing is the ONLY
// thing that takes a woman off a worklist — it does not touch a single clinical row, and the whole
// record stays readable by id.
function close_episode(int $eid, string $why=''): void {
  db()->prepare("UPDATE episodes SET status='closed', closed_datetime=NOW() WHERE id=? AND status<>'closed'")
     ->execute([$eid]);
  audit('close','episodes',$eid,['why'=>$why]);
}
function woman_of_episode(int $eid): ?int {
  $q=db()->prepare("SELECT woman_id FROM episodes WHERE id=?"); $q->execute([$eid]);
  $r=$q->fetch(); return $r ? (int)$r['woman_id'] : null;
}

// ANC screening -> women.prior_*  (so risk follows her out of the ANC room)
function screening_to_woman(int $eid, array $rows): void {
  $wid = woman_of_episode($eid); if(!$wid) return;
  // Only the items that map to a person-level column. Everything else stays episode-scoped.
  $map=['OBS_PREV_CS'=>'prior_cs','OBS_PREV_STILLBIRTH'=>'prior_stillbirth','OBS_PREV_PPH'=>'prior_pph',
        'OBS_PREV_PREECLAMPSIA'=>'prior_preeclampsia','OBS_PREV_OBSTRUCTED'=>'prior_obstructed',
        'MED_CHRONIC_HTN'=>'chronic_htn','MED_DIABETES'=>'diabetes','MED_CARDIAC_RENAL'=>'cardiac_renal'];
  // These items are PERMANENT FACTS OF HER HISTORY. A previous caesarean does not stop having
  // happened; nor does a previous stillbirth, PPH, pre-eclampsia or obstructed labour.
  $permanent=['prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed'];
  foreach($rows as $row){
    $code=$row['item_code']??''; if(!isset($map[$code])) continue;
    $col=$map[$code]; $resp=$row['response']??'';
    // ONLY an explicit yes or no is considered. A BLANK (unanswered) item must never clear a
    // recorded "yes" — re-saving the form with an item left blank would silently erase her
    // previous caesarean.
    if($resp!=='yes' && $resp!=='no') continue;

    // AND AN EXPLICIT "no" MUST NOT ERASE A "yes" EITHER, for the permanent items. The screening
    // form is episode-scoped and starts blank in each new pregnancy, so a provider who works down
    // it in pregnancy #2 and answers "No" to "previous caesarean" was overwriting women.prior_cs
    // from 'yes' to 'no'. The record then contradicted itself — anc_risk_screening still held the
    // 'yes' from pregnancy #1 — and motherFeats() handed the intrapartum model prior_cs = 0 for a
    // woman with a scarred uterus. That is the single most important feature the model has, and it
    // is the reason scar rupture is a risk at all.
    // Correcting a genuine mis-entry is still possible: the obstetric-details screen (PATCH /women)
    // writes these columns directly, which is a deliberate, explicit retraction rather than a
    // by-product of working down a form.
    if($resp==='no' && in_array($col,$permanent,true)){
      $cur=db()->prepare("SELECT `$col` c FROM women WHERE id=?"); $cur->execute([$wid]); $r=$cur->fetch();
      if($r && $r['c']==='yes'){ audit('screening_no_ignored','women',$wid,['column'=>$col,'kept'=>'yes']); continue; }
    }
    db()->prepare("UPDATE women SET `$col`=? WHERE id=?")->execute([$resp,$wid]);
  }
}

// A positive HIV test anywhere -> the woman is known positive, and linked to PMTCT
function mark_hiv_positive(int $eid): void {
  $wid = woman_of_episode($eid); if(!$wid) return;
  db()->prepare("UPDATE women SET hiv_known_positive=1 WHERE id=? AND (hiv_known_positive IS NULL OR hiv_known_positive=0)")->execute([$wid]);
}

// Td given at an ANC contact -> the Td immunization register
function td_to_register(int $eid, int $dose, ?string $when, array $u): void {
  $wid = woman_of_episode($eid); if(!$wid || $dose<1 || $dose>5) return;
  $c=db()->prepare("SELECT id FROM immunization_clients WHERE woman_id=? AND programme='Td' AND facility_id=?");
  $c->execute([$wid,$u['facility_id']]); $row=$c->fetch();
  if($row){ $cid=(int)$row['id']; }
  else {
    $w=db()->prepare("SELECT mrn,first_name,father_name,age,woreda,kebele FROM women WHERE id=?"); $w->execute([$wid]); $wr=$w->fetch();
    $cid=insert('immunization_clients',['facility_id'=>$u['facility_id'],'woman_id'=>$wid,'programme'=>'Td',
      'mrn'=>($wr['mrn']??null),'name'=>trim(($wr['first_name']??'').' '.($wr['father_name']??'')),
      'age'=>($wr['age']??null),'pregnant'=>1,'woreda'=>($wr['woreda']??null),'kebele'=>($wr['kebele']??null),
      'reg_date'=>($when?:date('Y-m-d')),'recorded_by'=>$u['id']]);
  }
  db()->prepare("DELETE FROM immunization_doses WHERE client_id=? AND dose_no=?")->execute([$cid,$dose]);
  insert('immunization_doses',['client_id'=>$cid,'dose_no'=>$dose,'dose_date'=>($when?:date('Y-m-d')),'recorded_by'=>$u['id']]);
}

// An HIV-exposed newborn -> she is an HIV-exposed infant, and belongs in the HEI cohort.
// If her mother is enrolled in PMTCT we enrol the infant automatically, carrying across what
// the delivery room already recorded. If the mother is NOT enrolled, we flag her as positive
// so the ANC/PMTCT prompt fires — an exposed baby with nobody enrolled is how infants are lost.
function sync_hiv_from_baby(int $babyId): void {
  $q=db()->prepare("SELECT b.*, e.woman_id, e.facility_id FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE b.id=?");
  $q->execute([$babyId]); $b=$q->fetch();
  if(!$b || (int)($b['hiv_exposed']??0)!==1) return;
  $wid=(int)$b['woman_id'];
  db()->prepare("UPDATE women SET hiv_known_positive=1 WHERE id=? AND (hiv_known_positive IS NULL OR hiv_known_positive=0)")->execute([$wid]);
  $m=db()->prepare("SELECT id, delivery_date FROM pmtct_mothers WHERE woman_id=? AND facility_id=? ORDER BY id DESC LIMIT 1");
  $m->execute([$wid,$b['facility_id']]); $mo=$m->fetch();
  if(!$mo) return;                                   // no PMTCT record yet — the UI prompts for enrolment
  $x=db()->prepare("SELECT id FROM pmtct_infants WHERE mother_id=? AND baby_id=?");
  $x->execute([$mo['id'],$babyId]); if($x->fetch()) return;
  $dob=$mo['delivery_date'] ?: substr((string)$b['recorded_at'],0,10);
  insert('pmtct_infants',['mother_id'=>(int)$mo['id'],'baby_id'=>$babyId,'mrn'=>($b['mrn']??null),
    'infant_dob'=>$dob,'hei_enrol_date'=>date('Y-m-d'),
    'arv_start_date'=>((!empty($b['arv_prophylaxis']) && $b['arv_prophylaxis']!=='not_given') ? $dob : null),
    'recorded_by'=>(int)($b['recorded_by']??0) ?: null]);
}

// A pregnancy test result is a FORK IN THE ROAD, and it may arrive at the desk or hours later
// from the lab. This is the routing, shared by POST (result known now) and PATCH (result came
// back later), so a woman is handed on identically either way.
//   positive -> her ANC episode is opened, so the handoff to the ANC room is RECORDED
//   negative -> her family-planning record is opened. She is in the building, thinking about her
//               fertility, with a provider in front of her. It is the highest-yield moment there
//               is to offer contraception, and it used to be a dead end.
function pregtest_link(int $pid, int $wid, string $res, array $b, array $u): array {
  $eid=null; $fpid=null;
  // WHAT SHE WANTS TO DO ABOUT THE PREGNANCY.
  //
  // A positive test used to have exactly one door out of it: open an ANC episode. That assumes every
  // woman with a positive test is continuing the pregnancy. Some are not — and a woman who is not,
  // offered nothing but an antenatal booking, walks out of the facility with nothing. Safe abortion
  // care is provided at health-centre level here; the unsafe alternative is what the guideline exists
  // to prevent. Record what she decided, so the follow-up can happen.
  //
  // An ANC episode is opened ONLY if she is continuing. Nothing else opens one behind her back.
  $fields=array_intersect_key($b, array_flip(['intent','abortion_care','referred_to','followup_date','counselled']));
  if($fields){
    $sets=[]; $vals=[];
    foreach($fields as $k=>$v){ $sets[]="`$k`=?"; $vals[]=($v===''?null:$v); }
    $vals[]=$pid;
    db()->prepare("UPDATE pregnancy_tests SET ".implode(',',$sets)." WHERE id=?")->execute($vals);
  }
  $intent = $b['intent'] ?? null;
  if($res==='positive' && $intent && $intent!=='continue'){
    audit('pregnancy_intent','pregnancy_tests',$pid,['intent'=>$intent,'care'=>($b['abortion_care']??null)]);
    // SHE IS NOT CONTINUING, AND THE CARE IS BEING GIVEN HERE — so open the episode that care is
    // recorded against. This screen used to store the WORD "here" and open nothing, so there was
    // nowhere to record what was actually done: the method, the misoprostol/mifepristone, the
    // antibiotics, the anti-D, the complications, the contraception she left with. The woman who is
    // continuing gets an ANC episode opened for her; the woman who is not got a dropdown value.
    //
    // 'abortion' is an existing service category (migration v29) with its own screen, and the loss /
    // abortion-care record hangs off an episode. Reuse an open one rather than splitting her record.
    if($intent==='not_continue' && ($b['abortion_care']??'')==='here'){
      $ex=db()->prepare("SELECT id FROM episodes WHERE voided=0 AND woman_id=? AND service_category='abortion' AND status NOT IN ('closed') ORDER BY id DESC LIMIT 1");
      $ex->execute([$wid]); $row=$ex->fetch();
      $eid = $row ? (int)$row['id']
                  : insert('episodes',['woman_id'=>$wid,'service_category'=>'abortion','status'=>'active',
                      'admitted_from'=>'new','admission_datetime'=>date('Y-m-d H:i:s'),
                      'facility_id'=>$u['facility_id'],'created_by'=>$u['id']]);
      db()->prepare("UPDATE pregnancy_tests SET linked_episode_id=?, linked_at=NOW() WHERE id=?")->execute([$eid,$pid]);
      return [$eid,null];
    }
    return [null,null];     // referred elsewhere, declined, or undecided — nothing is opened behind her back
  }
  if($res==='positive' && !empty($b['link_to_anc'])){
    // Never open a SECOND ANC episode for a woman who already has one open — that splits her
    // contacts across two charts.
    $ex=db()->prepare("SELECT id FROM episodes WHERE voided=0 AND woman_id=? AND service_category='anc' AND status='active' ORDER BY id DESC LIMIT 1");
    $ex->execute([$wid]); $row=$ex->fetch();
    $eid = $row ? (int)$row['id']
                : insert('episodes',['woman_id'=>$wid,'service_category'=>'anc','status'=>'active',
                    'admitted_from'=>'new','admission_datetime'=>date('Y-m-d H:i:s'),
                    'facility_id'=>$u['facility_id'],'created_by'=>$u['id']]);
    db()->prepare("UPDATE pregnancy_tests SET linked_episode_id=?, linked_at=NOW() WHERE id=?")->execute([$eid,$pid]);
  }
  if($res==='negative' && !empty($b['link_to_fp'])){
    $ex=db()->prepare("SELECT id FROM fp_clients WHERE woman_id=? AND facility_id=? ORDER BY id DESC LIMIT 1");
    $ex->execute([$wid,$u['facility_id']]); $row=$ex->fetch();
    if($row){ $fpid=(int)$row['id']; }
    else {
      $w2=db()->prepare("SELECT mrn,first_name,father_name,age FROM women WHERE id=?"); $w2->execute([$wid]); $wr=$w2->fetch();
      $fpid=insert('fp_clients',['facility_id'=>$u['facility_id'],'woman_id'=>$wid,
        'mrn'=>($wr['mrn']??null),'name'=>trim(($wr['first_name']??'').' '.($wr['father_name']??'')),
        'age'=>($wr['age']??null),'sex'=>'F','reg_date'=>date('Y-m-d'),'acceptor'=>'new',
        'from_preg_test_id'=>$pid,'recorded_by'=>$u['id']]);
    }
    db()->prepare("UPDATE pregnancy_tests SET fp_offered=1, linked_fp_client_id=?, linked_at=NOW() WHERE id=?")->execute([$fpid,$pid]);
  } elseif($res==='negative'){
    db()->prepare("UPDATE pregnancy_tests SET fp_offered=? WHERE id=?")->execute([!empty($b['fp_offered'])?1:0,$pid]);
  }
  return [$eid,$fpid];
}

$m = $_SERVER['REQUEST_METHOD'];
$path = trim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
$path = preg_replace('#^.*api/#','',$path);           // normalise to route after /api/
$parts = explode('/', $path);
$r = $parts[0] ?? '';
$id = $parts[1] ?? null;

// Person-level fields from the Ethiopian MoH registers (migration v12).
// The paper registers repeat these at every encounter; we hold one truth per
// person and let the register export replay them into each row.
const MOH_PERSON_FIELDS = ['woreda','target_pop_code','hiv_known_positive','hiv_linked_pmtct',
  'hiv_linked_pmtct_facility','hiv_linked_art','art_regimen','partner_hiv_accepted',
  'partner_hiv_result','partner_target_pop_code','partner_linked_art'];

try {
  // ---- auth ----
  if ($r==='login' && $m==='POST'){
    $b=body(); $st=db()->prepare("SELECT u.*, f.name AS facility_name, f.facility_type AS facility_type FROM users u LEFT JOIN facilities f ON f.id=u.facility_id WHERE u.username=? AND u.is_active=1");
    $st->execute([$b['username']??'']); $u=$st->fetch();
    if(!$u || !password_verify($b['password']??'', $u['password_hash'])) err('invalid credentials',401);
    unset($u['password_hash']); session_regenerate_id(true); $_SESSION['user']=$u;
    db()->prepare("UPDATE users SET last_login=NOW() WHERE id=?")->execute([$u['id']]);
    audit('login','users',$u['id']); out(['user'=>$u]);
  }
  if ($r==='logout'){ audit('logout'); $_SESSION=[]; session_destroy(); out(['ok'=>true]); }
  if ($r==='me'){ out(['user'=>user()]); }
  $__me=require_auth(); // everything below requires a session
  if(($__me['must_change_password']??0)==1 && !in_array($r,['password','logout','me'],true)) err('password change required',403); // server-side enforcement, not just UI
  if(in_array($m,['POST','PATCH','DELETE'],true)) idem_guard(); // dedup offline-replayed writes

  // ---- users (admin only) ----
  // ---- USERS: the one lateral path between facilities ------------------------------------
  // Patient data is strictly facility-scoped everywhere else, so this route WAS the whole
  // tenancy boundary — and it had none. require_role(['admin']) was the only gate: an admin at
  // facility A could list every user everywhere, reset facility B's admin password, and sign in
  // as them. A facility admin is now confined to their own facility; only a super_admin may
  // reach across, or create another super_admin.
  if ($r==='users'){ $me=require_role(['admin','super_admin']); $super=is_super($me);
    // Roles a caller may hand out. An admin cannot mint a super_admin — that would hand back the
    // cross-facility reach this whole change exists to remove.
    $ROLES = $super ? ['recorder','provider','observer','supervisor','admin','super_admin']
                    : ['recorder','provider','observer','supervisor','admin'];
    // May the caller act on THIS user id?
    $may_touch = function($uid) use ($me,$super){
      $st=db()->prepare("SELECT id,facility_id,role FROM users WHERE id=?"); $st->execute([$uid]);
      $t=$st->fetch(); if(!$t) err('user not found',404);
      if($super) return $t;
      if($t['role']==='super_admin')             err('not found',404);   // don't even confirm they exist
      if((int)$t['facility_id']!==(int)$me['facility_id']) err('not found',404);
      return $t;
    };
    if($m==='GET'){
      if($super){ $st=db()->query("SELECT id,username,full_name,role,cadre,facility_id,scope,is_active,last_login FROM users ORDER BY id"); }
      else { $st=db()->prepare("SELECT id,username,full_name,role,cadre,facility_id,scope,is_active,last_login FROM users WHERE facility_id=? AND role<>'super_admin' ORDER BY id"); $st->execute([$me['facility_id']]); }
      out($st->fetchAll()); }
    if($m==='POST'){ $b=body(); $rows=isset($b[0])?$b:[$b]; $created=[]; $errors=[];  // single object OR array (CSV bulk)
      foreach($rows as $i=>$row){
        $un=trim($row['username']??''); $pw=(string)($row['password']??''); $role=$row['role']??'';
        if($un===''||$pw===''||$role===''){ $errors[]=['row'=>$i,'error'=>'username, password and role are required']; continue; }
        if(strlen($pw)<8){ $errors[]=['row'=>$i,'user'=>$un,'error'=>'password must be at least 8 characters']; continue; }
        if(!in_array($role,$ROLES,true)){ $errors[]=['row'=>$i,'user'=>$un,'error'=>($role==='super_admin'?'only a super-admin can create a super-admin':'invalid role')]; continue; }
        $ex=db()->prepare("SELECT id FROM users WHERE username=?"); $ex->execute([$un]); if($ex->fetch()){ $errors[]=['row'=>$i,'user'=>$un,'error'=>'username already taken']; continue; }
        // SCOPE ABOVE 'facility' IS A SUPER-ADMIN DECISION. facility_id was already confined (below),
        // but `scope` was not: a facility admin could create a supervisor with scope='region', and
        // scoped_facility_ids() would then hand that account every patient name and phone number in
        // the region. Widening the scope is exactly the privilege escalation the facility_id check
        // was written to prevent, through the other column. A facility admin gets 'facility'.
        $scope=in_array(($row['scope']??'facility'),['facility','woreda','zone','region'],true)?($row['scope']??'facility'):'facility';
        if(!is_super($me)) $scope='facility';
        // The caller-supplied facility_id is HONOURED ONLY FOR A SUPER-ADMIN. This one line is what
        // stopped an admin at facility A from minting themselves an admin at facility B.
        $fid=admin_facility_scope($me, $row['facility_id']??null);
        $nid=insert('users',['username'=>$un,'password_hash'=>password_hash($pw,PASSWORD_DEFAULT),'full_name'=>$row['full_name']??$un,'role'=>$role,'cadre'=>$row['cadre']??null,'facility_id'=>$fid,'scope'=>$scope]);
        $created[]=['id'=>$nid,'username'=>$un];
      }
      audit('create_user','users',$created[0]['id']??null,['count'=>count($created)]);
      if(!isset($b[0])){ if($errors) err($errors[0]['error'], $errors[0]['error']==='username already taken'?409:400); out(['id'=>$created[0]['id']],201); }
      out(['created'=>$created,'errors'=>$errors],201); }
    if($m==='PATCH' && $id){ $b=body();
      // Resolve the target FIRST. A facility admin gets a 404 for anyone outside their facility and
      // for any super_admin — a password reset on another facility's admin is precisely the attack.
      $target=$may_touch((int)$id);
      if(isset($b['is_active'])){ if((int)$id===(int)$me['id'] && !$b['is_active']) err('you cannot deactivate your own account'); db()->prepare("UPDATE users SET is_active=? WHERE id=?")->execute([$b['is_active']?1:0,$id]); }
      if(isset($b['role'])){
        if(!in_array($b['role'],$ROLES,true)) err($b['role']==='super_admin'?'only a super-admin can grant super-admin':'invalid role');
        if((int)$id===(int)$me['id'] && $b['role']!==$me['role']) err('you cannot change your own role');
        db()->prepare("UPDATE users SET role=? WHERE id=?")->execute([$b['role'],$id]);
      }
      // Same rule on update as on create: only a super-admin may widen a user's scope beyond their own
      // facility. Otherwise a facility admin could simply PATCH an existing account to scope='region'.
      if(isset($b['scope']) && in_array($b['scope'],['facility','woreda','zone','region'],true)){
        if(!is_super($me) && $b['scope']!=='facility') err('only a super-admin can grant a scope beyond a single facility',403);
        db()->prepare("UPDATE users SET scope=? WHERE id=?")->execute([$b['scope'],$id]);
      }
      // Moving a user between facilities is a super-admin act.
      if(isset($b['facility_id']) && $super){ db()->prepare("UPDATE users SET facility_id=? WHERE id=?")->execute([(int)$b['facility_id'],$id]); }
      if(!empty($b['password'])){ if(strlen($b['password'])<8) err('password must be at least 8 characters'); db()->prepare("UPDATE users SET password_hash=? WHERE id=?")->execute([password_hash($b['password'],PASSWORD_DEFAULT),$id]); }
      audit('update_user','users',$id,['target_facility'=>$target['facility_id']??null,'by_super'=>$super?1:0]); out(['ok'=>true]); }
  }
  if ($r==='facilities'){ $me=require_role(['admin','super_admin']);
    // READ is open to any admin — the users screen and the CSV importer need the facility list to
    // show names. CHANGING the estate (creating, renaming, deleting a facility) is a super-admin
    // act: a facility administrator has no business creating the facility next door.
    if($m==='GET'){ out(db()->query("SELECT id,name,facility_type,kebele,woreda,zone,region,dhis2_org_unit FROM facilities ORDER BY id")->fetchAll()); }
    if($m!=='GET') require_role(['super_admin']);
    if($m==='POST'){ $b=body(); $rows=isset($b[0])?$b:[$b]; $created=[]; $errors=[];  // single object OR array (CSV bulk)
      foreach($rows as $i=>$row){ if(empty($row['name'])){ $errors[]=['row'=>$i,'error'=>'facility name is required']; continue; }
        $ft=in_array($row['facility_type']??'',['primary_hospital','health_center','general_hospital','other'])?$row['facility_type']:'health_center';
        $nid=insert('facilities',['name'=>$row['name'],'facility_type'=>$ft,'kebele'=>$row['kebele']??null,'woreda'=>$row['woreda']??null,'zone'=>$row['zone']??null,'region'=>$row['region']??'Amhara','dhis2_org_unit'=>$row['dhis2_org_unit']??null]);
        $created[]=['id'=>$nid,'name'=>$row['name']]; }
      audit('create_facility','facilities',$created[0]['id']??null,['count'=>count($created)]);
      if(!isset($b[0])){ if($errors) err('facility name is required'); out(['id'=>$created[0]['id']],201); }
      out(['created'=>$created,'errors'=>$errors],201); }
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
    if(strlen($b['new'])<8) err('new password must be at least 8 characters');
    $st=db()->prepare("SELECT password_hash FROM users WHERE id=?"); $st->execute([$u['id']]); $row=$st->fetch();
    if(!$row || !password_verify($b['current'],$row['password_hash'])) err('current password is incorrect',403);
    db()->prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?")->execute([password_hash($b['new'],PASSWORD_DEFAULT),$u['id']]);
    if(isset($_SESSION['user'])) $_SESSION['user']['must_change_password']=0;
    audit('change_own_password','users',$u['id']); out(['ok'=>true]); }

  // ---- women (registration) ----
  if ($r==='women'){
    // A VOIDED WOMAN IS GONE — from every read. See VOID below: the row survives and is auditable,
    // but she does not appear in a search, a worklist, a register, a count or an export. `voided=0`
    // is the default on every existing row, so nothing already recorded changes.
    if($m==='GET' && $id){ $u=user(); $st=db()->prepare("SELECT * FROM women WHERE id=? AND facility_id=? AND voided=0"); $st->execute([$id,$u['facility_id']]); out($st->fetch()?:[]); }
    // SEARCH BY THE NAME SHE IS ACTUALLY KNOWN BY.
    // This used to match `mrn` and `first_name` only. In Ethiopia a woman is identified by her own
    // name AND her father's — so a provider searching "Desta" (the father's name she was told at the
    // door) got NOTHING back, and reasonably concluded the search was broken or case-sensitive.
    // It never was case-sensitive: the column collation (utf8mb4_*_ci) already ignores case.
    // Match the MRN, or any part of her full name, in any order of the words she typed.
    if($m==='GET'){ $u=user();
      $raw=trim((string)($_GET['q']??''));
      $st=db()->prepare(
        "SELECT * FROM women
          WHERE facility_id=? AND voided=0
            AND (mrn LIKE ?
                 OR CONCAT_WS(' ', first_name, father_name, grandfather_name) LIKE ?)
          ORDER BY id DESC LIMIT 100");
      $like='%'.$raw.'%';
      $st->execute([$u['facility_id'], $like, $like]);
      out($st->fetchAll());
    }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body(); $b['created_by']=$u['id']; $b['facility_id']=$u['facility_id'];
      if(empty($b['mrn'])) err('MRN is required');
      // MRN length follows the facility's paper numbering: 5 digits at a health centre, 6 at a hospital.
      $b['mrn']=trim((string)$b['mrn']);
      if(!preg_match('/^\d+$/',$b['mrn'])) err('MRN must be digits only');
      $ft=strtolower((string)($u['facility_type']??''));
      $len=strlen($b['mrn']);
      if($ft==='health_center' && $len!==5) err('MRN must be 5 digits at a health centre');
      if(($ft==='primary_hospital'||$ft==='general_hospital') && $len!==6) err('MRN must be 6 digits at a hospital');
      if($len<5 || $len>6) err('MRN must be 5 or 6 digits');
      // Age, height, gravida and para all go through the SAME guard now. Age alone was checked, which
      // is why a height of 1700000 — and the 65 / 45 / 55 cm heights in production — sailed through.
      check_ranges($b);
      // The MRN is unique per facility, and VOIDING DOES NOT FREE IT — the row still holds the number,
      // because destroying the identifier would destroy the audit trail of what was removed. Say so
      // plainly, otherwise the app offers to "open her existing record" for a woman who no longer has
      // one. An admin can restore her, or the facility can use a different MRN.
      $dup=db()->prepare("SELECT id, voided FROM women WHERE mrn=? AND facility_id=?");
      $dup->execute([$b['mrn'],$u['facility_id']]);
      if($d=$dup->fetch()){
        if((int)($d['voided']??0)===1)
          err('This MRN belongs to a record that was removed. It cannot be reused — please use a different MRN, or ask an admin to restore the removed record.',409);
        err('This MRN already exists at your facility',409);
      }
      $b=blank_to_null($b);
      $wid=insert('women',array_intersect_key($b,array_flip(array_merge(['mrn','first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','height_cm','prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed','chronic_htn','diabetes','cardiac_renal','children_alive','sms_consent','lnmp','edd','kin_address','prev_pregnancy_outcome','ga_first_contact','first_contact_date','late_anc_initiation',
        'blood_group','rh_factor','pregnancy_planned','abortions','ectopic','gtd','residence','occupation','facility_id','created_by'],MOH_PERSON_FIELDS))));
      audit('create','women',$wid); out(['id'=>$wid],201); }
    if($m==='PATCH' && $id){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=? AND voided=0"); $wc->execute([$id,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      // Age <19 or >35 is a high-risk trigger, so a typo here silently corrupted the flag — and a
      // blank cleared it. Height, gravida and para are held to the same standard on a correction.
      check_ranges($b);
      $b=blank_to_null($b);
      $fields=array_intersect_key($b,array_flip(array_merge(['first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','height_cm','children_alive','sms_consent','lnmp','edd','kin_address','prev_pregnancy_outcome','ga_first_contact','first_contact_date','late_anc_initiation',
        'blood_group','rh_factor','pregnancy_planned','abortions','ectopic','gtd','residence','occupation',
        'prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed','chronic_htn','diabetes','cardiac_renal'],MOH_PERSON_FIELDS)));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE women SET `$k`=? WHERE id=?")->execute([$v,$id]); } audit('update','women',$id,array_keys($fields)); out(['ok'=>true]); }
  }

  // ==========================================================================================
  // VOID — the soft delete.
  //
  // Nothing in ADHERE+ could ever be removed: not a woman registered twice by mistake, not an
  // episode opened on the wrong patient. A clinical record is still NEVER DESTROYED — it is voided:
  // it disappears from every worklist, search, register, count and export, but the row survives with
  // WHO voided it, WHEN and WHY, and an admin can restore it.
  //
  // Providers, admins and super-admins may void. When a PROVIDER voids something, a notice is left
  // for the admins of that facility (see /void_notices) — a provider deleting a patient record is
  // exactly the thing a supervisor should be told about, without blocking the provider from doing it.
  //
  // Voiding a WOMAN voids her episodes with her; otherwise they would sit in the labour ward with no
  // patient attached — and RESTORING her must put back exactly those, and nothing else. The cascade
  // stamps this prefix on the reason so the two cases can be told apart. (The wording is unchanged
  // from what was already being written, so episodes voided before this change are still recognised.)
  // ==========================================================================================
  if(!defined('VOID_CASCADE_PREFIX')) define('VOID_CASCADE_PREFIX','the patient record was voided: ');
  if ($r==='void' && $m==='POST'){
    $u=require_role(['provider','admin']);              // super_admin passes via require_role's admin fallback
    $b=body();
    $what=$b['entity']??''; $eid=(int)($b['id']??0); $reason=trim((string)($b['reason']??''));
    if(!in_array($what,['woman','episode'],true)) err('entity must be woman or episode');
    if(!$eid) err('id is required');
    if($reason==='') err('A reason is required. It is the only record of why this was removed.');

    if($what==='woman'){
      $q=db()->prepare("SELECT * FROM women WHERE id=? AND facility_id=? AND voided=0");
      $q->execute([$eid,$u['facility_id']]); $row=$q->fetch();
      if(!$row) err('not found',404);
      db()->prepare("UPDATE women SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE id=?")
          ->execute([$u['id'],$reason,$eid]);
      // her episodes go with her. The reason carries VOID_CASCADE_PREFIX so that restoring her later
      // restores exactly these, and not an episode that was deliberately removed on its own.
      db()->prepare("UPDATE episodes SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE woman_id=? AND voided=0")
          ->execute([$u['id'],VOID_CASCADE_PREFIX.$reason,$eid]);
      // ...and so do her queued SMS reminders. A removed patient must not be texted about an
      // appointment for a pregnancy the facility has just said it recorded by mistake.
      db()->prepare("UPDATE reminders SET status='skipped' WHERE woman_id=? AND status='pending'")->execute([$eid]);
      $label=trim(($row['first_name']??'').' '.($row['father_name']??'')).' ('.($row['mrn']??'').')';
    } else {
      $q=db()->prepare("SELECT e.*, w.first_name, w.father_name, w.mrn
                          FROM episodes e JOIN women w ON w.id=e.woman_id
                         WHERE e.id=? AND e.facility_id=? AND e.voided=0");
      $q->execute([$eid,$u['facility_id']]); $row=$q->fetch();
      if(!$row) err('not found',404);
      db()->prepare("UPDATE episodes SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE id=?")
          ->execute([$u['id'],$reason,$eid]);
      // The PCC uptake checklist belongs to the episode. It was the one child row that did not go with
      // it — so a removed ANC episode kept feeding three national indicators from beyond the grave.
      // The reason carries VOID_CASCADE_PREFIX, so restoring the episode can restore it too, and a row
      // voided in its own right stays voided.
      db()->prepare("UPDATE pcc_uptake SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE episode_id=? AND voided=0")
          ->execute([$u['id'],VOID_CASCADE_PREFIX.$reason,$eid]);
      $label=trim(($row['first_name']??'').' '.($row['father_name']??'')).' ('.($row['mrn']??'').') — '.($row['service_category']??'');
    }

    // Tell the admins, but ONLY when a provider did it. An admin voiding something does not need to
    // notify themselves.
    if(($u['role']??'')==='provider'){
      insert('void_notices',[ 'facility_id'=>$u['facility_id'], 'entity'=>$what, 'entity_id'=>$eid,
        'label'=>$label, 'reason'=>$reason, 'voided_by'=>$u['id'], 'voided_at'=>date('Y-m-d H:i:s') ]);
    }
    audit('void',$what==='woman'?'women':'episodes',$eid,['reason'=>$reason]);
    out(['ok'=>true,'entity'=>$what,'id'=>$eid]);
  }

  // Restore something that was voided in error. Admins and super-admins only — a provider who voided
  // a record by mistake asks an admin, which is the point of the notice.
  if ($r==='unvoid' && $m==='POST'){
    $u=require_role(['admin']);
    $b=body(); $what=$b['entity']??''; $eid=(int)($b['id']??0);
    if(!in_array($what,['woman','episode'],true)) err('entity must be woman or episode');
    if($what==='woman'){
      $q=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $q->execute([$eid,$u['facility_id']]);
      if(!$q->fetch()) err('not found',404);
      db()->prepare("UPDATE women SET voided=0, voided_at=NULL, voided_by=NULL, void_reason=NULL WHERE id=?")->execute([$eid]);
      // RESTORE ONLY WHAT THE WOMAN-VOID TOOK DOWN WITH HER.
      // This used to restore EVERY episode she has, which quietly undid deliberate, separate deletions:
      // an episode opened on the wrong patient and voided on its own came back — with all its clinical
      // rows — onto the worklists, the registers and the MoH counts, the moment someone restored her.
      // The cascade stamps its own reason (VOID_CASCADE_PREFIX), so it can be told apart from an
      // episode a clinician removed on purpose. Only the cascaded ones come back.
      db()->prepare("UPDATE episodes SET voided=0, voided_at=NULL, voided_by=NULL, void_reason=NULL
                      WHERE woman_id=? AND voided=1 AND void_reason LIKE ?")
          ->execute([$eid, VOID_CASCADE_PREFIX.'%']);
      // Put back the appointment reminders that were skipped when she was removed — but only the ones
      // still in the future. (The generator dedupes on woman+date, so without this she would silently
      // never be reminded again about an appointment that was already in the queue.)
      db()->prepare("UPDATE reminders SET status='pending' WHERE woman_id=? AND status='skipped' AND due_date >= CURDATE()")->execute([$eid]);
    } else {
      $q=db()->prepare("SELECT id FROM episodes WHERE id=? AND facility_id=?"); $q->execute([$eid,$u['facility_id']]);
      if(!$q->fetch()) err('not found',404);
      db()->prepare("UPDATE episodes SET voided=0, voided_at=NULL, voided_by=NULL, void_reason=NULL WHERE id=?")->execute([$eid]);
    }
    audit('unvoid',$what==='woman'?'women':'episodes',$eid,[]);
    out(['ok'=>true]);
  }

  // Everything that has been voided at this facility — the admin's review list.
  if ($r==='voided' && $m==='GET'){
    $u=require_role(['admin']);
    $w=db()->prepare("SELECT w.id, w.mrn, w.first_name, w.father_name, w.voided_at, w.void_reason,
                             u.full_name AS voided_by_name, u.role AS voided_by_role
                        FROM women w LEFT JOIN users u ON u.id=w.voided_by
                       WHERE w.facility_id=? AND w.voided=1 ORDER BY w.voided_at DESC LIMIT 200");
    $w->execute([$u['facility_id']]);
    $e=db()->prepare("SELECT e.id, e.service_category, e.status, e.voided_at, e.void_reason,
                             w.mrn, w.first_name, w.father_name,
                             u.full_name AS voided_by_name, u.role AS voided_by_role
                        FROM episodes e JOIN women w ON w.id=e.woman_id LEFT JOIN users u ON u.id=e.voided_by
                       WHERE e.facility_id=? AND e.voided=1 AND w.voided=0 ORDER BY e.voided_at DESC LIMIT 200");
    $e->execute([$u['facility_id']]);
    out(['women'=>$w->fetchAll(), 'episodes'=>$e->fetchAll()]);
  }

  // The notices raised when a PROVIDER voided something. The admin acknowledges them.
  if ($r==='void_notices'){
    $u=require_role(['admin']);
    if($m==='GET'){
      $st=db()->prepare("SELECT n.*, u.full_name AS by_name FROM void_notices n
                           LEFT JOIN users u ON u.id=n.voided_by
                          WHERE n.facility_id=? ORDER BY n.acknowledged, n.voided_at DESC LIMIT 200");
      $st->execute([$u['facility_id']]); out($st->fetchAll());
    }
    if($m==='POST' && $id){                                  // acknowledge one
      db()->prepare("UPDATE void_notices SET acknowledged=1, ack_by=?, ack_at=NOW() WHERE id=? AND facility_id=?")
          ->execute([$u['id'],$id,$u['facility_id']]);
      out(['ok'=>true]);
    }
  }

  // ==========================================================================================
  // THE CHART — her whole record, by WOMAN, in ONE call.
  //
  // ADHERE+ captured far more than it ever showed back. 40 of the 54 fields on the ANC contact were
  // written to the database and never displayed to anyone again: a reactive syphilis result, whether
  // anti-D was given to a Rh-negative woman, an unsuppressed viral load, the serial fundal heights
  // that are the only growth-restriction screen a health centre has, the free-text danger note the
  // last provider wrote for the next one. Care was recorded and then it was gone.
  //
  // BY WOMAN, NOT BY EPISODE. Her ANC contacts hang off the ANC episode and her delivery off the
  // labour episode, so an episode-scoped read can never show the midwife in the labour ward what was
  // found in the antenatal room. This returns the whole continuum, in the order it happened.
  //
  // One request, not twelve: on a 2G link in a health centre, twelve round trips is the difference
  // between a provider using the record and not bothering.
  // ==========================================================================================
  if ($r==='chart' && $m==='GET'){
    $u=require_role(['provider','admin','supervisor']);
    $fac=(int)$u['facility_id'];
    $wid=(int)($_GET['woman']??0);
    if(!$wid && ($eid=(int)($_GET['episode']??0))){
      $q=db()->prepare("SELECT woman_id FROM episodes WHERE id=? AND facility_id=? AND voided=0");
      $q->execute([$eid,$fac]); $row=$q->fetch(); $wid=(int)($row['woman_id']??0);
    }
    if(!$wid) err('woman or episode is required',400);

    $w=db()->prepare("SELECT * FROM women WHERE id=? AND facility_id=? AND voided=0");
    $w->execute([$wid,$fac]); $woman=$w->fetch();
    if(!$woman) err('not found',404);

    // Every episode of care she has had here (a voided one is not part of her record).
    $ep=db()->prepare("SELECT * FROM episodes WHERE woman_id=? AND facility_id=? AND voided=0 ORDER BY id");
    $ep->execute([$wid,$fac]);
    $eps=$ep->fetchAll();
    $ids=array_map(function($e){return (int)$e['id'];}, $eps);

    // Her preconception care is HERS, not an episode's. A woman can have a full PCC record and no
    // pregnancy at all — that is the point of preconception care — so it is fetched woman-level and
    // it must survive the no-episodes case below. It was the first thing that would have gone missing.
    $pccq=db()->prepare("SELECT * FROM pcc_assessments WHERE woman_id=? AND voided=0 ORDER BY contact_date, id");
    $pccq->execute([$wid]); $pcc=$pccq->fetchAll();

    if(!$ids) out(['woman'=>$woman,'episodes'=>[],'anc_visits'=>[],'anc_screening'=>[],'labs'=>[],
                   'deliveries'=>[],'babies'=>[],'pnc_visits'=>[],'danger_signs'=>[],'vitals'=>[],
                   'referrals'=>[],'observations'=>[],'checklist'=>[],'bemonc'=>[],'risk_scores'=>[],
                   'lcg'=>[],'abortion_care'=>[],'deaths'=>[],'pcc'=>$pcc,'pcc_uptake'=>[]]);
    $in=implode(',', array_fill(0,count($ids),'?'));

    $all=function($sql) use ($ids){ $st=db()->prepare($sql); $st->execute($ids); return $st->fetchAll(); };
    out([
      'woman'         => $woman,
      'episodes'      => $eps,
      'anc_visits'    => $all("SELECT * FROM anc_visits        WHERE episode_id IN ($in) ORDER BY visit_date, contact_no, id"),
      'anc_screening' => $all("SELECT * FROM anc_risk_screening WHERE episode_id IN ($in) ORDER BY id"),
      'labs'          => $all("SELECT * FROM lab_orders        WHERE episode_id IN ($in) ORDER BY requested_date, id"),
      'deliveries'    => $all("SELECT * FROM delivery_summary  WHERE episode_id IN ($in) ORDER BY delivery_datetime, id"),
      'babies'        => $all("SELECT * FROM babies            WHERE episode_id IN ($in) ORDER BY birth_order, id"),
      'pnc_visits'    => $all("SELECT * FROM pnc_visits        WHERE episode_id IN ($in) ORDER BY visit_date, id"),
      'danger_signs'  => $all("SELECT * FROM danger_signs      WHERE episode_id IN ($in) ORDER BY obs_datetime, id"),
      'vitals'        => $all("SELECT * FROM maternal_vitals   WHERE episode_id IN ($in) ORDER BY obs_datetime, id"),
      'referrals'     => $all("SELECT * FROM referrals         WHERE episode_id IN ($in) ORDER BY recorded_at, id"),
      // Her labour, under whichever guideline it was recorded: the Labour Care Guide now, and the
      // legacy partograph for the women who were monitored before it replaced it. Both are her record.
      'lcg'           => $all("SELECT * FROM lcg_obs           WHERE episode_id IN ($in) ORDER BY obs_datetime, id"),
      'observations'  => $all("SELECT * FROM partograph_obs    WHERE episode_id IN ($in) ORDER BY recorded_at, id"),
      'checklist'     => $all("SELECT * FROM checklist_responses WHERE episode_id IN ($in) ORDER BY id"),
      'bemonc'        => $all("SELECT * FROM bemonc_care       WHERE episode_id IN ($in) ORDER BY id"),
      'risk_scores'   => $all("SELECT * FROM risk_scores       WHERE episode_id IN ($in) ORDER BY scored_at, id"),
      'abortion_care' => $all("SELECT * FROM abortion_care     WHERE episode_id IN ($in) ORDER BY care_date, id"),
      // Preconception care (woman-level) and the PCC uptake she was asked about at ANC (episode-level).
      // Both belong on her chart: the first is what we did for her before she conceived, the second is
      // what she says was done for her — and where both exist, they should agree.
      'pcc'           => $pcc,
      'pcc_uptake'    => $all("SELECT * FROM pcc_uptake        WHERE episode_id IN ($in) AND voided=0 ORDER BY asked_date, id"),
      // Her death belongs to HER, not to an episode — she may have died before any episode was open.
      'deaths'        => (function() use ($wid,$fac){
          $st=db()->prepare("SELECT * FROM maternal_deaths WHERE woman_id=? AND facility_id=? ORDER BY death_datetime");
          $st->execute([$wid,$fac]); return $st->fetchAll(); })(),
    ]);
  }

  // ==========================================================================================
  // EXPORT — the facility's own data, in its own hands.
  //
  // Everything the facility records has, until now, only been readable through this application. If
  // the tool goes away, the tablet is wiped, or the woreda asks for the figures in a spreadsheet,
  // there is no way out. That is not acceptable for a clinical record: the data belongs to the
  // facility, not to the software.
  //
  // This is a LINE LIST containing names, MRNs and HIV results — the most sensitive data in the
  // system. Gated to provider/admin/supervisor, scoped to the caller's own facility, and voided
  // records are excluded (a removed record is removed from the export too).
  // ==========================================================================================
  if ($r==='export' && $m==='GET'){
    $u=require_role(['provider','admin','supervisor']);
    $fac=(int)$u['facility_id'];
    $type=$_GET['type']??'women';
    $from=$_GET['from']??'2000-01-01'; $to=$_GET['to']??date('Y-m-d');
    if(!preg_match('/^\d{4}-\d{2}-\d{2}$/',$from)||!preg_match('/^\d{4}-\d{2}-\d{2}$/',$to)) err('bad date range');
    $W="w.mrn, TRIM(CONCAT_WS(' ',w.first_name,w.father_name,w.grandfather_name)) AS name, w.age";
    $EP="JOIN episodes e ON e.voided=0 AND e.id=%s JOIN women w ON w.voided=0 AND w.id=e.woman_id";
    $Q=[
      'women'      => ["SELECT w.* FROM women w WHERE w.facility_id=? AND w.voided=0 AND DATE(w.created_at) BETWEEN ? AND ? ORDER BY w.id", 'patients'],
      'anc'        => ["SELECT $W, a.* FROM anc_visits a ".sprintf($EP,'a.episode_id')." WHERE e.facility_id=? AND a.visit_date BETWEEN ? AND ? ORDER BY a.visit_date, a.id", 'anc_contacts'],
      'deliveries' => ["SELECT $W, d.* FROM delivery_summary d ".sprintf($EP,'d.episode_id')." WHERE e.facility_id=? AND DATE(d.delivery_datetime) BETWEEN ? AND ? ORDER BY d.delivery_datetime, d.id", 'deliveries'],
      'babies'     => ["SELECT $W, b.* FROM babies b ".sprintf($EP,'b.episode_id')." WHERE e.facility_id=? AND DATE(b.recorded_at) BETWEEN ? AND ? ORDER BY b.id", 'newborns'],
      'pnc'        => ["SELECT $W, p.* FROM pnc_visits p ".sprintf($EP,'p.episode_id')." WHERE e.facility_id=? AND p.visit_date BETWEEN ? AND ? ORDER BY p.visit_date, p.id", 'pnc_visits'],
      'referrals'  => ["SELECT $W, rf.* FROM referrals rf ".sprintf($EP,'rf.episode_id')." WHERE e.facility_id=? AND DATE(rf.recorded_at) BETWEEN ? AND ? ORDER BY rf.id", 'referrals'],
      // Labour monitoring, one row per assessment — the Labour Care Guide as data, with the alerts
      // that fired at the time. A facility auditing its own intrapartum care needs this, and the
      // record belongs to the facility, not to this software.
      'labour'     => ["SELECT $W, g.* FROM lcg_obs g ".sprintf($EP,'g.episode_id')." WHERE e.facility_id=? AND DATE(g.obs_datetime) BETWEEN ? AND ? ORDER BY g.episode_id, g.obs_datetime", 'labour_care_guide'],
      'loss'       => ["SELECT $W, a.* FROM abortion_care a ".sprintf($EP,'a.episode_id')." WHERE e.facility_id=? AND a.care_date BETWEEN ? AND ? ORDER BY a.care_date, a.id", 'pregnancy_loss'],
      'deaths'     => ["SELECT w.mrn, TRIM(CONCAT_WS(' ',w.first_name,w.father_name)) AS name, w.age, d.*
                          FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id
                         WHERE d.facility_id=? AND DATE(d.death_datetime) BETWEEN ? AND ? ORDER BY d.death_datetime", 'maternal_deaths'],
      // Preconception care. Woman-level, so it does NOT join episodes — a woman can have a full PCC
      // record and no pregnancy, which is the entire point of preconception care. Joining episodes
      // here would have quietly excluded exactly the women the module exists for.
      'pcc'        => ["SELECT $W, p.* FROM pcc_assessments p JOIN women w ON w.voided=0 AND w.id=p.woman_id
                         WHERE p.facility_id=? AND p.voided=0 AND p.contact_date BETWEEN ? AND ?
                         ORDER BY p.contact_date, p.id", 'preconception_care'],
      // What women arriving at ANC say was done for them BEFORE they conceived (MoH Table 8). This is
      // the source of three of the five national PCC indicators, and it is the one a woreda will ask
      // for by name.
      'pcc_uptake' => ["SELECT $W, e.service_category, u2.* FROM pcc_uptake u2 ".sprintf($EP,'u2.episode_id')."
                         WHERE e.facility_id=? AND u2.voided=0 AND u2.asked_date BETWEEN ? AND ?
                         ORDER BY u2.asked_date, u2.id", 'pcc_uptake_at_anc'],
    ];
    if(!isset($Q[$type])) err('unknown export type');
    [$sql,$fname]=$Q[$type];
    $st=db()->prepare($sql); $st->execute([$fac,$from,$to]); $rows=$st->fetchAll();

    audit('export',$type,null,['from'=>$from,'to'=>$to,'rows'=>count($rows)]);   // a line list leaving the building is an auditable act

    // CSV, not JSON: it opens in Excel, which is what a facility and a woreda office actually use.
    header_remove('Content-Type');
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="'.$fname.'_'.$from.'_to_'.$to.'.csv"');
    $out=fopen('php://output','w');
    fwrite($out,"\xEF\xBB\xBF");                       // BOM, so Excel reads the Amharic names correctly
    if($rows) fputcsv($out, array_keys($rows[0]));
    foreach($rows as $row) fputcsv($out, array_values($row));
    fclose($out);
    exit;
  }

  // ==========================================================================================
  // A MATERNAL DEATH — WHEREVER IT HAPPENS.
  //
  // A maternal death could only be recorded in two places: on the delivery record, and on a
  // postnatal visit. A woman who died BEFORE delivery — eclampsia at 30 weeks, a ruptured ectopic,
  // sepsis after an unsafe abortion — could not be recorded as having died at all. She simply
  // stopped appearing on the worklist, indistinguishable from a woman who went home.
  //
  // That is not a missing feature. In a country whose maternal death surveillance depends on
  // facilities reporting deaths, a tool that cannot record one is a tool that hides it.
  // ==========================================================================================
  if ($r==='maternal_deaths'){
    $u=require_role(['provider','admin','supervisor']);
    if($m==='GET'){
      // voided=0: a REMOVED patient is removed from the death register too. (A death that is real
      // must never be removed — but a record created by mistake is not a death.)
      $st=db()->prepare("SELECT d.*, w.mrn, TRIM(CONCAT_WS(' ',w.first_name,w.father_name)) AS name, w.age,
                                u.full_name AS recorded_by_name
                           FROM maternal_deaths d
                           JOIN women w ON w.voided=0 AND w.id=d.woman_id
                      LEFT JOIN users u ON u.id=d.recorded_by
                          WHERE d.facility_id=? ORDER BY d.death_datetime DESC LIMIT 200");
      $st->execute([(int)$u['facility_id']]); out($st->fetchAll());
    }
    if($m==='POST'){
      require_role(['provider','admin']);
      $b=body();
      $wid=(int)($b['woman_id']??0);
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=? AND voided=0");
      $wc->execute([$wid,$u['facility_id']]);
      if(!$wc->fetch()) err('woman not in your facility',404);
      $eid=(int)($b['episode_id']??0); if($eid) require_ep($eid);
      if(empty($b['death_datetime'])) err('The date and time of death is required.');
      if(empty($b['phase'])) err('When in the pregnancy she died is required — it is the axis maternal death surveillance is reported on.');

      $id=insert('maternal_deaths', array_merge(
        array_intersect_key($b, array_flip(['death_datetime','phase','ga_weeks','place','cause','cause_note','contributing','reported_mdsr'])),
        ['woman_id'=>$wid,'episode_id'=>($eid?:null),'facility_id'=>(int)$u['facility_id'],'recorded_by'=>$u['id']]));

      // Her episode of care is over. Closing it takes her off the worklist — leaving a dead woman on
      // the labour ward list for the next shift to "follow up" is its own cruelty.
      if($eid) close_episode($eid,'maternal death');
      audit('maternal_death','women',$wid,['phase'=>$b['phase'],'cause'=>($b['cause']??null)]);
      out(['id'=>$id,'ok'=>true],201);
    }
    if($m==='PATCH' && $id){
      require_role(['provider','admin']); $b=body();
      $f=array_intersect_key($b, array_flip(['death_datetime','phase','ga_weeks','place','cause','cause_note','contributing','reported_mdsr']));
      if($f){
        $sets=[]; $vals=[];
        foreach($f as $k=>$v){ $sets[]="`$k`=?"; $vals[]=($v===''?null:$v); }
        $vals[]=$id; $vals[]=(int)$u['facility_id'];
        db()->prepare("UPDATE maternal_deaths SET ".implode(',',$sets)." WHERE id=? AND facility_id=?")->execute($vals);
      }
      audit('update','maternal_deaths',$id,array_keys($f)); out(['ok'=>true]);
    }
  }

  // ---- providers list (for handover picker; any logged-in user) ----
  if ($r==='providers' && $m==='GET'){ $u=user(); $st=db()->prepare("SELECT id,full_name,role FROM users WHERE is_active=1 AND role IN ('provider','admin') AND facility_id=? ORDER BY full_name"); $st->execute([$u['facility_id']]); out($st->fetchAll()); }

  // ---- episodes ----
  if ($r==='episodes'){
    if($m==='GET'){ $u=user(); $cat=$_GET['category']??null; $flag=$_GET['flag']??null; $wom=(int)($_GET['woman']??0);
      // Derived risk flag (no user input).
      // Age: National ANC Guideline 2022, Table 4 — high risk is age <19 OR >35.
      // (Not <18/>=35. The guideline is explicit; an 18-year-old and a 36-year-old both qualify.)
      // Unplanned/unwanted pregnancy is also a Table 4 high-risk condition.
      // Late ANC initiation is deliberately NOT included: it is so common here that flagging it
      // would mark most women and cause alarm fatigue. It stays visible on the chart instead.
      // RESOLVED BY WOMAN, NOT BY EPISODE. Risk screening and ANC results used to be looked up
      // against THIS episode — so when a woman moved from her ANC episode to a labour episode,
      // the rule was evaluated against the new episode, which has no screening rows, and she
      // arrived on the labour ward with no risk flag at all. Her previous caesarean was in the
      // database the whole time, attached to an episode nobody was reading any more. Risk belongs
      // to the woman and must follow her.
      // Build FULLY CLOSED EXISTS clauses. (An earlier version of this left the parentheses
      // unbalanced, which made /api/episodes throw a SQL error and every worklist came back
      // empty — the app looked like it had lost every patient.)
      // voided=0 throughout: care recorded on a REMOVED episode must not go on driving her risk flags,
      // her anaemia grade or her gestational age. The episode was removed because it should not exist.
      // The rule lives in lib.php (hr_sql) and is shared with the dashboard, which used to carry its
      // own, narrower copy — so the two screens disagreed about who was high risk.
      $hr = hr_sql();
      // "For client X, what conditions make her high risk?" — a flag with no reason is a dead end.
      // Return the ACTUAL reasons as codes so the worklist can explain itself and state the
      // next intervention, without the provider having to open her record to guess.
      $rc="CONCAT_WS(',',
             CASE WHEN w.age IS NOT NULL AND w.age<19 THEN 'AGE_LT19' END,
             CASE WHEN w.age IS NOT NULL AND w.age>35 THEN 'AGE_GT35' END,
             CASE WHEN w.pregnancy_planned=0 THEN 'UNPLANNED' END,
             CASE WHEN w.prior_cs='yes' THEN 'PRIOR_CS' END,
             CASE WHEN w.prior_stillbirth='yes' THEN 'PRIOR_STILLBIRTH' END,
             CASE WHEN w.prior_pph='yes' THEN 'PRIOR_PPH' END,
             CASE WHEN w.prior_preeclampsia='yes' THEN 'PRIOR_PREECLAMPSIA' END,
             CASE WHEN w.prior_obstructed='yes' THEN 'PRIOR_OBSTRUCTED' END,
             CASE WHEN w.chronic_htn='yes' THEN 'CHRONIC_HTN' END,
             CASE WHEN w.diabetes='yes' THEN 'DIABETES' END,
             CASE WHEN w.cardiac_renal='yes' THEN 'CARDIAC_RENAL' END,
             CASE WHEN w.rh_factor='neg' THEN 'RH_NEG' END,
             CASE WHEN w.late_anc_initiation=1 THEN 'LATE_ANC' END,
             CASE WHEN w.hiv_known_positive=1 THEN 'HIV_POS' END
           )";
      // Screening and ANC results resolve by WOMAN, so they follow her from ANC into labour.
      $sc="(SELECT GROUP_CONCAT(DISTINCT a.item_code) FROM anc_risk_screening a JOIN episodes e4 ON e4.voided=0 AND e4.id=a.episode_id WHERE e4.woman_id=w.id AND a.response='yes')";
      $an="(SELECT av.anaemia_grade FROM anc_visits av JOIN episodes e5 ON e5.voided=0 AND e5.id=av.episode_id WHERE e5.woman_id=w.id AND av.anaemia_grade IS NOT NULL AND av.anaemia_grade<>'normal' ORDER BY av.id DESC LIMIT 1)";
      $mf="(SELECT av.muac_flag FROM anc_visits av JOIN episodes e6 ON e6.voided=0 AND e6.id=av.episode_id WHERE e6.woman_id=w.id AND av.muac_flag=1 ORDER BY av.id DESC LIMIT 1)";
      // Person-level items are carried forward here so Delivery and PNC can SHOW what ANC
      // already established (blood group, Rh, HIV, target population) instead of re-asking.
      // The prior_* columns are here because THE RISK MODEL CONSUMES THEM. They were absent, so
      // motherFeats() read undefined and every woman was scored as having no previous caesarean —
      // the single most important intrapartum feature, pinned at zero for every patient.
      // GESTATIONAL AGE FOLLOWS THE WOMAN, NOT THE EPISODE.
      // Her ANC contacts hang off her ANC episode. Labour is a SEPARATE episode (and the ANC one is
      // closed when it opens), so the partograph asking for `anc_visits?episode=<labour id>` got an
      // empty list and the GA fix never fired for the very women we hold the most data on: they fell
      // back to the raw BOOKING GA, floored at 24 weeks, and a term labour was scored as if it were
      // extremely preterm. Resolve her latest ANC-contact GA (and its date) BY WOMAN, right here on the
      // episode row, so every screen gets it — and carry first_contact_date so it can be advanced.
      $gaw = "(SELECT av.ga_weeks FROM anc_visits av JOIN episodes ex ON ex.voided=0 AND ex.id=av.episode_id
                WHERE ex.woman_id=w.id AND av.ga_weeks IS NOT NULL ORDER BY av.visit_date DESC, av.id DESC LIMIT 1)";
      $gad = "(SELECT av.visit_date FROM anc_visits av JOIN episodes ex ON ex.voided=0 AND ex.id=av.episode_id
                WHERE ex.woman_id=w.id AND av.ga_weeks IS NOT NULL ORDER BY av.visit_date DESC, av.id DESC LIMIT 1)";
      $sql="SELECT e.*, w.first_name,w.father_name,w.mrn,w.gravida,w.para,w.age,w.height_cm,w.lnmp,w.edd, w.ga_first_contact,w.first_contact_date,w.late_anc_initiation,
              w.blood_group,w.rh_factor,w.pregnancy_planned,w.target_pop_code,w.hiv_known_positive,w.hiv_linked_art,w.art_regimen,
              w.prior_cs,w.prior_stillbirth,w.prior_pph,w.prior_preeclampsia,w.prior_obstructed,w.chronic_htn,w.diabetes,w.cardiac_renal,
              pu.full_name AS provider_name, $hr AS high_risk,
              $gaw AS anc_ga_weeks, $gad AS anc_ga_date,
              $rc AS risk_codes, $sc AS screen_codes, $an AS anaemia, $mf AS muac_low
            FROM episodes e JOIN women w ON w.id=e.woman_id LEFT JOIN users pu ON pu.id=e.provider_id
            WHERE e.facility_id=? AND e.voided=0 AND w.voided=0";
      // ^ THIS is the query behind EVERY worklist (antenatal, labour, postnatal, high-risk, the
      //   patient hub, and the single-episode lookup). Filtering voided here covers all of them at
      //   once. A voided woman also takes her episodes with her: w.voided=0 excludes them even if,
      //   somehow, the episode row itself was never marked.
      $args=[$u['facility_id']]; if($cat){ $sql.=" AND e.service_category=?"; $args[]=$cat; }
      // Filter to ONE woman, or ONE episode, server-side. Without this, callers had to pull the
      // LIMIT-200 list and pick their record out of it in the browser — so once a facility passed
      // 200 episodes, an older woman resolved to an empty object and the failure was SILENT and
      // CLINICAL: her Rh-negative / Anti-D banner vanished, a woman on ART was offered an HIV
      // test, and her delivered partograph reopened for editing.
      if($wom){ $sql.=" AND e.woman_id=?"; $args[]=$wom; }
      $epOne=(int)($_GET['ep']??0);
      if($epOne){ $sql.=" AND e.id=?"; $args[]=$epOne; }
      // A high-risk woman who has DELIVERED is still high risk — postpartum haemorrhage and
      // eclampsia both happen after the birth. Excluding 'delivered' dropped exactly the women
      // the postnatal period is dangerous for.
      // A HIGH-RISK WOMAN WHO IS STILL WAITING TO BE SEEN IS THE WHOLE POINT OF THIS LIST.
      // This was an ALLOW-list of ('laboring','active','delivered') — which silently dropped 'wait',
      // the status EVERY newly registered or triaged woman starts in, plus 'referred' and 'discharged'.
      // So a woman found to have pre-eclampsia at her ANC contact was correctly flagged high_risk=1 on
      // her own row, and then did not appear on the high-risk worklist the providers actually work from
      // — she sat in the waiting queue, invisible, until somebody happened to open her chart. Verified
      // live: half the high-risk ANC episodes on the server were missing from this list.
      // Exclude only what is genuinely FINISHED, and let everything still in her care show.
      if($flag==='highrisk'){ $sql.=" AND $hr AND e.status NOT IN ('closed')"; }
      // CLOSED EPISODES LEAVE THE WORKLISTS. Nothing in ADHERE+ ever wrote 'closed' or
      // 'discharged' — the enum had them, closed_datetime existed, and no code touched either. So a
      // woman transferred from ANC into labour kept her ANC episode 'active' for ever: she appeared
      // on the antenatal list AND the labour ward at the same time, the high-risk list returned her
      // twice, and the Home tile counts only ever grew. Episodes now close, and closed episodes
      // drop out of every list — but they are still fully readable by id (?ep=) or by woman
      // (?woman=), because closing an episode ends the care, not the record.
      if(!$epOne && !$wom && empty($_GET['all'])) $sql.=" AND e.status <> 'closed'";
      $sql.=" ORDER BY e.id DESC LIMIT 200";
      $st=db()->prepare($sql); $st->execute($args); $rows=$st->fetchAll();
      // HER HIV STATUS IS NOT PART OF A WORKLIST ROW FOR EVERYONE WHO CAN SEE THE WORKLIST.
      // This route carries hiv_known_positive, hiv_linked_art, art_regimen and an HIV_POS risk code —
      // and it had NO role check at all, only require_auth via user(). So the read-only `observer` and
      // the clerical `recorder` could pull the entire HIV cohort of the facility in one call: exactly
      // what /pmtct and /registers were deliberately tightened to prevent. The gate on those two routes
      // was worth nothing while this one was open.
      //
      // The worklist itself is their job, so it is not the ACCESS that is wrong — it is the payload.
      // Clinical roles see the whole row; everyone else sees the same list with the HIV columns removed
      // and HIV_POS stripped out of the risk codes.
      $clinical = in_array($u['role'], ['provider','admin','supervisor','super_admin'], true);
      if(!$clinical){
        foreach($rows as &$row){
          unset($row['hiv_known_positive'], $row['hiv_linked_art'], $row['art_regimen']);
          if(!empty($row['risk_codes'])){
            $row['risk_codes'] = implode(',', array_filter(explode(',', $row['risk_codes']), function($c){ return $c!=='HIV_POS'; }));
          }
        }
        unset($row);
      }
      out($rows); }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body();
      // voided=0: no new episode of care may be opened on a REMOVED patient. (If she was removed by
      // mistake, an admin restores her — that is what the restore screen is for.)
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=? AND voided=0"); $wc->execute([$b['woman_id']??0,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      $wid=(int)$b['woman_id']; $cat=$b['service_category']??'';

      // ---- ONE EPISODE PER EPISODE OF CARE ---------------------------------------------------
      // Nothing stopped a second open episode being created for the same woman in the same service.
      // The "Find a woman -> admit her" screen — built precisely to stop her record splitting — did
      // it every time she came back: contact 1 sat on the old episode, and the new episode counted
      // its own visits from 1 again, so the MoH ANC register printed TWO "contact 1" rows for her
      // and her risk screening was invisible from the new chart.
      // voided=0: a VOIDED episode must never be handed back and re-used. It is a removed record —
      // reusing it would silently resurrect it, with all the care that was recorded on it.
      $open=db()->prepare("SELECT id,status FROM episodes
                            WHERE voided=0 AND woman_id=? AND facility_id=? AND service_category=? AND status<>'closed'
                            ORDER BY id DESC LIMIT 1");
      $open->execute([$wid,$u['facility_id'],$cat]);
      if($ex=$open->fetch()){ out(['id'=>(int)$ex['id'],'reused'=>true],200); }   // hand back the one she already has

      // Postnatal care belongs on the birth. If she delivered HERE, her PNC visits must hang off that
      // labour episode — which owns the delivery record and the babies. A separate pnc episode put
      // her on the postnatal list twice, labelled the second one "delivered elsewhere" (false), and
      // left the newborn dropdown empty so her baby's assessment was tied to no infant at all.
      if($cat==='pnc'){
        $dl=db()->prepare("SELECT e.id FROM episodes e JOIN delivery_summary d ON d.episode_id=e.id
                            WHERE e.voided=0 AND e.woman_id=? AND e.facility_id=? AND e.status<>'closed'
                            ORDER BY e.id DESC LIMIT 1");
        $dl->execute([$wid,$u['facility_id']]);
        if($d=$dl->fetch()) out(['id'=>(int)$d['id'],'reused'=>true,'on_delivery'=>true],200);
      }

      // Admitting her in labour ENDS her antenatal care. It does not run alongside it.
      if($cat==='labour'){
        $anc=db()->prepare("SELECT id FROM episodes WHERE voided=0 AND woman_id=? AND facility_id=? AND service_category='anc' AND status<>'closed'");
        $anc->execute([$wid,$u['facility_id']]);
        foreach($anc->fetchAll() as $r){ close_episode((int)$r['id'],'admitted in labour'); }
      }

      $b['created_by']=$u['id']; $b['facility_id']=$u['facility_id'];
      // came_from_facility etc: a woman booked at another health centre who arrives here in labour
      // was recorded as 'new' — as if nobody had ever seen her. The tool then screened her as
      // unbooked, which is a different woman with a different risk.
      $eid=insert('episodes',array_intersect_key($b,array_flip(['woman_id','service_category','status','provider_id','admitted_from','ruptured_membrane','ruptured_datetime','admission_datetime','facility_id','created_by','place_of_delivery','infant_dob','came_from_facility','came_with_records','transfer_reason','labour_onset','active_labour_dx','rom_unknown','risk_factors'])));
      audit('create','episodes',$eid); out(['id'=>$eid],201); }
    if($m==='PATCH' && $id){ require_role(['recorder','provider','admin']); require_ep($id); $b=body();
      // REFERRAL IS NOT A CLINICAL STATE. It used to overwrite status with 'referred', which
      // erased 'delivered' — so a woman referred for postpartum haemorrhage vanished from the
      // postnatal list AND the high-risk list, her hub lost its postnatal tiles, and nothing in
      // the application could ever put her back. She is still delivered. She is still postpartum.
      // She is still at risk. Referral is a fact ABOUT her, recorded alongside her state.
      if(($b['status']??'')==='referred'){
        db()->prepare("UPDATE episodes SET referred=1, referred_at=NOW() WHERE id=?")->execute([$id]);
        unset($b['status']);
        audit('refer','episodes',$id,['referred']);
      }
      // Closing (and re-opening) an episode goes through here so closed_datetime is always kept in
      // step with the status. Only a provider or admin may close: it is a clinical decision that she
      // no longer needs this episode of care, and it removes her from the worklist.
      if(($b['status']??'')==='closed'){
        require_role(['provider','admin']);
        close_episode((int)$id, (string)($b['close_reason']??'closed by provider'));
        out(['ok'=>true,'closed'=>true]);
      }
      if(($b['status']??'')==='reopen'){
        require_role(['provider','admin']);
        // She came back, or it was closed by mistake. Restore the state she was actually in — never
        // guess 'active' for a woman who has delivered, or she leaves the postnatal list.
        $st=db()->prepare("SELECT e.service_category, (SELECT COUNT(*) FROM delivery_summary d WHERE d.episode_id=e.id) dn FROM episodes e WHERE e.id=?");
        $st->execute([$id]); $r=$st->fetch();
        $back = ($r && $r['dn']>0) ? 'delivered' : ((($r['service_category']??'')==='labour') ? 'laboring' : 'active');
        db()->prepare("UPDATE episodes SET status=?, closed_datetime=NULL WHERE id=?")->execute([$back,$id]);
        audit('reopen','episodes',$id,['status'=>$back]);
        out(['ok'=>true,'status'=>$back]);
      }
      // `ruptured_datetime` is admitted here deliberately. The partograph derives rom_hours from it
      // and hands that to the scorer, but it was in NO allow-list — so the column was never written
      // and the model's rom_hours was null for every woman. Prolonged rupture is the main driver of
      // intrapartum sepsis; the feature existed in name only.
      // Section 1 of the Labour Care Guide belongs to the admission, not to an observation: how labour
      // started, when active first stage (>=5 cm) was diagnosed — which is where the LCG clock starts —
      // whether she can say when her membranes ruptured, and the risk factors she carries into labour.
      $fields=array_intersect_key($b,array_flip(['status','provider_id','ruptured_membrane','ruptured_datetime','place_of_delivery','infant_dob','returned_at','came_from_facility','came_with_records','transfer_reason','admitted_from','labour_onset','active_labour_dx','rom_unknown','risk_factors']));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE episodes SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      if($fields) audit('update','episodes',$id,$fields);
      out(['ok'=>true]); }
  }

  // =================================================================================================
  // INTRAPARTUM CARE — THE LABOUR CARE GUIDE
  //
  // Ethiopia's endorsed Intrapartum Care Guideline replaces the partograph with the WHO Labour Care
  // Guide. One row per ASSESSMENT, which is how the provider works: assess -> record -> check the
  // alert column -> plan with her. The alert codes that fired are stored ON the row, not recomputed
  // later, because the record has to be able to say what the provider was actually shown.
  //
  // The allow-list is declared ONCE and reused by the write path and the offline replay path. It was
  // two different lists before, and the replay list was SHORTER — so a tablet that synced late lost
  // twelve of the twenty-two fields it had recorded, silently. Never again: one list, one truth.
  // =================================================================================================
  $LCG_FIELDS = ['episode_id','obs_datetime','hours_since_active','stage','guide_no',
    'companion','pain_relief','oral_fluid','posture',
    'fhr_baseline','fhr_decel','amniotic_fluid','fetal_position','caput','moulding',
    'pulse','bp_systolic','bp_diastolic','temperature','urine_protein','urine_acetone',
    'contractions_per10','contraction_dur_sec','cervix_cm','descent_fifths','pushing_started',
    'oxytocin','oxytocin_units','oxytocin_drops','medicine','iv_fluids',
    'assessment','plan','initials','alerts','recorded_by'];

  if ($r==='lcg'){
    if($m==='GET'){ require_ep($_GET['episode']??0);
      $st=db()->prepare("SELECT * FROM lcg_obs WHERE episode_id=? ORDER BY obs_datetime, id");
      $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['provider','admin']); $b=body(); require_ep($b['episode_id']??0);
      $b = blank_to_null($b);
      check_ranges($b);                                  // an impossible reading is refused here, not only in the browser
      $b['recorded_by']=$u['id'];
      if(is_array($b['alerts']??null)) $b['alerts']=implode(',',$b['alerts']);
      $oid=insert('lcg_obs',array_intersect_key($b,array_flip($LCG_FIELDS)));
      audit('create_lcg','lcg_obs',$oid,['alerts'=>$b['alerts']??null]); out(['id'=>$oid],201); }
    if($m==='PATCH' && $id){ $u=require_role(['provider','admin']); $b=body();
      $q=db()->prepare("SELECT episode_id FROM lcg_obs WHERE id=?"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_ep($row['episode_id']);                    // the episode must be hers, and not voided
      $b = blank_to_null($b); check_ranges($b);
      // A CORRECTION, NOT A REWRITE: the assessment/plan and the clinical values can be corrected,
      // but the row cannot be moved to another episode and its time cannot be rewritten.
      $f = array_intersect_key($b, array_flip(array_diff($LCG_FIELDS, ['episode_id','obs_datetime','recorded_by'])));
      if(!$f) err('nothing to update');
      if(is_array($f['alerts']??null)) $f['alerts']=implode(',',$f['alerts']);
      foreach($f as $k=>$v){ db()->prepare("UPDATE lcg_obs SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      audit('update','lcg_obs',$id,array_keys($f)); out(['ok'=>true]); }
  }

  // ---- partograph observations — LEGACY, READ-ONLY -----------------------------------------------
  // 33 observations on 17 real episodes were recorded with the partograph. They are part of those
  // women's records: they stay readable, printable and countable. But no NEW partograph observation
  // may be written — the national guideline has replaced the tool, and a facility running both would
  // be recording labour against two different definitions of poor progress.
  if ($r==='observations'){
    if($m==='GET'){ require_ep($_GET['episode']??0); $st=db()->prepare("SELECT * FROM partograph_obs WHERE episode_id=? ORDER BY obs_datetime"); $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    // 410 Gone, not 404: the route existed, and an old tablet replaying a queued partograph entry
    // deserves a clear answer rather than a silent failure. 4xx also means the offline queue surfaces
    // it on the failed-entries screen instead of retrying it for ever.
    if($m==='POST'){ err('The partograph has been replaced by the Labour Care Guide. Record this assessment under Intrapartum care.', 410); }
  }

  // =================================================================================================
  // PRECONCEPTION CARE
  //
  // Two routes, because the guideline asks two different questions.
  //
  //   /pcc         — care DELIVERED to a woman who is not pregnant. Woman-level, never episode-level:
  //                  preconception care happens before there is a pregnancy to have an episode of.
  //                  Guarded by require_woman(), the woman-level twin of require_ep().
  //   /pcc-uptake  — care she says she RECEIVED before conceiving, asked at ANC (MoH Table 8).
  //                  Episode-level, one row per ANC episode, and the status is derived by the same
  //                  rule the screen shows her: none / partial / optimal (folic acid PLUS one other).
  //
  // The allow-list is declared ONCE and reused by the write path and the offline replay path. Two
  // lists that drift apart is how a tablet syncing after a week silently loses half of what it
  // recorded — it happened once here already, and it is not going to happen twice.
  // =================================================================================================
  $PCC_FIELDS = ['woman_id','facility_id','contact_date','entry_point',
    'plans_pregnancy','couple_counselled','partner_present','parity','prior_apo',
    'fp_current_method','fp_counselled','birth_interval_ok','infertility_screen','disability',
    'height_cm','weight_kg','bmi','hgb','diet_counselled','iodized_salt','dewormed',
    'folate_dose','folate_start_date','iron_supplied','folate_adherence',
    'dm_known','dm_fbs','dm_hba1c','htn_known','bp_systolic','bp_diastolic',
    'cardiac_symptoms','cardiac_who_class','ckd_known','creatinine','epilepsy','epilepsy_drug',
    'alcohol','khat','tobacco','other_substance','coffee_cups','activity_min_week',
    'cxca_screened','cxca_result','hpv_vaccinated','repro_anomaly',
    'gbv_screened','gbv_positive','gbv_referred','fgm','fgm_counselled','sexual_dysfunction',
    'hiv_status','syphilis','hbsag','tb_screen','malaria_risk','sti_history',
    'td_doses','td_given_today','td_next_due','hbv_vaccine_doses',
    'consanguinity','family_hx_genetic','prior_ntd',
    'current_medicines','teratogenic_flag','teratogenic_named',
    'mh_depression','mh_anxiety','mh_known_illness','mh_referred',
    'exposure_pets','exposure_radiation','exposure_chemicals','exposure_counselled',
    'dental_problem','dental_referred',
    'readiness','readiness_reasons','cannot_assess','referred_to','care_plan','next_visit',
    // Which of the fifteen components the provider actually went through. Without it, an unticked
    // checkbox (0) is indistinguishable from a question never asked, and the completeness figure
    // reports care that was never given.
    'sections_reviewed',
    // The id the tablet gave this write. UNIQUE — so an offline batch that is replayed twice lands
    // once, instead of putting two contradictory preconception assessments on one woman's chart.
    'client_uuid',
    'recorded_by'];

  $PCC_UPTAKE_FIELDS = ['episode_id','woman_id','facility_id','asked_date','verified_against',
    'i1_family_planning','i2_nutrition_bmi','i3_folic_acid','i4_chronic_disease','i5_substance_use',
    'i6_physical_activity','i7_repro_cxca','i8_sexual_gbv_fgm','i9_infectious','i10_vaccine',
    'i11_genetic','i12_medication','i13_mental_health','i14_environmental','i15_dental',
    'status','planned_pregnancy','remark','recorded_by'];

  // The uptake status is derived by pcc_uptake_status() in lib.php — on the SERVER, whatever the
  // client sent. A national indicator cannot depend on a client being honest, or being current.

  if ($r==='pcc'){
    if($m==='GET'){
      $u=require_auth();
      if($id){                                              // one assessment
        $st=db()->prepare("SELECT p.* FROM pcc_assessments p JOIN women w ON w.id=p.woman_id
                            WHERE p.id=? AND w.facility_id=? AND w.voided=0 AND p.voided=0");
        $st->execute([$id,$u['facility_id']]); out($st->fetch()?:[]);
      }
      $wid=(int)($_GET['woman']??0);
      if($wid){ require_woman($wid);
        $st=db()->prepare("SELECT * FROM pcc_assessments WHERE woman_id=? AND voided=0 ORDER BY contact_date DESC, id DESC");
        $st->execute([$wid]); out($st->fetchAll());
      }
      // The facility's PCC caseload. A voided woman appears nowhere — the same rule as every other list.
      $st=db()->prepare("SELECT p.*, w.mrn, w.first_name, w.father_name, w.age
                           FROM pcc_assessments p JOIN women w ON w.id=p.woman_id
                          WHERE p.facility_id=? AND p.voided=0 AND w.voided=0
                          ORDER BY p.contact_date DESC, p.id DESC LIMIT 200");
      $st->execute([$u['facility_id']]); out($st->fetchAll());
    }
    if($m==='POST'){ $u=require_role(['provider','admin']); $b=body();
      require_woman($b['woman_id']??0);                     // hers, and not voided
      $b=blank_to_null($b);
      // blank_to_null() only nulls the columns that carry a numeric RANGE. This table also has four
      // DATE columns and twenty ENUMs, and MySQL in strict mode rejects '' for both — so a payload from
      // an older client, or a replay, came back as an opaque "one of the values is not valid" with no
      // hint which field it meant. An empty box is "not recorded", everywhere on this form.
      foreach($PCC_FIELDS as $f){ if(array_key_exists($f,$b) && $b[$f]==='') $b[$f]=null; }
      check_ranges($b);
      $b['facility_id']=$u['facility_id'];                  // never taken from the client
      $b['recorded_by']=$u['id'];
      if(empty($b['contact_date'])) $b['contact_date']=date('Y-m-d');
      if(is_array($b['readiness_reasons']??null)) $b['readiness_reasons']=implode(' | ',$b['readiness_reasons']);
      if(is_array($b['cannot_assess']??null))     $b['cannot_assess']=implode('; ',$b['cannot_assess']);
      $pid=insert('pcc_assessments',array_intersect_key($b,array_flip($PCC_FIELDS)));
      audit('create_pcc','pcc_assessments',$pid,['readiness'=>$b['readiness']??null,'folate'=>$b['folate_dose']??null]);
      out(['id'=>$pid],201); }
    if($m==='PATCH' && $id){ $u=require_role(['provider','admin']); $b=body();
      $q=db()->prepare("SELECT woman_id FROM pcc_assessments WHERE id=? AND voided=0"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_woman($row['woman_id']);
      $b=blank_to_null($b); check_ranges($b);
      if(is_array($b['readiness_reasons']??null)) $b['readiness_reasons']=implode(' | ',$b['readiness_reasons']);
      if(is_array($b['cannot_assess']??null))     $b['cannot_assess']=implode('; ',$b['cannot_assess']);
      // A correction, not a re-parenting: the assessment can be corrected, but it cannot be moved to
      // another woman and its facility cannot be rewritten.
      $f=array_intersect_key($b, array_flip(array_diff($PCC_FIELDS,['woman_id','facility_id','recorded_by','client_uuid'])));
      if(!$f) err('nothing to update');
      // All of them, or none. A constraint tripped on a late column must not leave the record
      // half-corrected — with, say, the readiness verdict updated and the finding that produced it not.
      db()->beginTransaction();
      try{
        foreach($f as $k=>$v){ db()->prepare("UPDATE pcc_assessments SET `$k`=? WHERE id=?")->execute([$v,$id]); }
        db()->commit();
      }catch(Throwable $ex1){ db()->rollBack(); throw $ex1; }
      audit('update','pcc_assessments',$id,array_keys($f)); out(['ok'=>true]); }
    if($m==='DELETE' && $id){ $u=require_role(['provider','admin']); $b=body();
      $reason=trim((string)($b['reason']??'')); if(strlen($reason)<5) err('a reason is required to void a record');
      $q=db()->prepare("SELECT p.woman_id, w.mrn, w.first_name, w.father_name
                          FROM pcc_assessments p JOIN women w ON w.id=p.woman_id
                         WHERE p.id=? AND p.voided=0");
      $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_woman($row['woman_id']);
      db()->prepare("UPDATE pcc_assessments SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE id=?")
          ->execute([$u['id'],$reason,$id]);
      // An admin is told when a PROVIDER removes a record — the same rule as every other void. It was
      // missing here, so a preconception assessment was the one clinical record a provider could remove
      // without anybody being notified.
      if(($u['role']??'')==='provider'){
        insert('void_notices',['facility_id'=>$u['facility_id'],'entity'=>'pcc_assessment','entity_id'=>(int)$id,
          'label'=>trim(($row['first_name']??'').' '.($row['father_name']??'')).' ('.($row['mrn']??'').') — preconception assessment',
          'reason'=>$reason,'voided_by'=>$u['id'],'voided_at'=>date('Y-m-d H:i:s')]);
      }
      audit('void','pcc_assessments',$id,['reason'=>$reason]); out(['ok'=>true]); }
  }

  if ($r==='pcc-uptake'){
    if($m==='GET'){ require_auth(); $eid=(int)($_GET['episode']??0); require_ep($eid);
      $st=db()->prepare("SELECT * FROM pcc_uptake WHERE episode_id=? AND voided=0"); $st->execute([$eid]);
      out($st->fetch()?:[]); }
    if($m==='POST'){ $u=require_role(['provider','admin']); $b=body(); require_ep($b['episode_id']??0);
      $b=blank_to_null($b);
      foreach($PCC_UPTAKE_FIELDS as $f){ if(array_key_exists($f,$b) && $b[$f]==='') $b[$f]=null; }
      $e=db()->prepare("SELECT woman_id FROM episodes WHERE id=?"); $e->execute([$b['episode_id']]); $ep=$e->fetch();
      $b['woman_id']=$ep['woman_id']; $b['facility_id']=$u['facility_id']; $b['recorded_by']=$u['id'];
      if(empty($b['asked_date'])) $b['asked_date']=date('Y-m-d');
      // One row per episode (UNIQUE on episode_id). Asking her again at a later contact CORRECTS the
      // answer; it does not create a second, contradictory one — and it must not 500 on the duplicate
      // key when a tablet replays a queued entry it already sent.
      $ex=db()->prepare("SELECT * FROM pcc_uptake WHERE episode_id=?"); $ex->execute([$b['episode_id']]); $old=$ex->fetch();
      // THE STATUS IS DERIVED FROM THE WHOLE ROW — STORED PLUS INCOMING — NEVER FROM THE BODY ALONE.
      //
      // It used to be computed from $b. So a POST of {episode_id, remark:'corrected'} — a partial body,
      // which is exactly what a correction or an older client sends — recomputed the status from a body
      // containing NONE of the fifteen items, got 'none', and wrote that over a woman whose fifteen
      // items were all still sitting in the row saying otherwise. The stored status then contradicted
      // the stored answers, and `status` is the only column the dashboard and the supervisor rollup
      // read. Three national indicators, quietly wrong, with no way to see it from the screen.
      $b['status']=pcc_uptake_status(array_merge($old?:[], $b));
      $row=array_intersect_key($b,array_flip($PCC_UPTAKE_FIELDS));
      if($old){
        $f=array_diff_key($row,array_flip(['episode_id','woman_id','facility_id','recorded_by']));
        db()->beginTransaction();
        try{
          foreach($f as $k=>$v){ db()->prepare("UPDATE pcc_uptake SET `$k`=? WHERE id=?")->execute([$v,$old['id']]); }
          db()->commit();
        }catch(Throwable $ex2){ db()->rollBack(); throw $ex2; }
        audit('update','pcc_uptake',$old['id'],['status'=>$b['status']]);
        out(['id'=>(int)$old['id'],'status'=>$b['status']]);
      }
      $uid=insert('pcc_uptake',$row);
      audit('create_pcc_uptake','pcc_uptake',$uid,['status'=>$b['status']]);
      out(['id'=>$uid,'status'=>$b['status']],201); }
    if($m==='PATCH' && $id){ $u=require_role(['provider','admin']); $b=body();
      $q=db()->prepare("SELECT * FROM pcc_uptake WHERE id=? AND voided=0"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_ep($row['episode_id']);
      $b=blank_to_null($b);
      foreach($PCC_UPTAKE_FIELDS as $f2){ if(array_key_exists($f2,$b) && $b[$f2]==='') $b[$f2]=null; }
      $merged=array_merge($row,$b); $b['status']=pcc_uptake_status($merged);
      $f=array_intersect_key($b, array_flip(array_diff($PCC_UPTAKE_FIELDS,['episode_id','woman_id','facility_id','recorded_by'])));
      if(!$f) err('nothing to update');
      // ALL THE COLUMNS, OR NONE OF THEM. Applied one UPDATE at a time, a value that trips a constraint
      // on the twentieth column leaves the first nineteen committed — and `status` could be persisted
      // while the items it was derived from were not. A half-corrected record is worse than a rejected
      // one, because nothing about it looks wrong.
      db()->beginTransaction();
      try{
        foreach($f as $k=>$v){ db()->prepare("UPDATE pcc_uptake SET `$k`=? WHERE id=?")->execute([$v,$id]); }
        db()->commit();
      }catch(Throwable $ex3){ db()->rollBack(); throw $ex3; }
      audit('update','pcc_uptake',$id,array_keys($f)); out(['ok'=>true,'status'=>$b['status']]); }
    // A checklist recorded against the wrong episode could never be removed — there was no DELETE at
    // all. It is soft-voided like everything else: the row survives, with who removed it and why.
    if($m==='DELETE' && $id){ $u=require_role(['provider','admin']); $b=body();
      $reason=trim((string)($b['reason']??'')); if(strlen($reason)<5) err('a reason is required to void a record');
      $q=db()->prepare("SELECT episode_id FROM pcc_uptake WHERE id=? AND voided=0"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_ep($row['episode_id']);
      db()->prepare("UPDATE pcc_uptake SET voided=1, voided_at=NOW(), voided_by=?, void_reason=? WHERE id=?")
          ->execute([$u['id'],$reason,$id]);
      audit('void','pcc_uptake',$id,['reason'=>$reason]); out(['ok'=>true]); }
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
           // PURGED (v17): baby_weight_g, baby_sex, apgar_1min, apgar_5min, outcome — these duplicated the
           // `babies` table, which is the single source of truth for newborn data (and the only one that
           // supports twins). Nothing reads them. Columns kept so historical rows are not lost.
           'delivery'=>['delivery_summary',['episode_id','delivery_datetime','mode','maternal_outcome','complications','amtsl_uterotonic','amtsl_uterotonic_type','amtsl_cct','amtsl_uterine_tone','amtsl_massage','amtsl_placenta','blood_loss_ml','recorded_by',
             // MoH Delivery register (v12): 7,11,12,15-24,36-38,42,49-51,66
             'partograph_used','episiotomy','mode_other_text','maternal_status','maternal_death_cause','comp_preeclampsia','comp_eclampsia','comp_aph','comp_pph','comp_other','referred','hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_feeding_options','ippfp_acceptor','ippfp_method','remark',
             'ippfp_timing']],   // v15 — IUCD is the commonest method at delivery; post-placental vs 48h matters
           // THE PREGNANCY THAT ENDS EARLY. Miscarriage, safe abortion care, the complications of an
           // unsafe one, an ectopic — none of these had anywhere to be recorded, so a woman who had
           // one either stayed on the ANC worklist as if still pregnant, or her record was abandoned.
           'abortion'=>['abortion_care',['episode_id','care_date','ga_weeks','loss_type','presentation',
             'procedure_done','procedure_note','comp_haemorrhage','comp_sepsis','comp_perforation','comp_shock','comp_anaemia',
             'tx_uterotonic','tx_antibiotics','tx_iv_fluids','tx_blood','anti_d_given','hgb','blood_loss_ml',
             'pac_fp_counselled','pac_fp_method','outcome','referred_to','remark','recorded_by']],
           'anc_screening'=>['anc_risk_screening',['episode_id','item_code','item_group','response','recorded_by']],
           'handover'=>['handovers',['episode_id','from_provider_id','to_provider_id','note']],
           // subject/baby_id: a referral can be about the MOTHER or about the NEWBORN. A sick baby
           // referred out used to leave no referral at all — no letter, nothing on the referral
           // list, and no way to record whether he lived.
           'referrals'=>['referrals',['episode_id','referred_to','reason','urgency','transport','feedback','subject','baby_id','recorded_by']],
           // PURGED (v17): hiv_status, syphilis, tetanus_td, iron_folic — legacy fields superseded by the
           // MoH register fields below (hiv_test_result, syphilis_result, td_dose_no, ifa_tabs). No form
           // writes them and nothing reads them. The DB columns stay so historical rows are not lost.
           'anc_visits'=>['anc_visits',['episode_id','visit_date','contact_no','ga_weeks','weight_kg','bp_systolic','bp_diastolic','fundal_height_cm','fetal_heart_rate','presentation','urine_protein','hgb','muac','fetal_movement','malaria_assessed','danger_note','next_appointment','recorded_by',
             // MoH ANC register (v12): 10-18, 20,21,23, counselling 30-34, remark 35
             'ultrasound_lt24w','syphilis_result','syphilis_treated','hepb_result','hepb_treated','hepb_prophylaxis','td_dose_no','ifa_tabs','deworming','hiv_test_accepted','hiv_test_result','hiv_posttest_counselled','cnsl_danger_signs','cnsl_nutrition','cnsl_ecd','cnsl_infant_feeding','cnsl_family_planning','remark',
             // National ANC Guideline 2022, Annex 6 (ANC card) — migration v14
             'calcium_given','ifa_tabs_consumed','anti_d_given','pallor','urine_gramstain','ogtt_result','mental_health','ipv_screen','substance_use','cnsl_lifestyle','cnsl_bpcr','bmi','anaemia_grade','muac_flag',
             // v15 — already-on-ART pathway (no re-testing); unsuppressed VL -> ART clinic
             'art_continued','viral_load','viral_load_date','art_clinic_linked']],
           'labs'=>['lab_orders',['episode_id','anc_visit_id','test_code','requested','requested_date','result','result_date','note','recorded_by']],
           // PURGED (v17): pnc_day — superseded by visit_period (the five MoH PNC periods). Column kept.
           'pnc_visits'=>['pnc_visits',['episode_id','visit_date','m_temp','m_bp_systolic','m_bp_diastolic','m_pulse','bleeding','breast','mood','uterine_tone','perineum','mother_breastfeeding','pp_fp','ifa_continued','nb_temp','nb_feeding','cord','nb_convulsions','nb_fast_breathing','nb_chest_indrawing','nb_lethargy','nb_jaundice','nb_kmc','nb_immunization','nb_eid','danger_note','recorded_by',
             // MoH PNC register (v12): 10,12-17, counselling 25-30, newborn 31-37, IPPFP 38-40, remark 42
             'visit_period','maternal_condition','pph','other_obs_complication','hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_danger_signs','cnsl_breastfeeding','cnsl_newborn_care','cnsl_family_planning','cnsl_epi','cnsl_ecd','nb_weight_g','nb_problems','nb_problem_other','nb_treatment','nb_treatment_outcome','nb_death_age_days','nb_death_cause','ippfp_acceptor','ippfp_method','remark',
             'baby_id']],   // v15 — PNC is for mother AND newborn: tie each assessment to a specific baby (twins)
           // PURGED (v17): enc_vitamin_k -> vitamin_k_time (timing is what matters clinically);
           // enc_arv -> the hiv_exposed / arv_prophylaxis / dbs_* pathway. Columns kept for history.
           'babies'=>['babies',['episode_id','birth_order','sex','weight_g','apgar_1min','apgar_5min','resuscitated','outcome','note','enc_dried','enc_breathing','enc_eye_ointment','enc_cord_care','recorded_by',
             // MoH Delivery register, newborn level (v12): 31,35,52-64
             'mrn','vacc_bcg','vacc_opv0','vacc_hbv','prob_prematurity','prob_sepsis_vsd','prob_resp_distress','prob_lbw','prob_congenital','prob_other','prob_other_text','breastfeed_initiated','resuscitated_survived','death_age_days','death_age_hours','death_cause','birth_notification',
             // v15 — HIV exposure pathway (exposed -> ARV -> DBS -> ART clinic), Vit K timing,
             // conditional care pathways (KMC, phototherapy, NICU, antibiotics, oxygen), free-text "other"
             'hiv_exposed','arv_prophylaxis','dbs_sample','dbs_date','dbs_result','art_linked','art_linked_date',
             'vitamin_k_time','cord_care_other','apgar_flag','kmc','phototherapy','nicu','nicu_facility','antibiotics','oxygen',
             'prob_jaundice']],   // v16 — the Jaundice tick had no column and was silently discarded
           'maternal_vitals'=>['maternal_vitals',['episode_id','obs_datetime','bp_systolic','bp_diastolic','pulse','temperature','resp_rate','spo2','note','recorded_by']],
           'bemonc'=>['bemonc_care',['episode_id','item_code','response','note','recorded_by']],
           'messages'=>['messages',['episode_id','from_user_id','to_user_id','body']]];
  if(isset($simple[$r])){
    [$tbl,$allow]=$simple[$r];
    if($m==='GET'){ require_ep($_GET['episode']??0); $st=db()->prepare("SELECT * FROM `$tbl` WHERE episode_id=? ORDER BY id"); $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    // PATCH is used to fill in a laboratory RESULT against a test requested earlier.
    if($m==='PATCH' && $tbl==='lab_orders' && $id){ $u=require_role(['provider','admin']); $b=body();
      $q=db()->prepare("SELECT episode_id FROM lab_orders WHERE id=?"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('lab order not found',404);
      require_ep($row['episode_id']);
      $f=array_intersect_key($b,array_flip(['result','result_date','note']));
      foreach($f as $k=>$v){ db()->prepare("UPDATE lab_orders SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      audit('result','lab_orders',$id,array_keys($f)); out(['ok'=>true]); }
    // PATCH a clinical row to CORRECT it. Newborn DBS results, delivery details and pregnancy
    // results all come back after the fact; without this the only way to record them was to
    // insert a second row — a phantom twin, a duplicate delivery.
    // maternal_vitals added: the screen can now correct a mistyped BP or temperature, and without this
    // the PATCH fell through to a 404 while the UI reported a save.
    // 'referrals' is here to CLOSE THE LOOP. A referral left the building and nothing ever came back:
    // no record of whether she arrived, what the hospital found, or whether she came home. So the
    // same woman was referred twice for the same thing, and the facility never learned whether
    // referring her had helped. The feedback is recorded onto the referral it belongs to.
    if($m==='PATCH' && in_array($tbl,['babies','delivery_summary','pnc_visits','anc_visits','maternal_vitals','referrals','abortion_care']) && $id){
      $u=require_role(['provider','admin']); $b=body();
      // SELECT * (not just episode_id): the linkage below needs the row's own visit_date when the
      // caller patches only the result and not the date.
      $q=db()->prepare("SELECT * FROM `$tbl` WHERE id=?"); $q->execute([$id]); $row=$q->fetch();
      if(!$row) err('not found',404);
      require_ep($row['episode_id']);
      $f=array_intersect_key($b,array_flip($allow));
      unset($f['episode_id'],$f['recorded_by']);         // never re-parent a row, never forge authorship
      // A CORRECTION can be as mistyped as the original — so validate it. But validate ONLY THE FIELDS
      // THE USER TYPED, not the merged row: a record that already holds a legacy bad value (this is
      // exactly the situation with the three impossible heights) must still be correctable, and
      // validating the merge would refuse the very edit that fixes it.
      $f=blank_to_null($f);
      check_ranges($f,['age']);
      // A VALUE THE COLUMN CANNOT HOLD MUST FAIL AS A 400, NOT A 500.
      //
      // A correction carrying a value outside the column's domain (a code the form does not use, a
      // string too long for the column) raised a PDOException and came back as a bare 500 "server
      // error". That is not just an unhelpful message: the offline queue treats 5xx as "the server is
      // having trouble, try again later" and RETRIES IT FOR EVER. One malformed row from an older
      // build could pin a tablet in a permanent retry loop. A 4xx says "this will never work",
      // which is the truth, and the entry goes to the failed list where a human can see it.
      // (The POST path above already does this; the correction path did not.)
      try{
        foreach($f as $k=>$v){ db()->prepare("UPDATE `$tbl` SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      }catch(\PDOException $e){
        err('One of the values is not valid for this field.',400);
      }

      // A CORRECTION MUST TRIGGER THE SAME CONSEQUENCES AS THE ORIGINAL ENTRY.
      // These linkage functions were wired to POST only. So an ANC visit saved with the HIV result
      // still PENDING, then PATCHed to positive when the lab came back, NEVER set
      // women.hiv_known_positive: she stayed off the high-risk worklist, was re-offered a test at her
      // next contact, and no PMTCT prompt ever fired. The result reached the row and stopped there.
      // A late result is the NORMAL case in a facility without a same-day lab — it is exactly the
      // path that has to work.
      //
      // Note the guards. mark_hiv_positive() sets the flag unconditionally — it is the CALLER that
      // must establish the result is 'P'. Calling it on any edit would mark every woman positive.
      $eid=(int)$row['episode_id'];
      if($tbl==='babies') sync_hiv_from_baby((int)$id);
      if(in_array($tbl,['anc_visits','pnc_visits'],true)){
        if(($f['hiv_test_result']??'')==='P') mark_hiv_positive($eid);   // ONLY on an explicit positive
      }
      if($tbl==='anc_visits' && !empty($f['td_dose_no'])){
        td_to_register($eid,(int)$f['td_dose_no'], ($f['visit_date'] ?? $row['visit_date'] ?? null), $u);
      }

      audit('update',$tbl,$id,array_keys($f)); out(['ok'=>true]); }

    if($m==='POST'){ $clin=['checklist_responses','danger_signs','delivery_summary','anc_risk_screening','referrals','anc_visits','pnc_visits','babies','maternal_vitals','bemonc_care','handovers','lab_orders','messages']; $u = in_array($tbl,$clin)?require_role(['provider','admin']):require_auth(); $b=body();
      $rows = isset($b[0])?$b:[$b];  // accept single object or array (checklist batch)
      // Impossible readings are refused HERE, not only in the browser. `age` is skipped: on an
      // immunization client it means a child (0, or 9-14 for HPV), not a mother.
      $rows = array_map('blank_to_null',$rows);
      foreach($rows as $row){ require_ep($row['episode_id']??0); check_ranges($row,['age']); }
      // ---- ONE TRANSACTION, OR NOTHING ------------------------------------------------------------
      // Three of the writes below DELETE the answer that is already there and then INSERT the
      // replacement. With autocommit, the DELETE lands immediately — so if the INSERT then failed (an
      // over-long free-text answer is enough: MySQL 1406), the previous answer was GONE and nothing had
      // taken its place. A re-save of the ANC risk screening could silently erase a recorded previous
      // caesarean — the strongest single feature the risk model has — and the provider would see only
      // an error, not a loss.
      //
      // The same applies to a batch (the checklist posts an array): row 5 failing used to leave rows
      // 1-4 committed and the request returned an error, so a retry re-inserted them.
      // Now the whole request is one transaction: it either all lands, or the record is untouched.
      $tx = !db()->inTransaction() && db()->beginTransaction();
      try {
      $ids=[]; foreach($rows as $row){ if(in_array('recorded_by',$allow)) $row['recorded_by']=$u['id'];
        if($tbl==='handovers') $row['from_provider_id']=$u['id'];   // sender identity from the session, never caller-supplied
        if($tbl==='messages')  $row['from_user_id']=$u['id'];
        // Screening must be RETRACTABLE. It used to be append-only, so a mis-clicked "yes" flagged
        // her high risk for ever while the screen in front of the provider said "no". The latest
        // answer is the answer.
        if($tbl==='anc_risk_screening' && !empty($row['item_code'])){
          db()->prepare("DELETE FROM anc_risk_screening WHERE episode_id=? AND item_code=?")
              ->execute([$row['episode_id'],$row['item_code']]); }
        // THE CHECKLIST AND BEmONC HAD THE SAME DEFECT and no unique key to stop it: every save
        // appended a fresh set of rows, so a pause point recorded twice held two contradictory
        // answers for the same item and the "checklists completed" count was inflated. Re-saving an
        // item now CORRECTS it. (v26 adds the UNIQUE keys so the database enforces this too.)
        if($tbl==='checklist_responses' && !empty($row['item_code'])){
          db()->prepare("DELETE FROM checklist_responses WHERE episode_id=? AND pause_point=? AND item_code=?")
              ->execute([$row['episode_id'],$row['pause_point']??'',$row['item_code']]); }
        if($tbl==='bemonc_care' && !empty($row['item_code'])){
          db()->prepare("DELETE FROM bemonc_care WHERE episode_id=? AND item_code=?")
              ->execute([$row['episode_id'],$row['item_code']]); }
        $ids[]=insert($tbl,array_intersect_key($row,array_flip($allow))); }

      // ---- write person-level facts back onto the WOMAN, so they follow her ----
      if($tbl==='anc_risk_screening') screening_to_woman((int)($rows[0]['episode_id']??0),$rows);
      // A positive HIV test anywhere in the continuum is a fact about HER, not about the visit.
      // Until now it was written only onto the visit row, so at her next contact the tool offered
      // her an HIV test again, and she never reached the high-risk worklist or PMTCT.
      if(in_array($tbl,['anc_visits','pnc_visits','delivery_summary'])){
        foreach($rows as $row){ if(($row['hiv_test_result']??'')==='P') mark_hiv_positive((int)$row['episode_id']); }
      }
      // A Td dose given in the ANC room belongs in the Td register too, or the register is a lie.
      if($tbl==='anc_visits'){ foreach($rows as $row){ if(!empty($row['td_dose_no'])) td_to_register((int)$row['episode_id'],(int)$row['td_dose_no'],$row['visit_date']??null,$u); } }
      // An HIV-exposed newborn belongs in the HEI cohort, not only on the delivery record.
      if($tbl==='babies'){ foreach($ids as $bid) sync_hiv_from_baby((int)$bid); }
      if($tx) db()->commit();
      } catch (Throwable $e) {
        // The DELETE is rolled back with the failed INSERT: her previous answer is still there.
        if($tx && db()->inTransaction()) db()->rollBack();
        throw $e;                                  // the handler at the foot of this file turns it into a 4xx
      }
      audit('create',$tbl,$ids[0]??null); out(['ids'=>$ids],201); }
  }


  // ---- Module 4: operational intelligence (monthly time-series + anomaly flags) ----
  if ($r==='analytics' && $m==='GET'){ $u=require_auth(); $ids=scoped_facility_ids($u); $in=implode(',',array_fill(0,count($ids),'?'));  // scoped to the user's facility (supervisor: their woreda/zone/region)
    $months=[]; for($i=5;$i>=0;$i--){ $months[]=date('Y-m', strtotime("-$i month")); }
    $series=function($sql) use($months,$ids){ $out=[]; foreach($months as $mo){ $st=db()->prepare($sql); $st->execute(array_merge($ids,[$mo])); $out[]=(int)($st->fetch()['c']??0);} return $out; };
    // Same, for a query that names the month twice (labour monitored under either guideline).
    $series2=function($sql) use($months,$ids){ $out=[]; foreach($months as $mo){ $st=db()->prepare($sql); $st->execute(array_merge($ids,[$mo,$mo])); $out[]=(int)($st->fetch()['c']??0);} return $out; };
    $ind=[
      'labour'=>$series("SELECT COUNT(*) c FROM episodes e WHERE e.voided=0 AND e.facility_id IN ($in) AND e.service_category='labour' AND DATE_FORMAT(e.admission_datetime,'%Y-%m')=?"),
      'deliveries'=>$series("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?"),
      // Labour monitored, under either guideline — the Labour Care Guide now, the partograph before it.
      // $series2 binds the month TWICE (once per EXISTS); $series binds it once, which is why this one
      // has its own runner rather than a clever query.
      'partographs'=>$series2("SELECT COUNT(DISTINCT e.id) c FROM episodes e
                                WHERE e.voided=0 AND e.facility_id IN ($in)
                                  AND ( EXISTS(SELECT 1 FROM lcg_obs o        WHERE o.episode_id=e.id AND DATE_FORMAT(o.recorded_at,'%Y-%m')=?)
                                     OR EXISTS(SELECT 1 FROM partograph_obs o WHERE o.episode_id=e.id AND DATE_FORMAT(o.recorded_at,'%Y-%m')=?) )"),
      'checklists'=>$series("SELECT COUNT(DISTINCT c.episode_id) c FROM checklist_responses c JOIN episodes e ON e.voided=0 AND e.id=c.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(c.recorded_at,'%Y-%m')=?"),
      'amtsl'=>$series("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id IN ($in) AND d.amtsl_uterotonic='done' AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?"),
      'referrals'=>$series("SELECT COUNT(*) c FROM referrals r JOIN episodes e ON e.voided=0 AND e.id=r.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(r.recorded_at,'%Y-%m')=?"),
      'red_alerts'=>$series("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.voided=0 AND e.id=s.episode_id WHERE e.facility_id IN ($in) AND s.band='red' AND DATE_FORMAT(s.scored_at,'%Y-%m')=?"),
      'births'=>$series("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?"),
      // BOTH kinds of stillbirth. This counted only 'fresh_stillbirth', so every macerated stillbirth
      // — a death that occurred before labour, and the one a facility most needs to see — was missing
      // from the stillbirth rate entirely. The newborn screen has always offered both.
      'stillbirths'=>$series("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id IN ($in) AND b.outcome IN ('fresh_stillbirth','macerated_stillbirth') AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?"),  // newborn record = source of truth
      'pnc'=>$series("SELECT COUNT(DISTINCT p.episode_id) c FROM pnc_visits p JOIN episodes e ON e.voided=0 AND e.id=p.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(p.recorded_at,'%Y-%m')=?"),
    ];
    out(['months'=>$months,'indicators'=>$ind]);
  }

  // ---- Family planning, LAFP removal, Immunization ---------------------------
  // These modules serve clients who are NOT necessarily maternity patients: the FP
  // register includes men, and the HPV register is for schoolgirls. So they carry their
  // own client identity, with an optional woman_id linking back when she IS one of ours.
  $mods=[
    'fp_clients'=>['fp_clients',['woman_id','mrn','name','age','sex','reg_date','acceptor','hiv_offered','hiv_performed','hiv_result','hiv_counselled','hiv_linked_art','target_pop_code','td_checked','iud_contraindicated','iud_contra_detail','from_preg_test_id']],
    'fp_visits'=>['fp_visits',['fp_client_id','visit_no','visit_date','method','appointment_date','remark']],
    'lafp'=>['lafp_removals',['woman_id','fp_client_id','mrn','name','age','reg_date','insertion_date','lafp_type','place_code','removal_date','duration_months','removal_reason','hiv_offered','hiv_performed','hiv_result','hiv_counselled','hiv_linked_art','target_pop_code','post_removal_method','remark']],
    'imm_clients'=>['immunization_clients',['woman_id','programme','mrn','name','age','dob','pregnant','in_school_grade','out_of_school','woreda','kebele','ketena','house_no','reg_date','remark']],
    'imm_doses'=>['immunization_doses',['client_id','dose_no','dose_date']],
    // ---- PMTCT: mother, her HIV-exposed infant(s), and the monthly cohort grid ----
    'pmtct'=>['pmtct_mothers',['woman_id','name','mrn','art_number','age','booking_date','newly_diagnosed','known_positive',
        'lnmp','edd','ga_weeks','ifa_provided','syphilis_result','feeding_option',
        'delivery_date','infant_sex','place_of_delivery','delivery_outcome','art_during_labour','infant_arv_prophylaxis',
        'fp_counselled','fp_acceptor','fp_method',
        'partner_accepted','partner_result','partner_target_pop','partner_linked_art',
        'tb_screening','inh_start_date','tb_rx_date','tb_unit_number','cd4_count','who_stage','cpt_started',
        'art_start_date','art_regimen','cnsl_ccd','cnsl_nutrition','remark','cohort_month0']],
    'pmtct_infants'=>['pmtct_infants',['mother_id','baby_id','mrn','infant_dob','hei_enrol_date','arv_start_date','feeding_6m',
        'cpt_age_weeks','pcr_age_weeks','pcr_result','rapid_ab_result','outcome']],
    'pmtct_fu'=>['pmtct_followup',['mother_id','subject','infant_id','month_no','visit_date','status','viral_load','vl_value','note']],
  ];
  if(isset($mods[$r])){
    [$tbl,$allow]=$mods[$r]; $u=require_auth();
    $hasFac=in_array($tbl,['fp_clients','lafp_removals','immunization_clients','pmtct_mothers']);
    // PMTCT child rows hang off the mother, who is the one carrying facility_id
    $pmtctChild = in_array($tbl,['pmtct_infants','pmtct_followup']);
    $ownsMother = function($mid) use($u){ $c=db()->prepare("SELECT id FROM pmtct_mothers WHERE id=? AND facility_id=?"); $c->execute([(int)$mid,$u['facility_id']]); return (bool)$c->fetch(); };
    // PMTCT records clinical results (ART regimen, CD4, viral load, infant DNA/PCR), so it is
    // gated to clinicians like every other clinical table — not to data recorders.
    $pmtctTbl = ($pmtctChild || $tbl==='pmtct_mothers');
    $writeRoles = $pmtctTbl ? ['provider','admin'] : ['recorder','provider','admin'];
    // ...and READING it is gated the same way. Writing PMTCT was already restricted to clinicians,
    // but the GET was open to any authenticated session — so the read-only `observer` and the
    // `recorder` could pull the entire HIV cohort: names, MRNs, ART regimens, CD4, viral loads and
    // infant PCR results. That is the most sensitive data in the system and the least protected.
    if($pmtctTbl && $m==='GET') require_role(['provider','admin']);
    if($m==='GET'){
      // Single mother by id. Without this the client screen had to pick her out of the
      // LIMIT-300 list — so past 300 mothers she resolved to an empty object, showed a
      // false "not on ART" alert, and SAVING blanked nine columns of her real record.
      if($tbl==='pmtct_mothers' && $id){
        $st=db()->prepare("SELECT *,
              (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id) AS infant_count,
              (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id AND i.pcr_result IS NOT NULL) AS pcr_done,
              (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id AND i.pcr_result='P') AS pcr_pos,
              (SELECT f.viral_load FROM pmtct_followup f WHERE f.mother_id=pmtct_mothers.id AND f.subject='mother' AND f.viral_load IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS last_vl,
              (SELECT f.status FROM pmtct_followup f WHERE f.mother_id=pmtct_mothers.id AND f.subject='mother' AND f.status IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS last_status
            FROM pmtct_mothers WHERE id=? AND facility_id=?");
        $st->execute([$id,$u['facility_id']]); $row=$st->fetch();
        if(!$row) err('not found',404);
        out($row);
      }
      if($tbl==='fp_visits'){ $st=db()->prepare("SELECT v.* FROM fp_visits v JOIN fp_clients c ON c.id=v.fp_client_id WHERE c.facility_id=? AND v.fp_client_id=? ORDER BY v.visit_no, v.id");
        $st->execute([$u['facility_id'],(int)($_GET['client']??0)]); out($st->fetchAll()); }
      if($tbl==='immunization_doses'){ $st=db()->prepare("SELECT d.* FROM immunization_doses d JOIN immunization_clients c ON c.id=d.client_id WHERE c.facility_id=? AND d.client_id=? ORDER BY d.dose_no");
        $st->execute([$u['facility_id'],(int)($_GET['client']??0)]); out($st->fetchAll()); }
      if($tbl==='pmtct_infants'){ $st=db()->prepare("SELECT i.* FROM pmtct_infants i JOIN pmtct_mothers p ON p.id=i.mother_id WHERE p.facility_id=? AND i.mother_id=? ORDER BY i.id");
        $st->execute([$u['facility_id'],(int)($_GET['mother']??0)]); out($st->fetchAll()); }
      if($tbl==='pmtct_followup'){ $st=db()->prepare("SELECT f.* FROM pmtct_followup f JOIN pmtct_mothers p ON p.id=f.mother_id WHERE p.facility_id=? AND f.mother_id=? ORDER BY f.subject, f.infant_id, f.month_no");
        $st->execute([$u['facility_id'],(int)($_GET['mother']??0)]); out($st->fetchAll()); }
      // FETCH ONE CLIENT BY ID. The family-planning and immunisation client screens used to pull the
      // LIMIT-300 list and .find() their client in the browser — the same silent failure the clinical
      // screens had: once a facility passes 300 clients, an older woman is not in the list, the find()
      // returns undefined, and the screen renders an EMPTY record. Her method, her visits and her
      // dose history simply disappear, with no error.
      if(!empty($_GET['id'])){
        $one=db()->prepare("SELECT * FROM `$tbl` WHERE id=? AND facility_id=?");
        $one->execute([(int)$_GET['id'], $u['facility_id']]);
        $row=$one->fetch(); if(!$row) err('not found',404);
        out([$row]);
      }
      $q='%'.($_GET['q']??'').'%';
      $extra = ($tbl==='immunization_clients' && !empty($_GET['programme'])) ? " AND programme=".db()->quote($_GET['programme']) : '';
      // the immunization list needs the dose count to show completion at a glance
      $cols = ($tbl==='immunization_clients')
        ? "*, (SELECT COUNT(*) FROM immunization_doses d WHERE d.client_id=`$tbl`.id) AS dose_count"
        : "*";
      // the PMTCT list carries its infants and latest viral load, so the cohort can be read at a glance
      if($tbl==='pmtct_mothers'){
        // pcr_pos is the one that matters: a POSITIVE infant PCR counts as "tested", so
        // without a separate positive count the worklist cleared her flag and painted her
        // green at the exact moment transmission was confirmed. Never again.
        $cols="*, (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id) AS infant_count,
                  (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id AND i.pcr_result IS NOT NULL) AS pcr_done,
                  (SELECT COUNT(*) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id AND i.pcr_result='P') AS pcr_pos,
                  (SELECT MIN(i.infant_dob) FROM pmtct_infants i WHERE i.mother_id=pmtct_mothers.id) AS first_infant_dob,
                  (SELECT f.viral_load FROM pmtct_followup f WHERE f.mother_id=pmtct_mothers.id AND f.subject='mother' AND f.viral_load IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS last_vl,
                  (SELECT f.status FROM pmtct_followup f WHERE f.mother_id=pmtct_mothers.id AND f.subject='mother' AND f.status IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS last_status,
                  (SELECT MAX(f.visit_date) FROM pmtct_followup f WHERE f.mother_id=pmtct_mothers.id AND f.subject='mother') AS last_seen";
      }
      // THE VOID PROMISE APPLIES HERE TOO. A removed patient "disappears from every worklist, search,
      // register, count and export" — except she did not, in any of these modules. They filter on
      // facility_id and never join `women`, so a woman who had been removed as a duplicate stayed fully
      // searchable in FP, LAFP, Immunization and PMTCT, and I found one in the live immunization
      // worklist. The link is optional (the FP register includes men, the HPV register schoolgirls), so
      // a client with NO woman_id is untouched — only a client linked to a REMOVED woman drops out.
      $notVoided = " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=`$tbl`.woman_id AND vw.voided=1)";
      $st=db()->prepare("SELECT $cols FROM `$tbl` WHERE facility_id=?$extra$notVoided AND (COALESCE(mrn,'') LIKE ? OR COALESCE(name,'') LIKE ?) ORDER BY id DESC LIMIT 300");
      $st->execute([$u['facility_id'],$q,$q]); out($st->fetchAll());
    }
    if($m==='POST'){ $u=require_role($writeRoles); $b=body();
      $row=blank_to_null(array_intersect_key($b,array_flip($allow)));
      // Same guard as the maternal tables (viral load, CD4, BP). `age` is skipped on purpose: here it
      // is an immunization client's age — an infant, or a 9-14 year old girl for HPV.
      check_ranges($row,['age']);
      if($hasFac){ $row['facility_id']=$u['facility_id']; }
      $row['recorded_by']=$u['id'];
      // child rows must belong to a client in THIS facility
      if($tbl==='fp_visits'){ $c=db()->prepare("SELECT id FROM fp_clients WHERE id=? AND facility_id=?"); $c->execute([$row['fp_client_id']??0,$u['facility_id']]); if(!$c->fetch()) err('FP client not in your facility',404); }
      if($tbl==='immunization_doses'){ $c=db()->prepare("SELECT id FROM immunization_clients WHERE id=? AND facility_id=?"); $c->execute([$row['client_id']??0,$u['facility_id']]); if(!$c->fetch()) err('immunization client not in your facility',404); }
      if($pmtctChild){
        if(!$ownsMother($row['mother_id']??0)) err('PMTCT client not in your facility',404);
        // An infant_id must belong to THAT mother — otherwise a follow-up row could be
        // hung off someone else's infant.
        if(!empty($row['infant_id'])){
          $c=db()->prepare("SELECT id FROM pmtct_infants WHERE id=? AND mother_id=?");
          $c->execute([(int)$row['infant_id'],(int)$row['mother_id']]);
          if(!$c->fetch()) err('that infant does not belong to this mother',400);
        }
      }
      if($tbl==='pmtct_mothers'){
        if(trim((string)($row['name']??''))==='') err('name is required');
        if(isset($row['age']) && $row['age']!==null && ((int)$row['age']<10 || (int)$row['age']>60)) err('age must be between 10 and 60');
        // Enrolling the same woman twice splits her cohort in half. Refuse it.
        if(!empty($row['art_number'])){
          $c=db()->prepare("SELECT id FROM pmtct_mothers WHERE art_number=? AND facility_id=?");
          $c->execute([$row['art_number'],$u['facility_id']]);
          if($x=$c->fetch()) err('a mother with that ART number is already enrolled (record '.$x['id'].')',409);
        }
        // Month 0 is the shared cohort event for BOTH the maternal and the HEI cohort.
        if(empty($row['cohort_month0'])) $row['cohort_month0']=substr(($row['booking_date']??date('Y-m-d')),0,7);
      }
      // (the woman-record write-back happens after the insert, below — it needs the new id)
      //
      // DELETE-THEN-INSERT INSIDE A TRANSACTION. Both of the replace-in-place writes below used to run
      // under autocommit: the old dose / the old follow-up cell was deleted, and if the insert that was
      // meant to replace it then failed (an over-long note is enough), the answer was simply gone. The
      // transaction makes the pair atomic — either the new value lands, or the old one is still there.
      $tx2 = !db()->inTransaction() && db()->beginTransaction();
      try {
      if($tbl==='immunization_doses'){
        // one row per dose: re-recording a dose updates its date rather than duplicating it
        db()->prepare("DELETE FROM immunization_doses WHERE client_id=? AND dose_no=?")->execute([$row['client_id'],$row['dose_no']]);
      }
      if($tbl==='pmtct_followup'){
        // One cell per subject per month — re-recording a month corrects it, never duplicates it.
        db()->prepare("DELETE FROM pmtct_followup WHERE mother_id=? AND subject=? AND month_no=? AND (infant_id <=> ?)")
            ->execute([$row['mother_id'],$row['subject']??'mother',$row['month_no']??0,$row['infant_id']??null]);
      }
      $id2=insert($tbl,$row);
      if($tx2) db()->commit();
      } catch (Throwable $e) {
        if($tx2 && db()->inTransaction()) db()->rollBack();
        throw $e;
      }
      // PMTCT ENROLMENT MUST REACH HER MATERNITY RECORD. Until now it did not: she was enrolled
      // in PMTCT and her `women` row still said nothing about HIV — so at her next ANC contact
      // the tool offered a woman on ART an HIV test, she never appeared on the high-risk
      // worklist, and her delivery and PNC screens printed "HIV: —".
      if($tbl==='pmtct_mothers' && !empty($row['woman_id'])){
        db()->prepare("UPDATE women SET hiv_known_positive=1, hiv_linked_pmtct=1, art_regimen=COALESCE(NULLIF(?,''),art_regimen) WHERE id=? AND facility_id=?")
            ->execute([$row['art_regimen']??'', (int)$row['woman_id'], $u['facility_id']]);
      }
      audit('create',$tbl,$id2); out(['id'=>$id2],201); }
    if($m==='PATCH' && $id){ $u=require_role($writeRoles); $b=body();
      if($hasFac){ $c=db()->prepare("SELECT id FROM `$tbl` WHERE id=? AND facility_id=?"); $c->execute([$id,$u['facility_id']]); if(!$c->fetch()) err('not in your facility',404); }
      if($pmtctChild){ $c=db()->prepare("SELECT p.id FROM `$tbl` x JOIN pmtct_mothers p ON p.id=x.mother_id WHERE x.id=? AND p.facility_id=?");
        $c->execute([$id,$u['facility_id']]); if(!$c->fetch()) err('not in your facility',404); }
      // fp_visits and immunization_doses carry no facility_id of their own, and neither of the
      // checks above covered them — so ANY authenticated user at ANY facility could overwrite
      // another facility's FP visit or immunization dose by guessing an integer id, corrupting
      // their MoH register export. Check ownership through the parent.
      if($tbl==='fp_visits'){ $c=db()->prepare("SELECT v.id FROM fp_visits v JOIN fp_clients c ON c.id=v.fp_client_id WHERE v.id=? AND c.facility_id=?");
        $c->execute([$id,$u['facility_id']]); if(!$c->fetch()) err('not in your facility',404); }
      if($tbl==='immunization_doses'){ $c=db()->prepare("SELECT d.id FROM immunization_doses d JOIN immunization_clients c ON c.id=d.client_id WHERE d.id=? AND c.facility_id=?");
        $c->execute([$id,$u['facility_id']]); if(!$c->fetch()) err('not in your facility',404); }
      $f=array_intersect_key($b,array_flip($allow));
      // A row's OWNER is never patchable. The ownership check above proves the row is yours
      // NOW; letting mother_id/infant_id/woman_id through would let you re-parent it into
      // another facility's chart afterwards — injecting a fabricated PCR result into their
      // worklist and their register. Strip them.
      unset($f['mother_id'], $f['infant_id'], $f['woman_id'], $f['fp_client_id']);
      foreach($f as $k=>$v){ db()->prepare("UPDATE `$tbl` SET `$k`=? WHERE id=?")->execute([$v,$id]); }
      audit('update',$tbl,$id,array_keys($f)); out(['ok'=>true]); }
  }

  // ---- Facility overview: themed counts for the dashboard --------------------
  // Grouped by theme so the dashboard can answer: how many were high risk, what
  // happened to them, how they delivered, and whether the process of care was followed.
  if ($r==='overview' && $m==='GET'){ $u=require_auth(); $fid=(int)$u['facility_id'];
    $days=(int)($_GET['days']??0); if($days<0)$days=0; if($days>3660)$days=3660;
    $since = $days>0 ? " AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)" : "";
    $one=function($sql) use($fid){ $st=db()->prepare($sql); $st->execute([$fid]); $r=$st->fetch(); return (int)($r['c']??0); };
    $grp=function($sql) use($fid){ $st=db()->prepare($sql); $st->execute([$fid]); $o=[]; foreach($st->fetchAll() as $x){ $o[(string)$x['k']]=(int)$x['c']; } return $o; };
    // A REMOVED PATIENT MUST NOT GO ON BEING COUNTED. The maternity blocks all resolve through
    // episodes/women and were already clean; the FP, LAFP, immunization, pregnancy-test and PMTCT
    // counts below read their own client tables directly and never joined `women` — so a woman voided
    // as a duplicate still inflated every one of those tiles. In all of these queries the client table
    // is aliased `e` and carries an optional woman_id: a client with no linked patient record (a man in
    // the FP register, a schoolgirl in the HPV register) is untouched.
    $nvE = " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=e.woman_id AND vw.voided=1)";
    // ONE definition, shared with the worklist. This used to be a second, episode-scoped copy that
    // omitted severe hypertension and proteinuria entirely — so the number on this dashboard and the
    // list of women the provider actually works from were computed from different rules.
    $hrx = hr_sql();
    out([
     'days'=>$days,
     'caseload'=>[
       'anc'      =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.voided=0 AND e.facility_id=? AND e.service_category='anc'$since"),
       'labour'   =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.voided=0 AND e.facility_id=? AND e.service_category='labour'$since"),
       'pnc'      =>$one("SELECT COUNT(DISTINCT p.episode_id) c FROM pnc_visits p JOIN episodes e ON e.voided=0 AND e.id=p.episode_id WHERE e.facility_id=?$since"),
       'deliveries'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=?$since"),
       // ...AND the same SCOPE as the worklist. With the rule unified but the scope still different,
       // the tile counted every high-risk episode ever (13) while the worklist a provider clicks
       // through to shows only the ones still in her care (8) — the same confusing mismatch, for a new
       // reason. A closed episode is finished care: it belongs in the register, not on a worklist tile.
       'high_risk'=>$one("SELECT COUNT(*) c FROM episodes e JOIN women w ON w.id=e.woman_id WHERE e.voided=0 AND w.voided=0 AND e.facility_id=? AND e.status <> 'closed' AND $hrx$since"),
       'total'    =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.voided=0 AND e.facility_id=?$since"),
     ],
     'mode_of_delivery'=>$grp("SELECT d.mode k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.mode IS NOT NULL$since GROUP BY d.mode"),
     'birth_outcome'  =>$grp("SELECT b.outcome k, COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.outcome IS NOT NULL$since GROUP BY b.outcome"),
     'maternal_outcome'=>$grp("SELECT d.maternal_status k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.maternal_status IS NOT NULL$since GROUP BY d.maternal_status"),
     'complications'=>[
       'pre_eclampsia'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.comp_preeclampsia=1$since"),
       'eclampsia'    =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.comp_eclampsia=1$since"),
       'aph'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.comp_aph=1$since"),
       'pph'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.comp_pph=1$since"),
       'other'        =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.comp_other=1$since"),
     ],
     'process'=>[
       'partograph_used'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.partograph_used='Y'$since"),
       'amtsl'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.amtsl_uterotonic='done'$since"),
       'checklist'      =>$one("SELECT COUNT(DISTINCT c.episode_id) c FROM checklist_responses c JOIN episodes e ON e.voided=0 AND e.id=c.episode_id WHERE e.facility_id=?$since"),
       'referred'       =>$one("SELECT COUNT(*) c FROM referrals rf JOIN episodes e ON e.voided=0 AND e.id=rf.episode_id WHERE e.facility_id=?$since"),
       // The loop that never closed: referrals with nothing back from the receiving facility.
       'referral_no_feedback'=>$one("SELECT COUNT(*) c FROM referrals rf JOIN episodes e ON e.voided=0 AND e.id=rf.episode_id JOIN women w ON w.voided=0 AND w.id=e.woman_id WHERE e.facility_id=? AND (rf.feedback IS NULL OR rf.feedback='')$since"),
       'red_alerts'     =>$one("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.voided=0 AND e.id=s.episode_id WHERE e.facility_id=? AND s.band='red'$since"),
     ],
     'ippfp'=>$grp("SELECT d.ippfp_method k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id=? AND d.ippfp_method IS NOT NULL$since GROUP BY d.ippfp_method"),

     // ---- The pregnancy that ends early, and the woman who dies ----
     // A facility that cannot see its losses and its deaths cannot act on them. Post-abortion
     // contraception in particular is a rate the facility should be watching: she is fertile again
     // in two weeks, and she is standing in front of you now.
     'loss'=>[
       'total'        =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=?$since"),
       'spontaneous'  =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND a.loss_type='spontaneous'$since"),
       'induced'      =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND a.loss_type='induced'$since"),
       'unsafe'       =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND a.loss_type='unsafe'$since"),
       'ectopic'      =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND a.loss_type='ectopic'$since"),
       'complications'=>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND (a.comp_haemorrhage=1 OR a.comp_sepsis=1 OR a.comp_shock=1 OR a.comp_perforation=1)$since"),
       'pac_fp'       =>$one("SELECT COUNT(*) c FROM abortion_care a JOIN episodes e ON e.voided=0 AND e.id=a.episode_id WHERE e.facility_id=? AND a.pac_fp_method IS NOT NULL AND a.pac_fp_method<>'none'$since"),
     ],
     'maternal_deaths'=>[
       'total'      =>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=?".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'antenatal'  =>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=? AND d.phase='antenatal'".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'abortion'   =>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=? AND d.phase='abortion_related'".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'intrapartum'=>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=? AND d.phase='intrapartum'".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'postpartum' =>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=? AND d.phase='postpartum'".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'not_reported'=>$one("SELECT COUNT(*) c FROM maternal_deaths d JOIN women w ON w.voided=0 AND w.id=d.woman_id WHERE d.facility_id=? AND d.reported_mdsr=0".($days>0?" AND d.death_datetime >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
     ],
     // ---- Family planning ----
     'fp'=>[
       'clients'      =>$one("SELECT COUNT(*) c FROM fp_clients e WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'new_acceptor' =>$one("SELECT COUNT(*) c FROM fp_clients e WHERE e.facility_id=? AND e.acceptor='new'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'repeat_acceptor'=>$one("SELECT COUNT(*) c FROM fp_clients e WHERE e.facility_id=? AND e.acceptor='repeat'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'lafp_removals'=>$one("SELECT COUNT(*) c FROM lafp_removals e WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
     ],
     'fp_methods'=>$grp("SELECT v.method k, COUNT(*) c FROM fp_visits v JOIN fp_clients e ON e.id=v.fp_client_id WHERE e.facility_id=? AND v.method IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")." GROUP BY v.method"),
     'lafp_reasons'=>$grp("SELECT e.removal_reason k, COUNT(*) c FROM lafp_removals e WHERE e.facility_id=? AND e.removal_reason IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")." GROUP BY e.removal_reason"),

     // ---- Immunization ----
     'immunization'=>[
       'td_clients' =>$one("SELECT COUNT(*) c FROM immunization_clients e WHERE e.facility_id=? AND e.programme='Td'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'td2_plus'   =>$one("SELECT COUNT(*) c FROM immunization_clients e WHERE e.facility_id=? AND e.programme='Td' AND (SELECT COUNT(*) FROM immunization_doses d WHERE d.client_id=e.id)>=2".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'td_pregnant'=>$one("SELECT COUNT(*) c FROM immunization_clients e WHERE e.facility_id=? AND e.programme='Td' AND e.pregnant=1".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'hpv_girls'  =>$one("SELECT COUNT(*) c FROM immunization_clients e WHERE e.facility_id=? AND e.programme='HPV'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'hpv_complete'=>$one("SELECT COUNT(*) c FROM immunization_clients e WHERE e.facility_id=? AND e.programme='HPV' AND (SELECT COUNT(*) FROM immunization_doses d WHERE d.client_id=e.id)>=2".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
     ],

     // ---- Pregnancy test: the front door, and whether both exits are used ----
     'pregnancy_test'=>[
       'tested'   =>$one("SELECT COUNT(*) c FROM pregnancy_tests e WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'positive' =>$one("SELECT COUNT(*) c FROM pregnancy_tests e WHERE e.facility_id=? AND e.result='positive'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'negative' =>$one("SELECT COUNT(*) c FROM pregnancy_tests e WHERE e.facility_id=? AND e.result='negative'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'linked_anc'=>$one("SELECT COUNT(*) c FROM pregnancy_tests e WHERE e.facility_id=? AND e.linked_episode_id IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'negative_to_fp'=>$one("SELECT COUNT(*) c FROM pregnancy_tests e WHERE e.facility_id=? AND e.result='negative' AND e.linked_fp_client_id IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
     ],

     // ---- PMTCT: the cascade, mother and infant ----
     // The only questions that matter: is she on ART and suppressed, and did the infant
     // get tested at ~6 weeks and end up negative?
     'pmtct'=>[
       'mothers'      =>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'newly_diagnosed'=>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND e.newly_diagnosed IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'known_positive'=>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND e.known_positive IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'on_art'       =>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND (e.art_start_date IS NOT NULL OR e.known_positive=1)".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'art_in_labour'=>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND e.art_during_labour='Y'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       // These MUST read the LATEST value per mother, not "ever". Counting "ever" meant a woman
       // who suppressed at month 3 and rebounded at month 9 was counted as suppressed AND
       // detectable, and a woman traced back after being lost stayed "lost" forever —
       // systematically overstating suppression, which is the headline PMTCT indicator.
       'vl_done'      =>$one("SELECT COUNT(DISTINCT f.mother_id) c FROM pmtct_followup f JOIN pmtct_mothers e ON e.id=f.mother_id WHERE e.facility_id=? AND f.subject='mother' AND f.viral_load IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'vl_suppressed'=>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND (SELECT f.viral_load FROM pmtct_followup f WHERE f.mother_id=e.id AND f.subject='mother' AND f.viral_load IS NOT NULL ORDER BY f.month_no DESC LIMIT 1)='undetectable'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'vl_detectable'=>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND (SELECT f.viral_load FROM pmtct_followup f WHERE f.mother_id=e.id AND f.subject='mother' AND f.viral_load IS NOT NULL ORDER BY f.month_no DESC LIMIT 1)='detectable'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'ltf'          =>$one("SELECT COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND (SELECT f.status FROM pmtct_followup f WHERE f.mother_id=e.id AND f.subject='mother' AND f.status IS NOT NULL ORDER BY f.month_no DESC LIMIT 1)='ltf'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       // Transmission that already happened — the number this module exists to drive to zero.
       'infant_positive'=>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.pcr_result='P'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'infants'      =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'infant_arv'   =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.arv_start_date IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'pcr_done'     =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.pcr_result IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       // EID timeliness: the DNA/PCR is meant to happen at about 6 weeks of age
       'pcr_by_8wk'   =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.pcr_result IS NOT NULL AND i.pcr_age_weeks<=8".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'pcr_positive' =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.pcr_result='P'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'infant_cpt'   =>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.cpt_age_weeks IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'discharged_neg'=>$one("SELECT COUNT(*) c FROM pmtct_infants i JOIN pmtct_mothers e ON e.id=i.mother_id WHERE e.facility_id=? AND i.outcome='discharged_negative'".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
     ],
     'pmtct_entry'=>$grp("SELECT CASE e.newly_diagnosed WHEN 1 THEN 'ANC' WHEN 2 THEN 'Labour & delivery' WHEN 3 THEN 'Postpartum' ELSE 'Known positive' END k, COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=?".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")." GROUP BY k"),
     'pmtct_feeding'=>$grp("SELECT e.feeding_option k, COUNT(*) c FROM pmtct_mothers e WHERE e.facility_id=? AND e.feeding_option IS NOT NULL".$nvE.($days>0?" AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")." GROUP BY e.feeding_option"),

     'newborn_care'=>[
       'lbw'         =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.prob_lbw=1$since"),
       'kmc'         =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.kmc='initiated'$since"),
       'phototherapy'=>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.phototherapy='given'$since"),
       'nicu'        =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.nicu IN ('admitted','referred_out')$since"),
       'hiv_exposed' =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.hiv_exposed=1$since"),
       'dbs_sent'    =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.dbs_sample='sent'$since"),
       'low_apgar'   =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id=? AND b.apgar_flag='low'$since"),
     ],

     // ---- PRECONCEPTION CARE ----
     // The left half is what we DELIVERED (pcc_assessments). The right half is what women arriving at
     // ANC say was done for them BEFORE they conceived (pcc_uptake) — which is where the national
     // indicators live, and where a facility can see whether preconception care is actually reaching
     // the women who go on to be pregnant. The PCC row is aliased `e` so the $nvE guard applies as it
     // does everywhere else on this screen: a voided woman is counted nowhere.
     'pcc'=>[
       'assessments'  =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'women'        =>$one("SELECT COUNT(DISTINCT e.woman_id) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'folate_started'=>$one("SELECT COUNT(DISTINCT e.woman_id) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.folate_dose IN ('0.4mg','5mg')".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'folate_high'  =>$one("SELECT COUNT(DISTINCT e.woman_id) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.folate_dose='5mg'".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'defer'        =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.readiness='defer'".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'optimize'     =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.readiness='optimize'".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'ready'        =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.readiness='ready'".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       // An assessment that could not be completed because a test was not available. This number is
       // the facility's own lab gap, said out loud instead of being hidden inside a green tick.
       'incomplete'   =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.readiness='incomplete'".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'couple_counselled'=>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.couple_counselled=1".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),   // Table 7 indicator 5
       // The facility's own laboratory gap. Read off `cannot_assess`, NOT off readiness='incomplete':
       // `optimize` outranks `incomplete`, so a woman with an untested HBsAg AND a raised BMI is filed
       // as `optimize` and would have vanished from the very count that exists to measure the gap.
       'gaps'         =>$one("SELECT COUNT(*) c FROM pcc_assessments e WHERE e.facility_id=? AND e.voided=0 AND e.cannot_assess IS NOT NULL AND e.cannot_assess<>''".$nvE.($days>0?" AND e.contact_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       // ---- uptake at ANC (Table 8) — the national indicators ----
       // `AND ep.voided=0`: an uptake row on a VOIDED EPISODE is not part of the record. Without the
       // join it stayed in the numerator while its episode dropped out of the denominator, so the
       // "asked at ANC" percentage could exceed 100% — and the export, the chart and this screen gave
       // three different answers for the same facility.
       'asked'        =>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'uptake_none'  =>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0 AND e.status='none'".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'uptake_partial'=>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0 AND e.status='partial'".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'uptake_optimal'=>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0 AND e.status='optimal'".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),
       'planned_preg' =>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0 AND e.planned_pregnancy=1".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),  // Table 7 indicator 2
       'ifa_before'   =>$one("SELECT COUNT(*) c FROM pcc_uptake e JOIN episodes ep ON ep.id=e.episode_id AND ep.voided=0 WHERE e.facility_id=? AND e.voided=0 AND e.i3_folic_acid=1".$nvE.($days>0?" AND e.asked_date >= DATE_SUB(CURDATE(), INTERVAL $days DAY)":"")),  // Table 7 indicator 3
     ],
    ]);
  }

  // ---- Pregnancy test (OPD) and the link into the ANC room -------------------
  // "If a mother's pregnancy test is positive in OPD, how can we link her to the ANC
  //  room?" — a positive test can open an ANC episode for her directly, so the
  //  handoff is recorded rather than relying on her walking down the corridor.
  if ($r==='pregnancy_tests'){
    if($m==='GET'){ $u=require_auth();
      // A removed patient carries her pregnancy test off this list with her (w.voided=0). A test with
      // no woman attached at all is still shown — the LEFT JOIN is deliberate.
      $st=db()->prepare("SELECT p.*, w.mrn, w.first_name, w.father_name, w.age
                           FROM pregnancy_tests p LEFT JOIN women w ON w.id=p.woman_id
                          WHERE p.facility_id=? AND (w.id IS NULL OR w.voided=0) ORDER BY p.id DESC LIMIT 200");
      $st->execute([$u['facility_id']]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wid=(int)($b['woman_id']??0);
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=? AND voided=0"); $wc->execute([$wid,$u['facility_id']]);
      if(!$wc->fetch()) err('woman not in your facility',404);
      // 'pending' is the NORMAL state. She is registered at the desk, walks to the lab, and the
      // strip is read later. The tool used to refuse to save a test without a result, so she
      // could not be registered at all until it was known — and there was no way to add it
      // afterwards, because this route had no PATCH.
      $res=$b['result']??'pending'; if($res==='') $res='pending';
      $pid=insert('pregnancy_tests',['facility_id'=>$u['facility_id'],'woman_id'=>$wid,
        'test_date'=>($b['test_date']??date('Y-m-d')),'result'=>$res,
        'resulted_at'=>($res==='pending'?null:date('Y-m-d H:i:s')),
        'note'=>($b['note']??null),'recorded_by'=>$u['id']]);
      [$eid,$fpid]=pregtest_link($pid,$wid,$res,$b,$u);
      audit('create','pregnancy_tests',$pid); out(['id'=>$pid,'result'=>$res,'episode_id'=>$eid,'fp_client_id'=>$fpid],201); }

    // The result comes back from the lab. THIS is where she is routed.
    if($m==='PATCH' && $id){ $u=require_role(['recorder','provider','admin']); $b=body();
      $q=db()->prepare("SELECT * FROM pregnancy_tests WHERE id=? AND facility_id=?");
      $q->execute([$id,$u['facility_id']]); $t=$q->fetch();
      if(!$t) err('pregnancy test not found',404);
      $res=$b['result']??''; if(!in_array($res,['pending','positive','negative'])) err('result must be pending, positive or negative');
      db()->prepare("UPDATE pregnancy_tests SET result=?, resulted_at=?, note=COALESCE(NULLIF(?,''),note) WHERE id=?")
          ->execute([$res, ($res==='pending'?null:date('Y-m-d H:i:s')), ($b['note']??''), $id]);
      [$eid,$fpid]=pregtest_link((int)$id,(int)$t['woman_id'],$res,$b,$u);
      audit('result','pregnancy_tests',$id,['result'=>$res]);
      out(['ok'=>true,'result'=>$res,'episode_id'=>$eid,'fp_client_id'=>$fpid]); }
  }

  // ---- MoH paper-register export -------------------------------------------
  // Reproduces the official Ethiopian MoH ANC / Delivery / PNC registers from the
  // captured record, so a facility no longer hand-writes them. Person-level items
  // (target population, HIV linkage, partner) are replayed from `women` onto every
  // row, exactly as the paper repeats them.
  // THE REGISTER EXPORT IS A LINE LIST. It returns names, MRNs, HIV status, ART regimen and partner
  // HIV result for the whole facility — the most sensitive data in the system, in one download. It
  // was gated on require_auth() alone, so the read-only OBSERVER role could pull it, and so could a
  // recorder whose job is registration. It is correctly scoped to the caller's own facility, so this
  // was never a cross-facility leak — but "any account at this facility" is too wide a door for a
  // facility-wide HIV line list.
  if ($r==='registers' && $m==='GET'){ $u=require_role(['provider','supervisor','admin']);
    $type=$_GET['type']??'anc'; $fac=(int)$u['facility_id'];
    $from=$_GET['from']??date('Y-m-01'); $to=$_GET['to']??date('Y-m-d');
    if(!preg_match('/^\d{4}-\d{2}-\d{2}$/',$from)||!preg_match('/^\d{4}-\d{2}-\d{2}$/',$to)) err('bad date range');
    $W="w.mrn,w.first_name,w.father_name,w.age,w.kebele,w.woreda,w.lnmp,w.edd,
        w.ga_first_contact,w.late_anc_initiation,
        w.target_pop_code,w.hiv_known_positive,w.hiv_linked_pmtct,w.hiv_linked_pmtct_facility,w.hiv_linked_art,w.art_regimen,
        w.partner_hiv_accepted,w.partner_hiv_result,w.partner_target_pop_code,w.partner_linked_art";
    if($type==='anc'){
      $st=db()->prepare("SELECT a.*, $W FROM anc_visits a
        JOIN episodes e ON e.voided=0 AND e.id=a.episode_id JOIN women w ON w.id=e.woman_id
        WHERE e.facility_id=? AND a.visit_date BETWEEN ? AND ? ORDER BY w.mrn, a.contact_no, a.visit_date");
    } elseif($type==='delivery'){
      // one row per newborn — the register says "use consecutive rows for each newborn"
      // b.mrn is the NEWBORN's; w.mrn is the mother's. Alias the newborn's so the
      // mother's (selected later in $W) doesn't overwrite it in the fetched row.
      // THE REGISTER IS DRIVEN BY THE DELIVERY, NOT BY THE BABY.
      // This used to read FROM babies, so a delivery with no newborn row produced NO LINE AT ALL:
      // an emergency caesarean where the mother was transferred before the baby was recorded, an
      // early pregnancy loss, or — worst — a MATERNAL DEATH with no live newborn simply vanished from
      // the MoH register. Now every delivery yields a line (with the newborn columns blank if there is
      // no baby row), and the second arm still catches a newborn recorded without a delivery summary,
      // so nothing that was visible before is lost.
      $DCOLS="d.delivery_datetime, d.mode, d.mode_other_text, d.partograph_used, d.episiotomy,
          d.amtsl_uterotonic_type, d.amtsl_cct, d.maternal_status, d.maternal_death_cause,
          d.comp_preeclampsia, d.comp_eclampsia, d.comp_aph, d.comp_pph, d.comp_other, d.referred,
          d.hiv_test_accepted, d.hiv_retest_accepted, d.hiv_test_result, d.cnsl_feeding_options,
          d.ippfp_acceptor, d.ippfp_method, d.remark AS delivery_remark";
      // `b.*` carries the NEWBORN's mrn and $W carries the MOTHER's, so the result set holds TWO columns
      // named `mrn`. PHP's assoc fetch resolves that (last wins = the mother's, which is what the
      // register wants), but `ORDER BY mrn` could not: MySQL raised 1052 "column 'mrn' in order clause
      // is ambiguous" and the WHOLE delivery register returned a 500 — the facility could not print it
      // at all. Order by an alias that exists exactly once instead. `b.*` is kept, because the register
      // renderer reads newborn columns (vitamin_k_time, enc_*, kmc…) straight off it.
      $st=db()->prepare(
        "SELECT b.*, b.mrn AS mrn_baby, w.mrn AS mrn_mother, $DCOLS, $W
           FROM delivery_summary d
           JOIN episodes e ON e.voided=0 AND e.id=d.episode_id
           JOIN women   w ON w.id=e.woman_id
           LEFT JOIN babies b ON b.episode_id=d.episode_id
          WHERE e.facility_id=? AND DATE(d.delivery_datetime) BETWEEN ? AND ?
         UNION ALL
         SELECT b.*, b.mrn AS mrn_baby, w.mrn AS mrn_mother, $DCOLS, $W
           FROM babies b
           JOIN episodes e ON e.voided=0 AND e.id=b.episode_id
           JOIN women   w ON w.id=e.woman_id
           LEFT JOIN delivery_summary d ON d.episode_id=b.episode_id
          WHERE e.facility_id=? AND d.id IS NULL AND DATE(b.recorded_at) BETWEEN ? AND ?
         ORDER BY delivery_datetime, mrn_mother, birth_order");
    } elseif($type==='pnc'){
      $st=db()->prepare("SELECT p.*, e.place_of_delivery, e.infant_dob, $W FROM pnc_visits p
        JOIN episodes e ON e.voided=0 AND e.id=p.episode_id JOIN women w ON w.id=e.woman_id
        WHERE e.facility_id=? AND p.visit_date BETWEEN ? AND ? ORDER BY w.mrn, p.visit_date");
    } elseif($type==='fp'){
      // NOT_VOIDED: a removed patient must not print into an MoH register. The ANC, delivery and PNC
      // registers exclude her (through e.voided=0); these four did not, so she was removed from the
      // maternity record and went on being reported to the Ministry from the FP, LAFP, immunization
      // and PMTCT registers. A client with no woman_id (a man in the FP register, a schoolgirl in the
      // HPV register) is not linked to a patient record and is unaffected.
      $nv = function($alias){ return " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=$alias.woman_id AND vw.voided=1)"; };
      // One row per FP visit (the paper register gives each client up to 5 visit rows).
      $st=db()->prepare("SELECT v.*, c.mrn, c.name, c.age, c.sex, c.reg_date, c.acceptor,
             c.hiv_offered, c.hiv_performed, c.hiv_result, c.hiv_counselled, c.hiv_linked_art,
             c.target_pop_code, c.td_checked, c.iud_contraindicated
        FROM fp_visits v JOIN fp_clients c ON c.id=v.fp_client_id
       WHERE c.facility_id=?".$nv('c')." AND v.visit_date BETWEEN ? AND ? ORDER BY c.mrn, v.visit_no");
    } elseif($type==='lafp'){
      $nv = function($alias){ return " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=$alias.woman_id AND vw.voided=1)"; };
      $st=db()->prepare("SELECT * FROM lafp_removals l WHERE l.facility_id=?".$nv('l')." AND l.removal_date BETWEEN ? AND ? ORDER BY l.removal_date, l.mrn");
    } elseif($type==='td' || $type==='hpv'){
      $nv = function($alias){ return " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=$alias.woman_id AND vw.voided=1)"; };
      $prog = ($type==='td') ? 'Td' : 'HPV';
      $st=db()->prepare("SELECT c.*,
             MAX(CASE WHEN d.dose_no=1 THEN d.dose_date END) AS dose1,
             MAX(CASE WHEN d.dose_no=2 THEN d.dose_date END) AS dose2,
             MAX(CASE WHEN d.dose_no=3 THEN d.dose_date END) AS dose3,
             MAX(CASE WHEN d.dose_no=4 THEN d.dose_date END) AS dose4,
             MAX(CASE WHEN d.dose_no=5 THEN d.dose_date END) AS dose5
        FROM immunization_clients c LEFT JOIN immunization_doses d ON d.client_id=c.id
       WHERE c.facility_id=? AND c.programme=".db()->quote($prog).$nv('c')."
         AND (c.reg_date BETWEEN ? AND ? OR d.dose_date BETWEEN ".db()->quote($from)." AND ".db()->quote($to).")
       GROUP BY c.id ORDER BY c.mrn");
    } elseif($type==='pmtct'){
      $nv = function($alias){ return " AND NOT EXISTS(SELECT 1 FROM women vw WHERE vw.id=$alias.woman_id AND vw.voided=1)"; };
      // One row per HIV-exposed infant, falling back to a mother-only row when she has not
      // yet delivered — the paper register works the same way: the mother's line is opened at
      // booking and the infant columns are filled in later.
      $st=db()->prepare("SELECT p.*, i.id AS infant_row_id, i.mrn AS infant_mrn, i.infant_dob, i.hei_enrol_date, i.arv_start_date,
             i.feeding_6m, i.cpt_age_weeks, i.pcr_age_weeks, i.pcr_result, i.rapid_ab_result, i.outcome AS infant_outcome,
             (SELECT f.viral_load FROM pmtct_followup f WHERE f.mother_id=p.id AND f.subject='mother' AND f.viral_load IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS last_vl,
             (SELECT f.status FROM pmtct_followup f WHERE f.mother_id=p.id AND f.subject='mother' AND f.status IS NOT NULL ORDER BY f.month_no DESC LIMIT 1) AS mother_status
        FROM pmtct_mothers p LEFT JOIN pmtct_infants i ON i.mother_id=p.id
       WHERE p.facility_id=?".$nv('p')." AND COALESCE(p.booking_date, DATE(p.created_at)) BETWEEN ? AND ?
       ORDER BY p.booking_date, p.id, i.id");
    } elseif($type==='pregtally'){
      // The MoH pregnancy-test artifact is a TALLY SHEET, not a line register:
      // women tested and HCG positive, by age band. Computed from the per-client records.
      $st=db()->prepare("SELECT
          CASE WHEN w.age BETWEEN 10 AND 14 THEN '10-14'
               WHEN w.age BETWEEN 15 AND 19 THEN '15-19'
               WHEN w.age >= 20            THEN '20+'
               ELSE 'unknown' END AS band,
          COUNT(*) AS tested,
          SUM(p.result='positive') AS positive,
          SUM(p.result='negative') AS negative,
          SUM(p.result='negative' AND p.fp_offered=1) AS negative_offered_fp,
          SUM(p.linked_episode_id IS NOT NULL) AS linked_to_anc,
          SUM(p.linked_fp_client_id IS NOT NULL) AS linked_to_fp
        FROM pregnancy_tests p JOIN women w ON w.voided=0 AND w.id=p.woman_id
       WHERE p.facility_id=? AND p.test_date BETWEEN ? AND ?
       GROUP BY band ORDER BY band");
    } else err('unknown register type');
    // The delivery register is a UNION of two arms (deliveries, then any newborn with no delivery
    // row), so it binds the facility and the date range twice.
    $st->execute($type==='delivery' ? [$fac,$from,$to,$fac,$from,$to] : [$fac,$from,$to]);
    $rows=$st->fetchAll();
    out(['type'=>$type,'from'=>$from,'to'=>$to,'facility'=>$u['facility_name']??'','count'=>count($rows),'rows'=>$rows]);
  }

  // ---- DHIS2 indicator export (aggregate) ----
  if ($r==='dhis2' && $m==='GET'){ $u=require_auth(); $ids=scoped_facility_ids($u); $in=implode(',',array_fill(0,count($ids),'?'));  // scoped to the user's facility / supervisor scope
    $fac=$_GET['facility']??$u['facility_id']; $period=$_GET['period']??date('Y-m');
    $one=function($sql,$p) use($ids){ $st=db()->prepare($sql); $st->execute(array_merge($ids,[$p])); return (int)($st->fetch()['c']??0); };
    $ind=[
      'deliveries'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?",$period),
      // DHIS2 reports fresh and macerated stillbirths as SEPARATE data elements, so they stay split
      // here — but macerated was simply never exported at all, which under-reported the facility's
      // stillbirths to the national system.
      'fresh_stillbirths'=>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id IN ($in) AND b.outcome='fresh_stillbirth' AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?",$period),  // newborn record = source of truth
      'macerated_stillbirths'=>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.voided=0 AND e.id=b.episode_id WHERE e.facility_id IN ($in) AND b.outcome='macerated_stillbirth' AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?",$period),
      'red_alerts'=>$one("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.voided=0 AND e.id=s.episode_id WHERE e.facility_id IN ($in) AND s.band='red' AND DATE_FORMAT(s.scored_at,'%Y-%m')=?",$period),
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

  // ---- offline sync (batch apply queued entries) --------------------------------------------------
  // THE REPLAY PATH USED A SHORTER ALLOW-LIST THAN THE WRITE PATH, AND NOBODY COULD SEE IT.
  //
  // The partograph write accepted 22 columns. This one accepted 10. Every field in between —
  // amniotic fluid (so, meconium), caput, descent, diastolic BP, pulse, urine — was silently dropped
  // from any observation that came back through here. The record looked complete on the tablet that
  // recorded it and arrived on the server with holes in it, and nothing said so.
  //
  // The two lists are now ONE list, declared with the route that owns the table. A field added to the
  // Labour Care Guide is a field the replay accepts, by construction — it cannot drift again.
  if ($r==='sync' && $m==='POST'){ $u=require_role(['provider','admin']); $items=body()['items']??[]; $applied=[];
    $map=['lcg'=>'lcg_obs','checklist'=>'checklist_responses','danger_signs'=>'danger_signs'];
    $sallow=[
      'lcg_obs'              => $LCG_FIELDS,                       // the same list the POST /lcg route uses
      'checklist_responses'  => ['episode_id','pause_point','item_code','response','recorded_by'],
      'danger_signs'         => ['episode_id','obs_datetime','headache','blurred_vision','epigastric_pain','dtr_grade','vaginal_bleeding','remark','recorded_by'],
    ];

    // ONE BAD ROW MUST NOT TAKE THE REST OF THE QUEUE DOWN WITH IT.
    //
    // require_woman() / require_ep() call err(), which EXITS the request. So a single item the server
    // will not accept — most commonly a record whose patient was voided while the tablet was offline —
    // used to end the whole /sync request, after some earlier items had already been committed and with
    // $applied thrown away. The device never learned what landed, re-sent the batch, and duplicated it.
    // Worse: because PCC is replayed first, one such row meant the LABOUR observations and DANGER SIGNS
    // behind it in the same batch were never even reached. A dead woman's queued row could withhold a
    // living one's labour record.
    //
    // Now: each item is tried on its own. A failure is REPORTED against its uuid and the queue moves on,
    // so the client can surface it on the failed-entries screen with her values intact.
    $fail=function($it,$e) use (&$applied){
      $applied[]=['uuid'=>$it['client_uuid']??null,'error'=>$e];
    };

    foreach($items as $it){
      if(($it['entity']??'')!=='pcc') continue;
      try{
        $p=$it['payload']??[];
        if(!woman_facility_ok($p['woman_id']??0)) throw new RuntimeException('this patient record no longer exists here');
        $p=blank_to_null($p);
        foreach($PCC_FIELDS as $f){ if(array_key_exists($f,$p) && $p[$f]==='') $p[$f]=null; }  // '' is not a date, and not an enum
        check_ranges($p);
        $p['facility_id']=$u['facility_id']; $p['recorded_by']=$u['id'];
        if(empty($p['contact_date'])) $p['contact_date']=date('Y-m-d');
        if(is_array($p['readiness_reasons']??null)) $p['readiness_reasons']=implode(' | ',$p['readiness_reasons']);
        if(is_array($p['cannot_assess']??null))     $p['cannot_assess']=implode('; ',$p['cannot_assess']);
        if(!empty($it['client_uuid'])) $p['client_uuid']=$it['client_uuid'];
        $p=array_intersect_key($p,array_flip($PCC_FIELDS));   // the SAME list POST /pcc uses
        // A REPLAYED BATCH MUST NOT CREATE A SECOND ASSESSMENT. pcc_uptake is protected by its unique
        // key; pcc_assessments had nothing at all, so a batch re-sent after a failure duplicated every
        // PCC row in it — double-counting the facility's caseload and putting two contradictory
        // readiness verdicts on one woman's chart. The client's own uuid is the identity.
        if(!empty($p['client_uuid'])){
          $ex=db()->prepare("SELECT id FROM pcc_assessments WHERE client_uuid=?"); $ex->execute([$p['client_uuid']]);
          if($old=$ex->fetch()){ $applied[]=['uuid'=>$it['client_uuid'],'id'=>(int)$old['id']]; continue; }
        }
        $applied[]=['uuid'=>$it['client_uuid']??null,'id'=>insert('pcc_assessments',$p)];
      }catch(Throwable $e){ $fail($it, $e->getMessage()); }
    }
    // The ANC uptake checklist replays on the episode, and it is an UPSERT: the row is unique per
    // episode, so a tablet that queued it twice must correct the row rather than hit the unique key
    // and 500 (a 5xx retries for ever — the queue would wedge on it).
    foreach($items as $it){
      if(($it['entity']??'')!=='pcc_uptake' && ($it['entity']??'')!=='pcc-uptake') continue;
      try{
        $p=$it['payload']??[];
        if(!ep_facility_ok($p['episode_id']??0)) throw new RuntimeException('this episode no longer exists here');
        $p=blank_to_null($p);
        foreach($PCC_UPTAKE_FIELDS as $f){ if(array_key_exists($f,$p) && $p[$f]==='') $p[$f]=null; }
        $e=db()->prepare("SELECT woman_id FROM episodes WHERE id=?"); $e->execute([$p['episode_id']]); $er=$e->fetch();
        $p['woman_id']=$er['woman_id']; $p['facility_id']=$u['facility_id']; $p['recorded_by']=$u['id'];
        if(empty($p['asked_date'])) $p['asked_date']=date('Y-m-d');
        $ex=db()->prepare("SELECT * FROM pcc_uptake WHERE episode_id=?"); $ex->execute([$p['episode_id']]); $old=$ex->fetch();
        // Derive the status from the WHOLE row, stored plus incoming — never from the payload alone.
        // A replay carrying a subset of the items would otherwise recompute 'none' from a body with no
        // items in it, and write that over a woman who had told us she took folic acid.
        $p['status']=pcc_uptake_status(array_merge($old?:[], $p));
        $row=array_intersect_key($p,array_flip($PCC_UPTAKE_FIELDS));
        if($old){
          foreach(array_diff_key($row,array_flip(['episode_id','woman_id','facility_id','recorded_by'])) as $k=>$v){
            db()->prepare("UPDATE pcc_uptake SET `$k`=? WHERE id=?")->execute([$v,$old['id']]); }
          $applied[]=['uuid'=>$it['client_uuid']??null,'id'=>(int)$old['id']];
        } else {
          $applied[]=['uuid'=>$it['client_uuid']??null,'id'=>insert('pcc_uptake',$row)];
        }
      }catch(Throwable $e){ $fail($it, $e->getMessage()); }
    }

    foreach($items as $it){ $ep=$it['entity']??''; $payload=$it['payload']??[];
      // A queued PARTOGRAPH entry from a tablet that has not updated yet. The tool it was recorded
      // with no longer exists. Refuse it clearly (4xx) so it lands on the failed-entries screen with
      // her values intact and visible, instead of vanishing or retrying for ever.
      if($ep==='observations') err('This was recorded on the old partograph, which has been replaced by the Labour Care Guide. Re-enter it under Intrapartum care — the values are shown on the failed-entries screen.', 410);
      // The replay path was the last unvalidated door into the record: a queued write from a tablet
      // running an older build — precisely the case the bounds exist for — went straight to insert().
      // It is validated exactly like the online write now.
      if(isset($map[$ep])){ require_ep($payload['episode_id']??0);
        $payload = blank_to_null($payload);
        check_ranges($payload);
        $payload['recorded_by']=$u['id'];
        if(is_array($payload['alerts']??null)) $payload['alerts']=implode(',',$payload['alerts']);
        $payload=array_intersect_key($payload,array_flip($sallow[$map[$ep]]));
        $applied[]=['uuid'=>$it['client_uuid']??null,'id'=>insert($map[$ep],$payload)]; } }
    audit('sync',null,null,['count'=>count($applied)]); out(['applied'=>$applied]);
  }

  // ---- Supervisor dashboard (cross-facility rollup, read-only) ----
  if ($r==='supervisor' && $m==='GET'){ $u=require_role(['supervisor','admin']); $ids=scoped_facility_ids($u);
    if(!$ids){ out(['scope'=>$u['scope']??'facility','facilities'=>[]]); }
    $in=implode(',',array_fill(0,count($ids),'?'));
    $facs=db()->prepare("SELECT id,name,woreda,zone,region FROM facilities WHERE id IN ($in) ORDER BY name"); $facs->execute($ids); $facRows=$facs->fetchAll();
    $days=(int)($_GET['days']??0); if($days<0)$days=0; if($days>3660)$days=3660;   // 0 = all time; sanitized int, safe to inline
    $dc=function($col) use($days){ return $days>0 ? " AND $col >= DATE_SUB(CURDATE(), INTERVAL $days DAY)" : ""; };
    $grp=function($sql) use($ids){ $st=db()->prepare($sql); $st->execute($ids); $o=[]; foreach($st->fetchAll() as $x){ $o[(int)$x['fid']]=(int)$x['c']; } return $o; };
    // voided=0 — this was the ONLY rollup on this screen without it, and it is the DENOMINATOR of
    // partograph_completion. The numerator (partographs_started) excludes voided episodes, so every
    // removed labour episode quietly dragged the facility's headline quality indicator down.
    $labour   = $grp("SELECT facility_id fid, COUNT(*) c FROM episodes WHERE voided=0 AND service_category='labour' AND facility_id IN ($in)".$dc('created_at')." GROUP BY facility_id");
    // LABOUR MONITORED — under whichever guideline. The Labour Care Guide replaced the partograph, but
    // a woman monitored on the partograph before that WAS monitored: counting only the new table would
    // drop every facility's quality indicator to zero on the day we deploy, which would be a lie about
    // the care they gave. Both count. Union, not either/or.
    // (One IN($in) only — the placeholder list is bound once, so the OR-EXISTS shape is used rather
    //  than a UNION, which would need the facility ids bound twice.)
    $partostd = $grp("SELECT e.facility_id fid, COUNT(DISTINCT e.id) c FROM episodes e
                       WHERE e.voided=0 AND e.facility_id IN ($in)
                         AND ( EXISTS(SELECT 1 FROM lcg_obs o        WHERE o.episode_id=e.id".$dc('o.recorded_at').")
                            OR EXISTS(SELECT 1 FROM partograph_obs o WHERE o.episode_id=e.id".$dc('o.recorded_at').") )
                       GROUP BY e.facility_id");
    $deliv    = $grp("SELECT e.facility_id fid, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.voided=0 AND e.id=d.episode_id WHERE e.facility_id IN ($in)".$dc('d.recorded_at')." GROUP BY e.facility_id");
    $reds     = $grp("SELECT e.facility_id fid, COUNT(*) c FROM risk_scores s JOIN episodes e ON e.voided=0 AND e.id=s.episode_id WHERE s.band='red' AND e.facility_id IN ($in)".$dc('s.scored_at')." GROUP BY e.facility_id");
    $refs     = $grp("SELECT e.facility_id fid, COUNT(*) c FROM referrals rf JOIN episodes e ON e.voided=0 AND e.id=rf.episode_id WHERE e.facility_id IN ($in)".$dc('rf.recorded_at')." GROUP BY e.facility_id");
    // PRECONCEPTION CARE across the woreda. `pcc_women` is the MoH's "facility started providing PCC"
    // indicator in its only honest form — a facility with zero is a facility not doing it. `anc_asked`
    // is the denominator for uptake: the share of women arriving at ANC who were even ASKED matters
    // more, early on, than the uptake figure itself, because an unasked woman is recorded as nothing.
    $pccW     = $grp("SELECT p.facility_id fid, COUNT(DISTINCT p.woman_id) c FROM pcc_assessments p JOIN women w ON w.id=p.woman_id AND w.voided=0
                       WHERE p.voided=0 AND p.facility_id IN ($in)".$dc('p.contact_date')." GROUP BY p.facility_id");
    $ancEp    = $grp("SELECT e.facility_id fid, COUNT(*) c FROM episodes e WHERE e.voided=0 AND e.service_category='anc' AND e.facility_id IN ($in)".$dc('e.created_at')." GROUP BY e.facility_id");
    // The episode join is NOT optional. The denominator ($ancEp) already excludes voided episodes; if
    // the numerator does not, voiding an ANC episode removes it from the bottom of the fraction and
    // leaves it at the top — and pcc_asked_pct reports more than 100%.
    $asked    = $grp("SELECT x.facility_id fid, COUNT(*) c FROM pcc_uptake x
                        JOIN women w    ON w.id=x.woman_id  AND w.voided=0
                        JOIN episodes e2 ON e2.id=x.episode_id AND e2.voided=0
                       WHERE x.voided=0 AND x.facility_id IN ($in)".$dc('x.asked_date')." GROUP BY x.facility_id");
    $optimal  = $grp("SELECT x.facility_id fid, COUNT(*) c FROM pcc_uptake x
                        JOIN women w    ON w.id=x.woman_id  AND w.voided=0
                        JOIN episodes e2 ON e2.id=x.episode_id AND e2.voided=0
                       WHERE x.voided=0 AND x.status='optimal' AND x.facility_id IN ($in)".$dc('x.asked_date')." GROUP BY x.facility_id");
    $rows=[]; foreach($facRows as $f){ $fid=(int)$f['id']; $lab=$labour[$fid]??0; $ps=$partostd[$fid]??0;
      $anc=$ancEp[$fid]??0; $ak=$asked[$fid]??0;
      $rows[]=['id'=>$fid,'name'=>$f['name'],'woreda'=>$f['woreda'],'zone'=>$f['zone'],
        'labour_episodes'=>$lab,'partographs_started'=>$ps,'partograph_completion'=>$lab?(int)round(100*$ps/$lab):0,
        'deliveries'=>$deliv[$fid]??0,'red_alerts'=>$reds[$fid]??0,'referrals'=>$refs[$fid]??0,
        'pcc_women'=>$pccW[$fid]??0,
        'anc_episodes'=>$anc,'pcc_asked'=>$ak,
        'pcc_asked_pct'=>$anc?(int)round(100*$ak/$anc):0,
        'pcc_optimal'=>$optimal[$fid]??0,
        'pcc_optimal_pct'=>$ak?(int)round(100*($optimal[$fid]??0)/$ak):0]; }
    out(['scope'=>$u['scope']??'facility','base_facility'=>(int)$u['facility_id'],'days'=>$days,'facilities'=>$rows]);
  }

  // ---- Reminders: list (supervisor/admin) + run scheduler (admin) ----
  if ($r==='reminders'){
    if($m==='GET'){ $u=require_role(['supervisor','admin']); $ids=scoped_facility_ids($u); if(!$ids)$ids=[0];
      $in=implode(',',array_fill(0,count($ids),'?'));
      $st=db()->prepare("SELECT r.*, w.first_name, w.father_name FROM reminders r LEFT JOIN women w ON w.id=r.woman_id WHERE r.facility_id IN ($in) ORDER BY r.id DESC LIMIT 300");
      $st->execute($ids); out($st->fetchAll()); }
    if($m==='POST' && $id==='run'){ require_role(['admin']); require __DIR__.'/reminders_lib.php'; out(reminders_run(db()), 200); }
    // A RECALL A PROVIDER CAN SET.
    //
    // Until now a reminder could only be created by the scheduler. The folic-acid clock needs one it
    // cannot generate: "you may try to conceive from this date", three months after she starts the
    // supplement. That date is the single most actionable thing she leaves a preconception visit with.
    //
    // CONSENT IS NOT OPTIONAL AND IS NOT INFERRED. The phone number is attached ONLY if she has
    // consented to be texted. Without consent the reminder is still created — it appears on the
    // facility's recall list, and someone tells her when she comes — but no message can be sent to
    // her, because the row has no number to send it to.
    if($m==='POST' && !$id){ $u=require_role(['provider','admin']); $b=body();
      $wid=(int)($b['woman_id']??0); require_woman($wid);
      $due=$b['due_date']??''; if(!preg_match('/^\d{4}-\d{2}-\d{2}$/',$due)) err('a due date is required');
      // THE KIND IS WHITELISTED, AND 'anc'/'pnc' ARE NOT ON THE LIST.
      // The scheduler dedupes its own ANC reminders on (woman_id, due_date, kind='anc'). A hand-made
      // row with kind='anc' would therefore OCCUPY THAT SLOT and the scheduler would never generate the
      // real antenatal-appointment reminder for that woman on that date — she simply would not be told
      // about her appointment. The scheduler owns those kinds; a provider may only add her own.
      $kind=strtolower(trim((string)($b['kind']??'custom')));
      if(!in_array($kind,['custom','pcc_folate','pcc_followup'],true)) err('that is not a reminder a provider can create');
      $msg=trim((string)($b['message']??''));
      if($msg==='') err('a reminder needs a message — an empty SMS is worse than none');
      $w=db()->prepare("SELECT phone, sms_consent FROM women WHERE id=?"); $w->execute([$wid]); $wr=$w->fetch();
      $phone=((int)($wr['sms_consent']??0)===1) ? ($wr['phone']??null) : null;
      $rid=insert('reminders',['woman_id'=>$wid,'facility_id'=>(int)$u['facility_id'],'kind'=>$kind,
        'due_date'=>$due,'phone'=>$phone,'message'=>mb_substr($msg,0,300),'status'=>'pending']);
      audit('create','reminders',$rid,['kind'=>$kind,'due'=>$due,'sms'=>$phone?1:0]);
      out(['id'=>$rid,'sms'=>$phone?1:0],201); }
  }

  err('not found: '.$r, 404);
} catch (Throwable $ex) {
  error_log('ADHERE API: '.$ex->getMessage());

  // A BAD VALUE IS NOT A SERVER FAILURE. Every database constraint violation used to come back as
  // HTTP 500 — "server error" — and 500 means, to the offline queue, "the server is unwell, back off
  // and try again later". So ONE entry the server would never accept (a duplicate delivery, a value
  // outside an enum) sat at the head of the queue and BLOCKED EVERY VALID RECORD BEHIND IT, retrying
  // for as long as the device stayed online. In a facility that has been offline all day, that is a
  // whole shift's work stuck behind one bad row, with the provider told only "sync N pending".
  //
  // These are faults in the REQUEST. Say so, with the status that means it: the queue then surfaces
  // the entry on the failed-entries screen — visible, with her record intact — and moves on.
  $code = 0;
  if ($ex instanceof \PDOException) { $code = (int)($ex->errorInfo[1] ?? 0); }
  switch ($code) {
    case 1062:  // duplicate entry on a unique key
      err('This has already been recorded (duplicate entry).', 409);
    case 1451:  // referenced row is still in use
    case 1452:  // the row it points at does not exist
      err('That record refers to something that does not exist here.', 409);
    case 1264:  // out of range
    case 1265:  // data truncated for column  (a value outside an ENUM lands here)
    case 1292:  // incorrect date/datetime value
    case 1366:  // incorrect value for column
      err('One of the values is not valid for this field.', 400);
    // THE TWO A PROVIDER ACTUALLY HITS BY TYPING. Both were missing from this list and fell through to
    // the 500 below — which is the one status the offline queue retries FOR EVER.
    case 1406:  // Data too long for column
      // Reachable from ordinary use: danger_note / remark / note are VARCHAR(255), the "other" free-text
      // fields are shorter still. A long note is a fault in the request, not in the server.
      err('That text is too long for this field. Please shorten it.', 400);
    case 1048:  // Column cannot be null
      err('A required field is missing.', 400);
    default:
      err('server error', 500);
  }
}
