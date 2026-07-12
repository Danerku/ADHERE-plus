<?php
// Fail closed in production: if a public SITE_DOMAIN is configured (i.e. this is a real
// deployment, not the local dev compose) the DB password must be set to a non-empty value.
$__pass = getenv('DB_PASS');
$__prod = getenv('SITE_DOMAIN') !== false && getenv('SITE_DOMAIN') !== '';
if ($__prod && ($__pass === false || $__pass === '')) {
  http_response_code(500);
  header('Content-Type: application/json');
  echo json_encode(['error' => 'server misconfigured']);
  exit;
}
// Clinic-local time. The browser writes local wall-clock (see localDateTime() in app.js) and
// the Ethiopian-calendar picker has always produced local dates, so PHP's date() and MySQL's
// NOW()/CURDATE() must resolve in the SAME zone or the record mixes two clocks: timestamps
// three hours behind the dates beside them. Ethiopia observes no DST, so the offset is fixed.
date_default_timezone_set(getenv('APP_TZ') ?: 'Africa/Addis_Ababa');

return [
  'db_host' => getenv('DB_HOST') ?: 'db',
  'db_name' => getenv('DB_NAME') ?: 'adhere',
  'db_user' => getenv('DB_USER') ?: 'adhere',
  'db_pass' => ($__pass !== false && $__pass !== '') ? $__pass : 'adhere',
];
