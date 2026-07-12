-- =====================================================================================
-- ADHERE+ migration v25 — NO MORE PHANTOM TWINS
--
-- `babies` had no unique key on (episode_id, birth_order), and the newborn screen could only ADD a
-- baby, never correct one. A DBS result or a corrected weight comes back days later — so the only
-- way to record it was to save the form again, inserting a SECOND row at birth_order = n+1.
--
-- That is a phantom twin: it inflates births and stillbirths, and prints a duplicate line in the
-- MoH Delivery register. A facility reporting two births for one delivery is reporting the wrong
-- number to the Ministry.
--
-- From v4.6 the newborn screen corrects an existing baby in place (PATCH), and the database
-- refuses a second baby at the same birth order for the same delivery.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS adhere_dedupe_babies;
DELIMITER //
CREATE PROCEDURE adhere_dedupe_babies()
BEGIN
  DECLARE v_n INT DEFAULT 0;

  IF EXISTS (SELECT 1 FROM schema_fixups WHERE name='babies_unique_v25') THEN
    SELECT 'ALREADY APPLIED — nothing done.' AS result;
  ELSE
    -- Renumber every baby within its delivery: 1, 2, 3 ... in id order, so the unique key can be
    -- added without losing a row. Nothing is deleted. A derived table, not a correlated subquery on
    -- `babies` itself: MySQL rejects reading the table you are updating (error 1093).
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

ALTER TABLE babies
  ADD UNIQUE KEY uk_baby_order (episode_id, birth_order);
