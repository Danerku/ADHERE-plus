-- =====================================================================================
-- ADHERE+ migration v25 — NO MORE PHANTOM TWINS
--
-- WHAT WAS WRONG
-- `babies` had no unique key on (episode_id, birth_order), and the newborn screen had no way to
-- EDIT an existing baby — only to add one. A newborn's DBS result, or a corrected birth weight,
-- comes back days later. The only way to record it was to save the newborn form again, which
-- inserted a SECOND row with birth_order = past.length + 1.
--
-- That is a phantom twin. It inflates `births` and `stillbirths` on the dashboard, and prints a
-- duplicate line in the MoH Delivery register (one row per newborn). A facility reporting two
-- births for one delivery is reporting the wrong number to the Ministry.
--
-- From v4.6 the newborn screen edits an existing baby in place (PATCH), and the database refuses
-- a second baby at the same birth order for the same delivery.
--
-- WHAT THIS DOES
--   1. Reports the duplicates already present, so you can see them before anything changes.
--   2. Renumbers any duplicate birth_order within a delivery so that the unique key can be added
--      without losing a row. NOTHING IS DELETED — a real twin keeps both babies, correctly ordered;
--      an accidental duplicate keeps both rows too, and a provider can look at them and decide.
--      Guessing which of two rows is the "real" newborn is not a decision a migration should make.
--   3. Adds UNIQUE (episode_id, birth_order).
-- =====================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- what is duplicated today ----
SELECT b.episode_id, b.birth_order, COUNT(*) AS rows_at_this_birth_order,
       GROUP_CONCAT(b.id ORDER BY b.id) AS baby_ids
  FROM babies b
 GROUP BY b.episode_id, b.birth_order
HAVING COUNT(*) > 1
 ORDER BY b.episode_id;

DROP PROCEDURE IF EXISTS adhere_dedupe_babies;
DELIMITER //
CREATE PROCEDURE adhere_dedupe_babies()
BEGIN
  DECLARE v_n INT DEFAULT 0;

  IF EXISTS (SELECT 1 FROM schema_fixups WHERE name='babies_unique_v25') THEN
    SELECT 'ALREADY APPLIED — nothing done.' AS result;
  ELSE
    -- Renumber every baby within its delivery: 1, 2, 3 ... in id order. A genuine twin pair keeps
    -- both babies (1 and 2). A duplicate row also keeps both, but stops colliding — so the unique
    -- key can go on, and a human can decide which is real.
    -- Derived table, not a correlated subquery on `babies` itself: MySQL rejects reading the table
    -- you are updating (error 1093).
    UPDATE babies b
      JOIN (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY episode_id ORDER BY id) AS seq
          FROM babies
      ) x ON x.id = b.id
       SET b.birth_order = x.seq
     WHERE b.birth_order <> x.seq;
    SET v_n = ROW_COUNT();

    INSERT INTO schema_fixups(name,applied_at,note)
    VALUES('babies_unique_v25', NOW(), CONCAT('renumbered ', v_n, ' baby rows; added UNIQUE(episode_id,birth_order)'));

    SELECT CONCAT('OK — renumbered ', v_n, ' baby row(s).') AS result;
  END IF;
END //
DELIMITER ;

CALL adhere_dedupe_babies();
DROP PROCEDURE IF EXISTS adhere_dedupe_babies;

-- Now the constraint can go on. If this FAILS, the renumbering above did not resolve a collision —
-- do not force it; send me the output of the duplicate query at the top of this file.
ALTER TABLE babies
  ADD UNIQUE KEY uk_baby_order (episode_id, birth_order);

-- ---- anything left that a provider should look at ----
-- Two babies on one delivery is normal (twins). Two babies with the SAME weight, sex and outcome
-- on one delivery is more likely a duplicate entry than a twin pair. This does not change anything;
-- it just shows you where to look.
SELECT b1.episode_id, b1.id AS baby_a, b2.id AS baby_b,
       b1.sex, b1.weight_g, b1.outcome,
       'same sex, weight and outcome — check whether this is really a twin' AS note
  FROM babies b1
  JOIN babies b2
    ON b2.episode_id = b1.episode_id
   AND b2.id > b1.id
   AND b2.sex     <=> b1.sex
   AND b2.weight_g<=> b1.weight_g
   AND b2.outcome <=> b1.outcome
 ORDER BY b1.episode_id;
