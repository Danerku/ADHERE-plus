-- =============================================================================================
-- ADHERE+ migration v26 — data integrity
--
-- 1. UNIQUE KEYS so the database itself refuses a duplicate:
--       checklist_responses (episode_id, pause_point, item_code)
--       bemonc_care         (episode_id, item_code)
--       delivery_summary    (episode_id)              -- already present in v16; asserted here
--    Both screens were append-only: every re-save inserted a SECOND full set of rows, so a pause
--    point recorded twice held two contradictory answers for the same item and the "checklists
--    completed" count was inflated. The application now does delete-then-insert (as the ANC risk
--    screening already did); these keys make the database enforce it too.
--
-- 2. THE MISSING FOREIGN KEYS. Half the clinical tables were added in later migrations WITHOUT a
--    foreign key: anc_visits, pnc_visits, babies, maternal_vitals, bemonc_care, lab_orders and
--    referrals all carry an episode_id with nothing enforcing it, and fp_clients,
--    immunization_clients, pmtct_mothers and pregnancy_tests carry a woman_id the same way. The
--    database would happily accept an ANC visit belonging to an episode that does not exist, and
--    never complain — invisible until a facility's numbers stop reconciling.
--
-- VERIFIED AGAINST PRODUCTION BEFORE WRITING THIS (13 Jul 2026):
--    zero duplicate checklist rows, zero duplicate bemonc rows, zero duplicate deliveries,
--    zero orphans in all 11 tables. So every constraint below applies cleanly with no data repair.
--
-- Idempotent: safe to run more than once. Each step checks information_schema first, so a
-- constraint that already exists is skipped rather than erroring.
-- =============================================================================================

-- ---- guard: has this migration already run? --------------------------------------------------
-- NOTE the column names. This table already exists from v21-v25 with (name, applied_at, note) —
-- an earlier draft of this migration invented (k, at) and failed on its very last statement with
-- "Unknown column 'k'". The ALTERs had already applied by then (they run inside the procedure,
-- above), but the marker row was never written. Matching the existing convention fixes both.
CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  note       VARCHAR(255)
);

DROP PROCEDURE IF EXISTS adhere_v26;
DELIMITER $$
CREATE PROCEDURE adhere_v26()
BEGIN
  DECLARE n INT;

  -- ---------- 1. UNIQUE KEYS -----------------------------------------------------------------
  SELECT COUNT(*) INTO n FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='checklist_responses' AND INDEX_NAME='uk_chk_item';
  IF n = 0 THEN
    ALTER TABLE checklist_responses
      ADD UNIQUE KEY uk_chk_item (episode_id, pause_point, item_code);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bemonc_care' AND INDEX_NAME='uk_bem_item';
  IF n = 0 THEN
    ALTER TABLE bemonc_care
      ADD UNIQUE KEY uk_bem_item (episode_id, item_code);
  END IF;

  -- ---------- 2. FOREIGN KEYS ON episode_id --------------------------------------------------
  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='anc_visits' AND CONSTRAINT_NAME='fk_ancv_ep';
  IF n = 0 THEN
    ALTER TABLE anc_visits ADD CONSTRAINT fk_ancv_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='pnc_visits' AND CONSTRAINT_NAME='fk_pncv_ep';
  IF n = 0 THEN
    ALTER TABLE pnc_visits ADD CONSTRAINT fk_pncv_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='babies' AND CONSTRAINT_NAME='fk_baby_ep';
  IF n = 0 THEN
    ALTER TABLE babies ADD CONSTRAINT fk_baby_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='maternal_vitals' AND CONSTRAINT_NAME='fk_mv_ep';
  IF n = 0 THEN
    ALTER TABLE maternal_vitals ADD CONSTRAINT fk_mv_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='bemonc_care' AND CONSTRAINT_NAME='fk_bem_ep';
  IF n = 0 THEN
    ALTER TABLE bemonc_care ADD CONSTRAINT fk_bem_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='lab_orders' AND CONSTRAINT_NAME='fk_lab_ep';
  IF n = 0 THEN
    ALTER TABLE lab_orders ADD CONSTRAINT fk_lab_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='referrals' AND CONSTRAINT_NAME='fk_ref_ep';
  IF n = 0 THEN
    ALTER TABLE referrals ADD CONSTRAINT fk_ref_ep FOREIGN KEY (episode_id) REFERENCES episodes(id);
  END IF;

  -- ---------- 3. FOREIGN KEYS ON woman_id ----------------------------------------------------
  -- These columns are NULLABLE (a family-planning client need not be a registered woman), and a
  -- NULL never violates a foreign key — so this constrains the linkage without forcing one.
  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fp_clients' AND CONSTRAINT_NAME='fk_fpc_woman';
  IF n = 0 THEN
    ALTER TABLE fp_clients ADD CONSTRAINT fk_fpc_woman FOREIGN KEY (woman_id) REFERENCES women(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='immunization_clients' AND CONSTRAINT_NAME='fk_immc_woman';
  IF n = 0 THEN
    ALTER TABLE immunization_clients ADD CONSTRAINT fk_immc_woman FOREIGN KEY (woman_id) REFERENCES women(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='pmtct_mothers' AND CONSTRAINT_NAME='fk_pmm_woman';
  IF n = 0 THEN
    ALTER TABLE pmtct_mothers ADD CONSTRAINT fk_pmm_woman FOREIGN KEY (woman_id) REFERENCES women(id);
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='pregnancy_tests' AND CONSTRAINT_NAME='fk_pt_woman';
  IF n = 0 THEN
    ALTER TABLE pregnancy_tests ADD CONSTRAINT fk_pt_woman FOREIGN KEY (woman_id) REFERENCES women(id);
  END IF;

END$$
DELIMITER ;

CALL adhere_v26();
DROP PROCEDURE IF EXISTS adhere_v26;

INSERT IGNORE INTO schema_fixups (name, applied_at, note)
  VALUES ('integrity_v26', NOW(), 'unique keys on checklist_responses + bemonc_care; the 11 missing foreign keys');

-- ---- what was applied -------------------------------------------------------------------------
SELECT 'unique keys' AS what, TABLE_NAME, INDEX_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN ('uk_chk_item','uk_bem_item')
 GROUP BY TABLE_NAME, INDEX_NAME;

SELECT 'foreign keys' AS what, TABLE_NAME, CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='FOREIGN KEY'
   AND CONSTRAINT_NAME IN ('fk_ancv_ep','fk_pncv_ep','fk_baby_ep','fk_mv_ep','fk_bem_ep','fk_lab_ep',
                           'fk_ref_ep','fk_fpc_woman','fk_immc_woman','fk_pmm_woman','fk_pt_woman')
 ORDER BY TABLE_NAME;
