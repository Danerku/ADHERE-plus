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
  // Pin the MySQL session to the SAME zone PHP is using, so NOW(), CURDATE() and
  // CURRENT_TIMESTAMP columns (created_at, referred_at, linked_at, sent_at ...) land on the
  // clinic's wall clock, not UTC. A numeric offset is used deliberately: named zones require
  // the mysql tz tables to have been loaded, which they are not in the stock image.
  $off = (new DateTime('now', new DateTimeZone(date_default_timezone_get())))->format('P'); // e.g. +03:00
  $pdo->exec("SET time_zone = '{$off}'");
  return $pdo;
}
