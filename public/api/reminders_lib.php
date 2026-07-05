<?php
// =====================================================================
// ADHERE+ reminder scheduler (shared by the API route and the cron job).
// Finds due ANC follow-up appointments for consented women with a phone,
// queues a short Amharic reminder, and "sends" it via a stub.
//
// PRODUCTION: replace sms_send_stub() with a call to your bulk-SMS gateway
// (Ethio Telecom / aggregator). Keep the same signature and return value.
// =====================================================================

function sms_send_stub($phone, $message){
  // ---- Integration point -------------------------------------------
  // Example (pseudo): POST to gateway with sender ID + $phone + $message,
  // return true only when the gateway accepts the message for delivery.
  // For now we simulate acceptance and log so the pipeline is testable.
  error_log('ADHERE SMS -> '.$phone.' : '.$message);
  return $phone !== null && strlen(preg_replace('/\D/','',$phone)) >= 7;
}

// Generate due reminders + send any pending ones. Returns a small summary.
function reminders_run($db, $windowDays = 2){
  $generated = 0; $sent = 0; $failed = 0; $skipped = 0;

  // 1) Generate — ANC visits with a next_appointment inside the window,
  //    that don't already have a reminder for that woman + date.
  $due = $db->prepare(
    "SELECT av.next_appointment AS due, e.id AS episode_id, e.woman_id, e.facility_id,
            w.first_name, w.father_name, w.phone, w.sms_consent, f.name AS fac
       FROM anc_visits av
       JOIN episodes e ON e.id = av.episode_id
       JOIN women   w ON w.id = e.woman_id
       LEFT JOIN facilities f ON f.id = e.facility_id
      WHERE av.next_appointment IS NOT NULL
        AND av.next_appointment BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)");
  $due->execute([$windowDays]);
  foreach($due->fetchAll() as $r){
    $ex = $db->prepare("SELECT id FROM reminders WHERE woman_id=? AND due_date=? AND kind='anc'");
    $ex->execute([$r['woman_id'], $r['due']]);
    if($ex->fetch()) continue;                       // already queued
    $name = trim(($r['first_name'] ?? '').' '.($r['father_name'] ?? ''));
    if(empty($r['sms_consent']) || empty($r['phone'])){
      $db->prepare("INSERT INTO reminders(woman_id,episode_id,facility_id,kind,due_date,phone,message,status,provider_note)
                    VALUES(?,?,?,?,?,?,?, 'skipped', ?)")
         ->execute([$r['woman_id'],$r['episode_id'],$r['facility_id'],'anc',$r['due'],$r['phone'],'',
                    empty($r['sms_consent']) ? 'no SMS consent' : 'no phone on file']);
      $generated++; $skipped++; continue;
    }
    // Amharic ANC reminder: greeting, name, appointment date, facility.
    $msg = 'ጤና ይስጥልኝ '.$name.'። የቅድመ-ወሊድ ክትትል ቀጠሮዎ '.$r['due'].' ነው። እባክዎ '.($r['fac'] ?: 'ጤና ተቋሙ').' ይምጡ። (ADHERE+)';
    if(mb_strlen($msg) > 300) $msg = mb_substr($msg, 0, 300);
    $db->prepare("INSERT INTO reminders(woman_id,episode_id,facility_id,kind,due_date,phone,message,status)
                  VALUES(?,?,?,?,?,?,?, 'pending')")
       ->execute([$r['woman_id'],$r['episode_id'],$r['facility_id'],'anc',$r['due'],$r['phone'],$msg]);
    $generated++;
  }

  // 2) Send — every pending reminder through the gateway stub.
  $pend = $db->query("SELECT id, phone, message FROM reminders WHERE status='pending' ORDER BY id LIMIT 500")->fetchAll();
  foreach($pend as $p){
    if(sms_send_stub($p['phone'], $p['message'])){
      $db->prepare("UPDATE reminders SET status='sent', sent_at=NOW() WHERE id=?")->execute([$p['id']]); $sent++;
    } else {
      $db->prepare("UPDATE reminders SET status='failed' WHERE id=?")->execute([$p['id']]); $failed++;
    }
  }
  return ['generated'=>$generated, 'sent'=>$sent, 'failed'=>$failed, 'skipped'=>$skipped];
}
