-- =====================================================================================
-- ADHERE+ migration v21 — CLINIC-LOCAL TIME
--
-- WHAT WAS WRONG
-- Ethiopia is UTC+3 and observes no DST. The browser wrote every timestamp with
-- toISOString(), i.e. in UTC, while the Ethiopian-calendar picker wrote LOCAL dates, and
-- PHP/MySQL both ran in UTC. So a single patient record held two different clocks:
--
--   * the partograph monitoring schedule read a just-saved observation as ~3 hours old,
--     so every parameter printed "due now (overdue 150m)" the moment it was recorded;
--   * a birth between 00:00 and 03:00 local was stored on the PREVIOUS day — and, on the
--     1st of the month, counted into the PREVIOUS month's MoH report;
--   * EDD came out one day early (LNMP + 279 instead of + 280).
--
-- From v4.2 the app writes local wall-clock and PHP + the MySQL session are pinned to the
-- same zone. This migration brings the rows that are ALREADY in the database onto that
-- same clock.
--
-- WHAT THIS DOES
-- Adds 3 hours to every DATETIME column in the schema.
--
--   * DATETIME columns store a literal wall-clock value. Ours were written in UTC, so they
--     are three hours behind the clinic clock and must be shifted. That is every clinical
--     timestamp: obs_datetime, delivery_datetime, admission_datetime, recorded_at, ...
--   * TIMESTAMP columns are NOT touched. MySQL stores those as an absolute instant and
--     converts them using the session time zone, so pinning the session (done in db.php)
--     already renders them correctly. Shifting them would break them.
--   * DATE columns are NOT touched. The Ethiopian-calendar picker has always produced local
--     dates, so they are already right. (Caveat: the handful of DATE values PHP derived from
--     date('Y-m-d') for a record created between 00:00 and 03:00 local are one day early and
--     are not recoverable from the row itself. Volume is small; flagged rather than guessed.)
--
-- SAFETY
-- This is NOT idempotent by nature — running it twice would shift the data six hours. It is
-- therefore guarded by a marker table: the second run detects the marker and does nothing.
-- TAKE A BACKUP FIRST. Verification queries are at the bottom.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS adhere_tz_shift;
DELIMITER //
CREATE PROCEDURE adhere_tz_shift(IN p_hours INT)
BEGIN
  DECLARE v_done  INT DEFAULT 0;
  DECLARE v_tbl   VARCHAR(64);
  DECLARE v_col   VARCHAR(64);
  DECLARE v_n     INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT c.TABLE_NAME, c.COLUMN_NAME
      FROM information_schema.COLUMNS c
      JOIN information_schema.TABLES t
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = DATABASE()
       AND c.DATA_TYPE    = 'datetime'          -- DATETIME only. Not TIMESTAMP. Not DATE.
       AND t.TABLE_TYPE   = 'BASE TABLE'
       AND c.TABLE_NAME NOT IN ('schema_fixups','idem_keys')   -- bookkeeping, not clinical
     ORDER BY c.TABLE_NAME, c.COLUMN_NAME;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  -- Guard: refuse to run a second time.
  IF EXISTS (SELECT 1 FROM schema_fixups WHERE name = 'tz_utc_to_local_v21') THEN
    SELECT 'ALREADY APPLIED — nothing done. The data is already on clinic-local time.' AS result;
  ELSE
    OPEN cur;
    shift_loop: LOOP
      FETCH cur INTO v_tbl, v_col;
      IF v_done = 1 THEN LEAVE shift_loop; END IF;

      SET @s = CONCAT('UPDATE `', v_tbl, '` SET `', v_col, '` = `', v_col,
                      '` + INTERVAL ', p_hours, ' HOUR WHERE `', v_col, '` IS NOT NULL');
      PREPARE st FROM @s;
      EXECUTE st;
      DEALLOCATE PREPARE st;
      SET v_n = v_n + 1;
    END LOOP;
    CLOSE cur;

    INSERT INTO schema_fixups (name, applied_at, note)
    VALUES ('tz_utc_to_local_v21', NOW(),
            CONCAT('shifted ', v_n, ' DATETIME columns by +', p_hours, 'h (UTC -> Africa/Addis_Ababa)'));

    SELECT CONCAT('OK — shifted ', v_n, ' DATETIME columns by +', p_hours, ' hour(s).') AS result;
  END IF;
END //
DELIMITER ;

-- Ethiopia = UTC+3, no DST.
CALL adhere_tz_shift(3);

DROP PROCEDURE IF EXISTS adhere_tz_shift;

-- ---------------------------------------------------------------------------------------
-- VERIFY (run these after; they should look like clinic time, not three hours behind)
--
--   SELECT * FROM schema_fixups;
--
--   SELECT id, obs_datetime, TIMESTAMPDIFF(MINUTE, obs_datetime, NOW()) AS mins_ago
--     FROM observations ORDER BY id DESC LIMIT 5;
--   -- mins_ago should be a plausible age. Before this fix the newest row read ~180+.
--
--   SELECT id, delivery_datetime FROM delivery_summary ORDER BY id DESC LIMIT 5;
--   SELECT @@session.time_zone, NOW(), CURDATE();
-- ---------------------------------------------------------------------------------------
