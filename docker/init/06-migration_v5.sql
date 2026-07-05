-- =====================================================================
-- ADHERE+ init 06 — Wave 1 build (folded in from migration_v5)
--   * partograph_obs.caput           (caput succedaneum grade)
--   * anc_visits.contact_no          (WHO 8-contact number / visit type)
-- Idempotent: safe on fresh install and re-runs.
-- =====================================================================
SET NAMES utf8mb4;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema=DATABASE() AND table_name='partograph_obs' AND column_name='caput');
SET @s := IF(@c=0,
  "ALTER TABLE partograph_obs ADD COLUMN caput ENUM('0','+1','+2','+3') NULL AFTER moulding",
  "SELECT 'caput exists'");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c2 := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema=DATABASE() AND table_name='anc_visits' AND column_name='contact_no');
SET @s2 := IF(@c2=0,
  "ALTER TABLE anc_visits ADD COLUMN contact_no VARCHAR(20) NULL AFTER visit_date",
  "SELECT 'contact_no exists'");
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;
