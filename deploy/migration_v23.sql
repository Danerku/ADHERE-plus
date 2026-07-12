-- =====================================================================================
-- ADHERE+ migration v23 — CLOSE THE EPISODES THAT SHOULD ALREADY HAVE ENDED
--
-- WHAT WAS WRONG
-- No episode in ADHERE+ has ever closed. The enum has 'closed' and 'discharged', the table has
-- closed_datetime, and NOT ONE LINE of the application ever wrote either. So an episode of care,
-- once opened, stayed on a worklist for the life of the facility.
--
-- The visible consequence: a woman admitted in labour kept her ANTENATAL episode 'active'. She
-- then appeared on the antenatal worklist AND the labour ward simultaneously, the high-risk list
-- returned her twice (once per episode), and the Home tile counts only ever climbed. This is the
-- Hiwot Bekele record (MRN 88001) — an ANC episode left open by a transfer.
--
-- From v4.4 the application closes an ANC episode when the woman is admitted in labour, and gives
-- the provider an explicit "Close this episode of care" action. This migration retires the
-- episodes that are ALREADY stranded.
--
-- WHAT THIS DOES — and deliberately does not do
-- Closes ONLY antenatal episodes that a LATER labour episode for the SAME WOMAN at the SAME
-- FACILITY has superseded. That is a fact, not a guess: she cannot still be receiving antenatal
-- care for a pregnancy she has since been admitted in labour for.
--
-- It does NOT close:
--   * labour or postnatal episodes — a woman may still legitimately be under postnatal care, and
--     guessing a discharge date we do not have would be inventing clinical data;
--   * antenatal episodes with no subsequent labour episode — she may simply still be pregnant.
-- Those are for the provider to close from the patient's record, where she can see the woman.
--
-- Nothing is deleted. Closing changes a status; every clinical row is untouched and the whole
-- record stays readable. An episode closed in error can be reopened from the patient's record.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- what will be closed (run on its own first if you want to look before you leap) ----
SELECT COUNT(*) AS anc_episodes_superseded_by_labour
  FROM episodes a
 WHERE a.service_category='anc'
   AND a.status<>'closed'
   AND EXISTS (SELECT 1 FROM episodes l
                WHERE l.woman_id   = a.woman_id
                  AND l.facility_id= a.facility_id
                  AND l.service_category='labour'
                  AND l.id > a.id);

DROP PROCEDURE IF EXISTS adhere_close_stranded;
DELIMITER //
CREATE PROCEDURE adhere_close_stranded()
BEGIN
  DECLARE v_n INT DEFAULT 0;

  IF EXISTS (SELECT 1 FROM schema_fixups WHERE name='close_stranded_anc_v23') THEN
    SELECT 'ALREADY APPLIED — nothing done.' AS result;
  ELSE
    -- NOTE ON THE SHAPE OF THIS STATEMENT.
    -- The obvious form — UPDATE episodes a ... WHERE EXISTS (SELECT ... FROM episodes l ...) —
    -- is rejected by MySQL with error 1093 ("You can't specify target table 'a' for update in
    -- FROM clause"): you may not read the table you are updating in a subquery. Joining against a
    -- DERIVED table is allowed, because MySQL materialises it first, so the read is finished
    -- before the write begins. Same result, and it is a single atomic statement.
    UPDATE episodes a
      JOIN (
        SELECT anc.id AS anc_id,
               MIN(lab.admission_datetime) AS labour_started   -- close it as of the labour admission, not "now"
          FROM episodes anc
          JOIN episodes lab
            ON  lab.woman_id        = anc.woman_id
            AND lab.facility_id     = anc.facility_id
            AND lab.service_category= 'labour'
            AND lab.id              > anc.id                    -- the labour admission came AFTER the ANC episode
         WHERE anc.service_category = 'anc'
           AND anc.status          <> 'closed'
         GROUP BY anc.id
      ) x ON x.anc_id = a.id
       SET a.status          = 'closed',
           a.closed_datetime = COALESCE(x.labour_started, NOW());
    SET v_n = ROW_COUNT();

    INSERT INTO schema_fixups(name,applied_at,note)
    VALUES('close_stranded_anc_v23', NOW(),
           CONCAT('closed ', v_n, ' ANC episodes superseded by a labour admission'));

    SELECT CONCAT('OK — closed ', v_n, ' stranded ANC episode(s).') AS result;
  END IF;
END //
DELIMITER ;

CALL adhere_close_stranded();
DROP PROCEDURE IF EXISTS adhere_close_stranded;

-- ---- WHO IS STILL ON MORE THAN ONE WORKLIST, AND WHY --------------------------------------
-- The migration closes only what it can PROVE is finished (an antenatal episode superseded by a
-- labour admission). Anything else is left alone on purpose — a woman may still legitimately be
-- under labour and postnatal care at once, and inventing a discharge we do not have would be
-- fabricating clinical data. This lists whatever remains, with enough detail to decide, so a
-- provider can close them from the patient's record (Open her chart -> "Close this episode of
-- care"). Going forward, the application no longer creates these.
SELECT e.woman_id,
       w.mrn,
       CONCAT(w.first_name,' ',w.father_name) AS name,
       e.id            AS episode_id,
       e.service_category,
       e.status,
       DATE(e.admission_datetime) AS admitted,
       (SELECT COUNT(*) FROM delivery_summary d WHERE d.episode_id=e.id) AS has_delivery
  FROM episodes e
  JOIN women  w ON w.id = e.woman_id
 WHERE e.status <> 'closed'
   AND e.woman_id IN (SELECT woman_id FROM (
         SELECT woman_id FROM episodes WHERE status<>'closed'
          GROUP BY woman_id HAVING COUNT(*) > 1) t)
 ORDER BY e.woman_id, e.id;

-- ---------------------------------------------------------------------------------------
-- VERIFY
--   SELECT * FROM schema_fixups;                       -- expect close_stranded_anc_v23
-- ---------------------------------------------------------------------------------------
