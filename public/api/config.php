<?php
return [
  'db_host' => getenv('DB_HOST') ?: 'db',
  'db_name' => getenv('DB_NAME') ?: 'adhere',
  'db_user' => getenv('DB_USER') ?: 'adhere',
  'db_pass' => getenv('DB_PASS') ?: 'adhere',
];
