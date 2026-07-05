<?php
// ADHERE+ reminder cron entry point (CLI only — not reachable over the web).
// Run inside the web container, e.g. from the host crontab:
//   */30 * * * *  docker exec deploy-web-1 php /var/www/html/api/cron_reminders.php >> /var/log/adhere-reminders.log 2>&1
if (php_sapi_name() !== 'cli') { http_response_code(403); exit('CLI only'); }
require __DIR__.'/db.php';
require __DIR__.'/reminders_lib.php';
try {
  $res = reminders_run(db());
  fwrite(STDOUT, date('c').' reminders '.json_encode($res).PHP_EOL);
} catch (Throwable $e) {
  fwrite(STDERR, date('c').' reminders ERROR '.$e->getMessage().PHP_EOL);
  exit(1);
}
