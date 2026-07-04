<?php
function db() {
  static $pdo = null;
  if ($pdo) return $pdo;
  $c = require __DIR__.'/config.php';
  $dsn = "mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4";
  $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  return $pdo;
}
