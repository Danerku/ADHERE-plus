<?php
require __DIR__.'/lib.php'; require __DIR__.'/db.php';
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
  if ($r==='users'){ require_role(['admin']);
    if($m==='GET'){ $st=db()->query("SELECT id,username,full_name,role,cadre,facility_id,scope,is_active,last_login FROM users ORDER BY id"); out($st->fetchAll()); }
    if($m==='POST'){ $me=user(); $b=body(); $rows=isset($b[0])?$b:[$b]; $created=[]; $errors=[];  // single object OR array (CSV bulk)
      foreach($rows as $i=>$row){
        $un=trim($row['username']??''); $pw=(string)($row['password']??''); $role=$row['role']??'';
        if($un===''||$pw===''||$role===''){ $errors[]=['row'=>$i,'error'=>'username, password and role are required']; continue; }
        if(strlen($pw)<8){ $errors[]=['row'=>$i,'user'=>$un,'error'=>'password must be at least 8 characters']; continue; }
        if(!in_array($role,['recorder','provider','observer','supervisor','admin'])){ $errors[]=['row'=>$i,'user'=>$un,'error'=>'invalid role']; continue; }
        $ex=db()->prepare("SELECT id FROM users WHERE username=?"); $ex->execute([$un]); if($ex->fetch()){ $errors[]=['row'=>$i,'user'=>$un,'error'=>'username already taken']; continue; }
        $scope=in_array(($row['scope']??'facility'),['facility','woreda','zone','region'])?($row['scope']??'facility'):'facility';
        $nid=insert('users',['username'=>$un,'password_hash'=>password_hash($pw,PASSWORD_DEFAULT),'full_name'=>$row['full_name']??$un,'role'=>$role,'cadre'=>$row['cadre']??null,'facility_id'=>$row['facility_id']??$me['facility_id'],'scope'=>$scope]);
        $created[]=['id'=>$nid,'username'=>$un];
      }
      audit('create_user','users',$created[0]['id']??null,['count'=>count($created)]);
      if(!isset($b[0])){ if($errors) err($errors[0]['error'], $errors[0]['error']==='username already taken'?409:400); out(['id'=>$created[0]['id']],201); }
      out(['created'=>$created,'errors'=>$errors],201); }
    if($m==='PATCH' && $id){ $b=body(); $me=user();
      if(isset($b['is_active'])){ if((int)$id===(int)$me['id'] && !$b['is_active']) err('you cannot deactivate your own account'); db()->prepare("UPDATE users SET is_active=? WHERE id=?")->execute([$b['is_active']?1:0,$id]); }
      if(isset($b['role']) && in_array($b['role'],['recorder','provider','observer','supervisor','admin'])){ db()->prepare("UPDATE users SET role=? WHERE id=?")->execute([$b['role'],$id]); }
      if(isset($b['scope']) && in_array($b['scope'],['facility','woreda','zone','region'])){ db()->prepare("UPDATE users SET scope=? WHERE id=?")->execute([$b['scope'],$id]); }
      if(!empty($b['password'])){ if(strlen($b['password'])<8) err('password must be at least 8 characters'); db()->prepare("UPDATE users SET password_hash=? WHERE id=?")->execute([password_hash($b['password'],PASSWORD_DEFAULT),$id]); }
      audit('update_user','users',$id); out(['ok'=>true]); }
  }
  if ($r==='facilities'){ require_role(['admin']);
    if($m==='GET'){ out(db()->query("SELECT id,name,facility_type,kebele,woreda,zone,region,dhis2_org_unit FROM facilities ORDER BY id")->fetchAll()); }
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
    if($m==='GET' && $id){ $u=user(); $st=db()->prepare("SELECT * FROM women WHERE id=? AND facility_id=?"); $st->execute([$id,$u['facility_id']]); out($st->fetch()?:[]); }
    if($m==='GET'){ $u=user(); $q='%'.($_GET['q']??'').'%'; $st=db()->prepare("SELECT * FROM women WHERE facility_id=? AND (mrn LIKE ? OR first_name LIKE ?) ORDER BY id DESC LIMIT 100"); $st->execute([$u['facility_id'],$q,$q]); out($st->fetchAll()); }
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
      if(isset($b['age'])&& $b['age']!==null && $b['age']!==''){ $ag=(int)$b['age'];
        if($ag<10 || $ag>60) err('Age must be between 10 and 60'); }
      $dup=db()->prepare("SELECT id FROM women WHERE mrn=? AND facility_id=?"); $dup->execute([$b['mrn'],$u['facility_id']]); if($dup->fetch()) err('This MRN already exists at your facility',409);
      $wid=insert('women',array_intersect_key($b,array_flip(array_merge(['mrn','first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','height_cm','prior_cs','prior_stillbirth','prior_pph','prior_preeclampsia','prior_obstructed','chronic_htn','diabetes','cardiac_renal','children_alive','sms_consent','lnmp','edd','kin_address','prev_pregnancy_outcome','ga_first_contact','first_contact_date','late_anc_initiation',
        'blood_group','rh_factor','pregnancy_planned','abortions','ectopic','gtd','residence','occupation','facility_id','created_by'],MOH_PERSON_FIELDS))));
      audit('create','women',$wid); out(['id'=>$wid],201); }
    if($m==='PATCH' && $id){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $wc->execute([$id,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      $fields=array_intersect_key($b,array_flip(array_merge(['first_name','father_name','grandfather_name','age','phone','kebele','house_no','marital_status','next_of_kin','kin_phone','gravida','para','height_cm','children_alive','sms_consent','lnmp','edd','kin_address','prev_pregnancy_outcome','ga_first_contact','first_contact_date','late_anc_initiation',
        'blood_group','rh_factor','pregnancy_planned','abortions','ectopic','gtd','residence','occupation'],MOH_PERSON_FIELDS)));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE women SET `$k`=? WHERE id=?")->execute([$v,$id]); } audit('update','women',$id,array_keys($fields)); out(['ok'=>true]); }
  }

  // ---- providers list (for handover picker; any logged-in user) ----
  if ($r==='providers' && $m==='GET'){ $u=user(); $st=db()->prepare("SELECT id,full_name,role FROM users WHERE is_active=1 AND role IN ('provider','admin') AND facility_id=? ORDER BY full_name"); $st->execute([$u['facility_id']]); out($st->fetchAll()); }

  // ---- episodes ----
  if ($r==='episodes'){
    if($m==='GET'){ $u=user(); $cat=$_GET['category']??null; $flag=$_GET['flag']??null;
      // Derived risk flag (no user input).
      // Age: National ANC Guideline 2022, Table 4 — high risk is age <19 OR >35.
      // (Not <18/>=35. The guideline is explicit; an 18-year-old and a 36-year-old both qualify.)
      // Unplanned/unwanted pregnancy is also a Table 4 high-risk condition.
      // Late ANC initiation is deliberately NOT included: it is so common here that flagging it
      // would mark most women and cause alarm fatigue. It stays visible on the chart instead.
      $hr="(w.prior_cs='yes' OR w.prior_stillbirth='yes' OR w.prior_pph='yes' OR w.prior_preeclampsia='yes' OR w.prior_obstructed='yes' OR w.chronic_htn='yes' OR w.diabetes='yes' OR w.cardiac_renal='yes' OR (w.age IS NOT NULL AND (w.age<19 OR w.age>35)) OR w.pregnancy_planned=0 OR EXISTS(SELECT 1 FROM anc_risk_screening a WHERE a.episode_id=e.id AND a.response='yes'))";
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
      $sc="(SELECT GROUP_CONCAT(a.item_code) FROM anc_risk_screening a WHERE a.episode_id=e.id AND a.response='yes')";
      $an="(SELECT av.anaemia_grade FROM anc_visits av WHERE av.episode_id=e.id AND av.anaemia_grade IS NOT NULL AND av.anaemia_grade<>'normal' ORDER BY av.id DESC LIMIT 1)";
      $mf="(SELECT av.muac_flag FROM anc_visits av WHERE av.episode_id=e.id AND av.muac_flag=1 ORDER BY av.id DESC LIMIT 1)";
      // Person-level items are carried forward here so Delivery and PNC can SHOW what ANC
      // already established (blood group, Rh, HIV, target population) instead of re-asking.
      $sql="SELECT e.*, w.first_name,w.father_name,w.mrn,w.gravida,w.para,w.age,w.height_cm,w.lnmp,w.edd, w.ga_first_contact,w.late_anc_initiation,
              w.blood_group,w.rh_factor,w.pregnancy_planned,w.target_pop_code,w.hiv_known_positive,w.hiv_linked_art,w.art_regimen,
              pu.full_name AS provider_name, $hr AS high_risk,
              $rc AS risk_codes, $sc AS screen_codes, $an AS anaemia, $mf AS muac_low
            FROM episodes e JOIN women w ON w.id=e.woman_id LEFT JOIN users pu ON pu.id=e.provider_id WHERE e.facility_id=?";
      $args=[$u['facility_id']]; if($cat){ $sql.=" AND e.service_category=?"; $args[]=$cat; }
      if($flag==='highrisk'){ $sql.=" AND $hr AND e.status IN ('laboring','active')"; } $sql.=" ORDER BY e.id DESC LIMIT 200";
      $st=db()->prepare($sql); $st->execute($args); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $wc->execute([$b['woman_id']??0,$u['facility_id']]); if(!$wc->fetch()) err('woman not in your facility',404);
      $b['created_by']=$u['id']; $b['facility_id']=$u['facility_id'];
      $eid=insert('episodes',array_intersect_key($b,array_flip(['woman_id','service_category','status','provider_id','admitted_from','ruptured_membrane','admission_datetime','facility_id','created_by','place_of_delivery','infant_dob'])));
      audit('create','episodes',$eid); out(['id'=>$eid],201); }
    if($m==='PATCH' && $id){ require_role(['recorder','provider','admin']); require_ep($id); $b=body(); $fields=array_intersect_key($b,array_flip(['status','provider_id','ruptured_membrane','place_of_delivery','infant_dob']));
      foreach($fields as $k=>$v){ db()->prepare("UPDATE episodes SET `$k`=? WHERE id=?")->execute([$v,$id]); } audit('update','episodes',$id,$fields); out(['ok'=>true]); }
  }

  // ---- partograph observations ----
  if ($r==='observations'){
    if($m==='GET'){ require_ep($_GET['episode']??0); $st=db()->prepare("SELECT * FROM partograph_obs WHERE episode_id=? ORDER BY obs_datetime"); $st->execute([$_GET['episode']]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['provider','admin']); $b=body(); require_ep($b['episode_id']??0); $b['recorded_by']=$u['id'];
      $oid=insert('partograph_obs',array_intersect_key($b,array_flip(['episode_id','obs_datetime','hours_since_active','fetal_heart_rate','amniotic_fluid','moulding','caput','cervix_cm','descent_head','contractions_per10','contraction_strength','oxytocin_units','oxytocin_drops','drugs_iv_fluids','bp_systolic','bp_diastolic','pulse','temperature','urine_protein','urine_acetone','urine_volume','recorded_by'])));
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
           'delivery'=>['delivery_summary',['episode_id','delivery_datetime','mode','baby_weight_g','baby_sex','apgar_1min','apgar_5min','outcome','maternal_outcome','complications','amtsl_uterotonic','amtsl_uterotonic_type','amtsl_cct','amtsl_uterine_tone','amtsl_massage','amtsl_placenta','blood_loss_ml','recorded_by',
             // MoH Delivery register (v12): 7,11,12,15-24,36-38,42,49-51,66
             'partograph_used','episiotomy','mode_other_text','maternal_status','maternal_death_cause','comp_preeclampsia','comp_eclampsia','comp_aph','comp_pph','comp_other','referred','hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_feeding_options','ippfp_acceptor','ippfp_method','remark',
             'ippfp_timing']],   // v15 — IUCD is the commonest method at delivery; post-placental vs 48h matters
           'anc_screening'=>['anc_risk_screening',['episode_id','item_code','item_group','response','recorded_by']],
           'handover'=>['handovers',['episode_id','from_provider_id','to_provider_id','note']],
           'referrals'=>['referrals',['episode_id','referred_to','reason','urgency','transport','feedback','recorded_by']],
           'anc_visits'=>['anc_visits',['episode_id','visit_date','contact_no','ga_weeks','weight_kg','bp_systolic','bp_diastolic','fundal_height_cm','fetal_heart_rate','presentation','urine_protein','hgb','muac','fetal_movement','hiv_status','syphilis','tetanus_td','iron_folic','malaria_assessed','danger_note','next_appointment','recorded_by',
             // MoH ANC register (v12): 10-18, 20,21,23, counselling 30-34, remark 35
             'ultrasound_lt24w','syphilis_result','syphilis_treated','hepb_result','hepb_treated','hepb_prophylaxis','td_dose_no','ifa_tabs','deworming','hiv_test_accepted','hiv_test_result','hiv_posttest_counselled','cnsl_danger_signs','cnsl_nutrition','cnsl_ecd','cnsl_infant_feeding','cnsl_family_planning','remark',
             // National ANC Guideline 2022, Annex 6 (ANC card) — migration v14
             'calcium_given','ifa_tabs_consumed','anti_d_given','pallor','urine_gramstain','ogtt_result','mental_health','ipv_screen','substance_use','cnsl_lifestyle','cnsl_bpcr','bmi','anaemia_grade','muac_flag',
             // v15 — already-on-ART pathway (no re-testing); unsuppressed VL -> ART clinic
             'art_continued','viral_load','viral_load_date','art_clinic_linked']],
           'labs'=>['lab_orders',['episode_id','anc_visit_id','test_code','requested','requested_date','result','result_date','note','recorded_by']],
           'pnc_visits'=>['pnc_visits',['episode_id','visit_date','pnc_day','m_temp','m_bp_systolic','m_bp_diastolic','m_pulse','bleeding','breast','mood','uterine_tone','perineum','mother_breastfeeding','pp_fp','ifa_continued','nb_temp','nb_feeding','cord','nb_convulsions','nb_fast_breathing','nb_chest_indrawing','nb_lethargy','nb_jaundice','nb_kmc','nb_immunization','nb_eid','danger_note','recorded_by',
             // MoH PNC register (v12): 10,12-17, counselling 25-30, newborn 31-37, IPPFP 38-40, remark 42
             'visit_period','maternal_condition','pph','other_obs_complication','hiv_test_accepted','hiv_retest_accepted','hiv_test_result','cnsl_danger_signs','cnsl_breastfeeding','cnsl_newborn_care','cnsl_family_planning','cnsl_epi','cnsl_ecd','nb_weight_g','nb_problems','nb_problem_other','nb_treatment','nb_treatment_outcome','nb_death_age_days','nb_death_cause','ippfp_acceptor','ippfp_method','remark',
             'baby_id']],   // v15 — PNC is for mother AND newborn: tie each assessment to a specific baby (twins)
           'babies'=>['babies',['episode_id','birth_order','sex','weight_g','apgar_1min','apgar_5min','resuscitated','outcome','note','enc_dried','enc_breathing','enc_vitamin_k','enc_eye_ointment','enc_cord_care','enc_arv','recorded_by',
             // MoH Delivery register, newborn level (v12): 31,35,52-64
             'mrn','vacc_bcg','vacc_opv0','vacc_hbv','prob_prematurity','prob_sepsis_vsd','prob_resp_distress','prob_lbw','prob_congenital','prob_other','prob_other_text','breastfeed_initiated','resuscitated_survived','death_age_days','death_age_hours','death_cause','birth_notification',
             // v15 — HIV exposure pathway (exposed -> ARV -> DBS -> ART clinic), Vit K timing,
             // conditional care pathways (KMC, phototherapy, NICU, antibiotics, oxygen), free-text "other"
             'hiv_exposed','arv_prophylaxis','dbs_sample','dbs_date','dbs_result','art_linked','art_linked_date',
             'vitamin_k_time','cord_care_other','apgar_flag','kmc','phototherapy','nicu','nicu_facility','antibiotics','oxygen']],
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
    if($m==='POST'){ $clin=['checklist_responses','danger_signs','delivery_summary','anc_risk_screening','referrals','anc_visits','pnc_visits','babies','maternal_vitals','bemonc_care','handovers','lab_orders']; $u = in_array($tbl,$clin)?require_role(['provider','admin']):require_auth(); $b=body();
      $rows = isset($b[0])?$b:[$b];  // accept single object or array (checklist batch)
      foreach($rows as $row){ require_ep($row['episode_id']??0); }
      $ids=[]; foreach($rows as $row){ if(in_array('recorded_by',$allow)) $row['recorded_by']=$u['id'];
        if($tbl==='handovers') $row['from_provider_id']=$u['id'];   // sender identity from the session, never caller-supplied
        if($tbl==='messages')  $row['from_user_id']=$u['id'];
        $ids[]=insert($tbl,array_intersect_key($row,array_flip($allow))); }
      audit('create',$tbl,$ids[0]??null); out(['ids'=>$ids],201); }
  }


  // ---- Module 4: operational intelligence (monthly time-series + anomaly flags) ----
  if ($r==='analytics' && $m==='GET'){ $u=require_auth(); $ids=scoped_facility_ids($u); $in=implode(',',array_fill(0,count($ids),'?'));  // scoped to the user's facility (supervisor: their woreda/zone/region)
    $months=[]; for($i=5;$i>=0;$i--){ $months[]=date('Y-m', strtotime("-$i month")); }
    $series=function($sql) use($months,$ids){ $out=[]; foreach($months as $mo){ $st=db()->prepare($sql); $st->execute(array_merge($ids,[$mo])); $out[]=(int)($st->fetch()['c']??0);} return $out; };
    $ind=[
      'labour'=>$series("SELECT COUNT(*) c FROM episodes e WHERE e.facility_id IN ($in) AND e.service_category='labour' AND DATE_FORMAT(e.admission_datetime,'%Y-%m')=?"),
      'deliveries'=>$series("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?"),
      'partographs'=>$series("SELECT COUNT(DISTINCT o.episode_id) c FROM partograph_obs o JOIN episodes e ON e.id=o.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(o.recorded_at,'%Y-%m')=?"),
      'checklists'=>$series("SELECT COUNT(DISTINCT c.episode_id) c FROM checklist_responses c JOIN episodes e ON e.id=c.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(c.recorded_at,'%Y-%m')=?"),
      'amtsl'=>$series("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id IN ($in) AND d.amtsl_uterotonic='done' AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?"),
      'referrals'=>$series("SELECT COUNT(*) c FROM referrals r JOIN episodes e ON e.id=r.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(r.recorded_at,'%Y-%m')=?"),
      'red_alerts'=>$series("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.id=s.episode_id WHERE e.facility_id IN ($in) AND s.band='red' AND DATE_FORMAT(s.scored_at,'%Y-%m')=?"),
      'births'=>$series("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?"),
      'stillbirths'=>$series("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id IN ($in) AND b.outcome='fresh_stillbirth' AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?"),  // newborn record = source of truth
      'pnc'=>$series("SELECT COUNT(DISTINCT p.episode_id) c FROM pnc_visits p JOIN episodes e ON e.id=p.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(p.recorded_at,'%Y-%m')=?"),
    ];
    out(['months'=>$months,'indicators'=>$ind]);
  }

  // ---- Facility overview: themed counts for the dashboard --------------------
  // Grouped by theme so the dashboard can answer: how many were high risk, what
  // happened to them, how they delivered, and whether the process of care was followed.
  if ($r==='overview' && $m==='GET'){ $u=require_auth(); $fid=(int)$u['facility_id'];
    $days=(int)($_GET['days']??0); if($days<0)$days=0; if($days>3660)$days=3660;
    $since = $days>0 ? " AND e.created_at >= DATE_SUB(CURDATE(), INTERVAL $days DAY)" : "";
    $one=function($sql) use($fid){ $st=db()->prepare($sql); $st->execute([$fid]); $r=$st->fetch(); return (int)($r['c']??0); };
    $grp=function($sql) use($fid){ $st=db()->prepare($sql); $st->execute([$fid]); $o=[]; foreach($st->fetchAll() as $x){ $o[(string)$x['k']]=(int)$x['c']; } return $o; };
    $hrx="(w.prior_cs='yes' OR w.prior_stillbirth='yes' OR w.prior_pph='yes' OR w.prior_preeclampsia='yes' OR w.prior_obstructed='yes' OR w.chronic_htn='yes' OR w.diabetes='yes' OR w.cardiac_renal='yes' OR (w.age IS NOT NULL AND (w.age<19 OR w.age>35)) OR w.pregnancy_planned=0 OR EXISTS(SELECT 1 FROM anc_risk_screening a WHERE a.episode_id=e.id AND a.response='yes'))";
    out([
     'days'=>$days,
     'caseload'=>[
       'anc'      =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.facility_id=? AND e.service_category='anc'$since"),
       'labour'   =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.facility_id=? AND e.service_category='labour'$since"),
       'pnc'      =>$one("SELECT COUNT(DISTINCT p.episode_id) c FROM pnc_visits p JOIN episodes e ON e.id=p.episode_id WHERE e.facility_id=?$since"),
       'deliveries'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=?$since"),
       'high_risk'=>$one("SELECT COUNT(*) c FROM episodes e JOIN women w ON w.id=e.woman_id WHERE e.facility_id=? AND $hrx$since"),
       'total'    =>$one("SELECT COUNT(*) c FROM episodes e WHERE e.facility_id=?$since"),
     ],
     'mode_of_delivery'=>$grp("SELECT d.mode k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.mode IS NOT NULL$since GROUP BY d.mode"),
     'birth_outcome'  =>$grp("SELECT b.outcome k, COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.outcome IS NOT NULL$since GROUP BY b.outcome"),
     'maternal_outcome'=>$grp("SELECT d.maternal_status k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.maternal_status IS NOT NULL$since GROUP BY d.maternal_status"),
     'complications'=>[
       'pre_eclampsia'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.comp_preeclampsia=1$since"),
       'eclampsia'    =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.comp_eclampsia=1$since"),
       'aph'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.comp_aph=1$since"),
       'pph'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.comp_pph=1$since"),
       'other'        =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.comp_other=1$since"),
     ],
     'process'=>[
       'partograph_used'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.partograph_used='Y'$since"),
       'amtsl'          =>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.amtsl_uterotonic='done'$since"),
       'checklist'      =>$one("SELECT COUNT(DISTINCT c.episode_id) c FROM checklist_responses c JOIN episodes e ON e.id=c.episode_id WHERE e.facility_id=?$since"),
       'referred'       =>$one("SELECT COUNT(*) c FROM referrals rf JOIN episodes e ON e.id=rf.episode_id WHERE e.facility_id=?$since"),
       'red_alerts'     =>$one("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.id=s.episode_id WHERE e.facility_id=? AND s.band='red'$since"),
     ],
     'ippfp'=>$grp("SELECT d.ippfp_method k, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id=? AND d.ippfp_method IS NOT NULL$since GROUP BY d.ippfp_method"),
     'newborn_care'=>[
       'lbw'         =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.prob_lbw=1$since"),
       'kmc'         =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.kmc='initiated'$since"),
       'phototherapy'=>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.phototherapy='given'$since"),
       'nicu'        =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.nicu IN ('admitted','referred_out')$since"),
       'hiv_exposed' =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.hiv_exposed=1$since"),
       'dbs_sent'    =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.dbs_sample='sent'$since"),
       'low_apgar'   =>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id=? AND b.apgar_flag='low'$since"),
     ],
    ]);
  }

  // ---- Pregnancy test (OPD) and the link into the ANC room -------------------
  // "If a mother's pregnancy test is positive in OPD, how can we link her to the ANC
  //  room?" — a positive test can open an ANC episode for her directly, so the
  //  handoff is recorded rather than relying on her walking down the corridor.
  if ($r==='pregnancy_tests'){
    if($m==='GET'){ $u=require_auth();
      $st=db()->prepare("SELECT p.*, w.mrn, w.first_name, w.father_name, w.age
                           FROM pregnancy_tests p LEFT JOIN women w ON w.id=p.woman_id
                          WHERE p.facility_id=? ORDER BY p.id DESC LIMIT 200");
      $st->execute([$u['facility_id']]); out($st->fetchAll()); }
    if($m==='POST'){ $u=require_role(['recorder','provider','admin']); $b=body();
      $wid=(int)($b['woman_id']??0);
      $wc=db()->prepare("SELECT id FROM women WHERE id=? AND facility_id=?"); $wc->execute([$wid,$u['facility_id']]);
      if(!$wc->fetch()) err('woman not in your facility',404);
      $pid=insert('pregnancy_tests',['facility_id'=>$u['facility_id'],'woman_id'=>$wid,
        'test_date'=>($b['test_date']??date('Y-m-d')),'result'=>($b['result']??null),
        'note'=>($b['note']??null),'recorded_by'=>$u['id']]);
      $eid=null;
      // A positive test with link_to_anc opens the ANC episode in one step.
      if(($b['result']??'')==='positive' && !empty($b['link_to_anc'])){
        $eid=insert('episodes',['woman_id'=>$wid,'service_category'=>'anc','status'=>'active',
          'admitted_from'=>'new','admission_datetime'=>date('Y-m-d H:i:s'),
          'facility_id'=>$u['facility_id'],'created_by'=>$u['id']]);
        db()->prepare("UPDATE pregnancy_tests SET linked_episode_id=?, linked_at=NOW() WHERE id=?")->execute([$eid,$pid]);
      }
      audit('create','pregnancy_tests',$pid); out(['id'=>$pid,'episode_id'=>$eid],201); }
  }

  // ---- MoH paper-register export -------------------------------------------
  // Reproduces the official Ethiopian MoH ANC / Delivery / PNC registers from the
  // captured record, so a facility no longer hand-writes them. Person-level items
  // (target population, HIV linkage, partner) are replayed from `women` onto every
  // row, exactly as the paper repeats them.
  if ($r==='registers' && $m==='GET'){ $u=require_auth();
    $type=$_GET['type']??'anc'; $fac=(int)$u['facility_id'];
    $from=$_GET['from']??date('Y-m-01'); $to=$_GET['to']??date('Y-m-d');
    if(!preg_match('/^\d{4}-\d{2}-\d{2}$/',$from)||!preg_match('/^\d{4}-\d{2}-\d{2}$/',$to)) err('bad date range');
    $W="w.mrn,w.first_name,w.father_name,w.age,w.kebele,w.woreda,w.lnmp,w.edd,
        w.ga_first_contact,w.late_anc_initiation,
        w.target_pop_code,w.hiv_known_positive,w.hiv_linked_pmtct,w.hiv_linked_pmtct_facility,w.hiv_linked_art,w.art_regimen,
        w.partner_hiv_accepted,w.partner_hiv_result,w.partner_target_pop_code,w.partner_linked_art";
    if($type==='anc'){
      $st=db()->prepare("SELECT a.*, $W FROM anc_visits a
        JOIN episodes e ON e.id=a.episode_id JOIN women w ON w.id=e.woman_id
        WHERE e.facility_id=? AND a.visit_date BETWEEN ? AND ? ORDER BY w.mrn, a.contact_no, a.visit_date");
    } elseif($type==='delivery'){
      // one row per newborn — the register says "use consecutive rows for each newborn"
      // b.mrn is the NEWBORN's; w.mrn is the mother's. Alias the newborn's so the
      // mother's (selected later in $W) doesn't overwrite it in the fetched row.
      $st=db()->prepare("SELECT b.*, b.mrn AS mrn_baby, d.delivery_datetime, d.mode, d.mode_other_text, d.partograph_used, d.episiotomy,
          d.amtsl_uterotonic_type, d.amtsl_cct, d.maternal_status, d.maternal_death_cause,
          d.comp_preeclampsia, d.comp_eclampsia, d.comp_aph, d.comp_pph, d.comp_other, d.referred,
          d.hiv_test_accepted, d.hiv_retest_accepted, d.hiv_test_result, d.cnsl_feeding_options,
          d.ippfp_acceptor, d.ippfp_method, d.remark AS delivery_remark, $W
        FROM babies b
        JOIN episodes e ON e.id=b.episode_id JOIN women w ON w.id=e.woman_id
        LEFT JOIN delivery_summary d ON d.episode_id=b.episode_id
        WHERE e.facility_id=? AND DATE(COALESCE(d.delivery_datetime,b.recorded_at)) BETWEEN ? AND ?
        ORDER BY d.delivery_datetime, w.mrn, b.birth_order");
    } elseif($type==='pnc'){
      $st=db()->prepare("SELECT p.*, e.place_of_delivery, e.infant_dob, $W FROM pnc_visits p
        JOIN episodes e ON e.id=p.episode_id JOIN women w ON w.id=e.woman_id
        WHERE e.facility_id=? AND p.visit_date BETWEEN ? AND ? ORDER BY w.mrn, p.visit_date");
    } else err('unknown register type');
    $st->execute([$fac,$from,$to]); $rows=$st->fetchAll();
    out(['type'=>$type,'from'=>$from,'to'=>$to,'facility'=>$u['facility_name']??'','count'=>count($rows),'rows'=>$rows]);
  }

  // ---- DHIS2 indicator export (aggregate) ----
  if ($r==='dhis2' && $m==='GET'){ $u=require_auth(); $ids=scoped_facility_ids($u); $in=implode(',',array_fill(0,count($ids),'?'));  // scoped to the user's facility / supervisor scope
    $fac=$_GET['facility']??$u['facility_id']; $period=$_GET['period']??date('Y-m');
    $one=function($sql,$p) use($ids){ $st=db()->prepare($sql); $st->execute(array_merge($ids,[$p])); return (int)($st->fetch()['c']??0); };
    $ind=[
      'deliveries'=>$one("SELECT COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id IN ($in) AND DATE_FORMAT(d.delivery_datetime,'%Y-%m')=?",$period),
      'fresh_stillbirths'=>$one("SELECT COUNT(*) c FROM babies b JOIN episodes e ON e.id=b.episode_id WHERE e.facility_id IN ($in) AND b.outcome='fresh_stillbirth' AND DATE_FORMAT(b.recorded_at,'%Y-%m')=?",$period),  // newborn record = source of truth
      'red_alerts'=>$one("SELECT COUNT(*) c FROM risk_scores s JOIN episodes e ON e.id=s.episode_id WHERE e.facility_id IN ($in) AND s.band='red' AND DATE_FORMAT(s.scored_at,'%Y-%m')=?",$period),
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

  // ---- Supervisor dashboard (cross-facility rollup, read-only) ----
  if ($r==='supervisor' && $m==='GET'){ $u=require_role(['supervisor','admin']); $ids=scoped_facility_ids($u);
    if(!$ids){ out(['scope'=>$u['scope']??'facility','facilities'=>[]]); }
    $in=implode(',',array_fill(0,count($ids),'?'));
    $facs=db()->prepare("SELECT id,name,woreda,zone,region FROM facilities WHERE id IN ($in) ORDER BY name"); $facs->execute($ids); $facRows=$facs->fetchAll();
    $days=(int)($_GET['days']??0); if($days<0)$days=0; if($days>3660)$days=3660;   // 0 = all time; sanitized int, safe to inline
    $dc=function($col) use($days){ return $days>0 ? " AND $col >= DATE_SUB(CURDATE(), INTERVAL $days DAY)" : ""; };
    $grp=function($sql) use($ids){ $st=db()->prepare($sql); $st->execute($ids); $o=[]; foreach($st->fetchAll() as $x){ $o[(int)$x['fid']]=(int)$x['c']; } return $o; };
    $labour   = $grp("SELECT facility_id fid, COUNT(*) c FROM episodes WHERE service_category='labour' AND facility_id IN ($in)".$dc('created_at')." GROUP BY facility_id");
    $partostd = $grp("SELECT e.facility_id fid, COUNT(DISTINCT o.episode_id) c FROM partograph_obs o JOIN episodes e ON e.id=o.episode_id WHERE e.facility_id IN ($in)".$dc('o.recorded_at')." GROUP BY e.facility_id");
    $deliv    = $grp("SELECT e.facility_id fid, COUNT(*) c FROM delivery_summary d JOIN episodes e ON e.id=d.episode_id WHERE e.facility_id IN ($in)".$dc('d.recorded_at')." GROUP BY e.facility_id");
    $reds     = $grp("SELECT e.facility_id fid, COUNT(*) c FROM risk_scores s JOIN episodes e ON e.id=s.episode_id WHERE s.band='red' AND e.facility_id IN ($in)".$dc('s.scored_at')." GROUP BY e.facility_id");
    $refs     = $grp("SELECT e.facility_id fid, COUNT(*) c FROM referrals rf JOIN episodes e ON e.id=rf.episode_id WHERE e.facility_id IN ($in)".$dc('rf.recorded_at')." GROUP BY e.facility_id");
    $rows=[]; foreach($facRows as $f){ $fid=(int)$f['id']; $lab=$labour[$fid]??0; $ps=$partostd[$fid]??0;
      $rows[]=['id'=>$fid,'name'=>$f['name'],'woreda'=>$f['woreda'],'zone'=>$f['zone'],
        'labour_episodes'=>$lab,'partographs_started'=>$ps,'partograph_completion'=>$lab?(int)round(100*$ps/$lab):0,
        'deliveries'=>$deliv[$fid]??0,'red_alerts'=>$reds[$fid]??0,'referrals'=>$refs[$fid]??0]; }
    out(['scope'=>$u['scope']??'facility','base_facility'=>(int)$u['facility_id'],'days'=>$days,'facilities'=>$rows]);
  }

  // ---- Reminders: list (supervisor/admin) + run scheduler (admin) ----
  if ($r==='reminders'){
    if($m==='GET'){ $u=require_role(['supervisor','admin']); $ids=scoped_facility_ids($u); if(!$ids)$ids=[0];
      $in=implode(',',array_fill(0,count($ids),'?'));
      $st=db()->prepare("SELECT r.*, w.first_name, w.father_name FROM reminders r LEFT JOIN women w ON w.id=r.woman_id WHERE r.facility_id IN ($in) ORDER BY r.id DESC LIMIT 300");
      $st->execute($ids); out($st->fetchAll()); }
    if($m==='POST' && $id==='run'){ require_role(['admin']); require __DIR__.'/reminders_lib.php'; out(reminders_run(db()), 200); }
  }

  err('not found: '.$r, 404);
} catch (Throwable $ex) { error_log('ADHERE API: '.$ex->getMessage()); err('server error', 500); }
