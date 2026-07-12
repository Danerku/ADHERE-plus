-- =====================================================================================
-- ADHERE+ migration v22 — MAKE IDEMPOTENCY ACTUALLY IDEMPOTENT
--
-- WHAT WAS WRONG
-- idem_guard() was check-then-act:
--
--     SELECT 1 FROM idem_keys WHERE k=?    -- not there? carry on and write the clinical row
--     ...                                  -- (window)
--     INSERT IGNORE INTO idem_keys(k)      -- claimed only AFTER the row committed, in out()
--
-- Nothing sits between the check and the claim, so two requests carrying the SAME key can both
-- pass the SELECT and both insert the clinical row. That is not hypothetical: flush() had no
-- re-entrancy guard, and boot(), the 60-second timer and the browser's 'online' event could all
-- start a flush at once, replaying the same queued item concurrently. The result is a duplicate
-- episode, a duplicate ANC visit, or a duplicate baby — a phantom twin in the delivery register.
--
-- THE FIX (v4.3)
-- The key is now CLAIMED FIRST, atomically, using the primary key on idem_keys.k:
--
--     INSERT INTO idem_keys(k,state) VALUES(?,'pending')   -- whoever wins this owns the write
--
-- The loser of that race gets a duplicate-key error and returns the winner's stored response
-- instead of writing anything. On success the row is marked 'done' and the response body is kept,
-- so a client that retries after losing the response gets the SAME answer (including the new row's
-- id) rather than a bare {duplicate:true} it cannot use. On failure the claim is RELEASED, so a
-- genuinely failed write can still be retried.
--
-- This migration adds the two columns that makes that possible. Existing keys are marked 'done'
-- with no stored response, which is exactly what they were.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS idem_keys(
  k  VARCHAR(64) PRIMARY KEY,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_idem_at(at)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS adhere_addcol;
DELIMITER //
CREATE PROCEDURE adhere_addcol(IN p_tbl VARCHAR(64), IN p_col VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=p_tbl AND COLUMN_NAME=p_col) THEN
    SET @s=CONCAT('ALTER TABLE `',p_tbl,'` ADD COLUMN `',p_col,'` ',p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

-- 'pending' = a request is writing under this key right now.
-- 'done'    = the write committed; `response` holds exactly what the client was told.
CALL adhere_addcol('idem_keys','state',    "VARCHAR(10) NOT NULL DEFAULT 'done'");
CALL adhere_addcol('idem_keys','response', "MEDIUMTEXT NULL");

-- Anything already in the table pre-dates this change and had, by definition, committed.
UPDATE idem_keys SET state='done' WHERE state IS NULL OR state='';

DROP PROCEDURE IF EXISTS adhere_addcol;
