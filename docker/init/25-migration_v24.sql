-- =====================================================================================
-- ADHERE+ migration v24 — FACILITY ADMIN vs SUPER-ADMIN
--
-- `admin` used to be global: the users route was gated with require_role(['admin']) and nothing
-- else, so an admin at facility A could list every user everywhere, reset facility B's admin
-- password, and sign in as them. Clinical data is strictly facility-scoped everywhere else, which
-- made the users table the one lateral path between facilities. This closes it.
--
--   super_admin  — manages facilities, and users anywhere. There should be very few.
--   admin        — a facility's administrator. Users AT THEIR OWN FACILITY only. Cannot see,
--                  create or modify a user elsewhere, and cannot create or become a super_admin.
--
-- On a FRESH install the seeded bootstrap account is promoted to super_admin, so the person who
-- sets the system up can create facilities and their administrators.
-- =====================================================================================

ALTER TABLE users
  MODIFY COLUMN role ENUM('recorder','provider','observer','supervisor','admin','super_admin') NOT NULL;

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS adhere_seed_superadmin;
DELIMITER //
CREATE PROCEDURE adhere_seed_superadmin()
BEGIN
  DECLARE v_id  INT DEFAULT NULL;
  DECLARE v_un  VARCHAR(80) DEFAULT NULL;

  IF EXISTS (SELECT 1 FROM schema_fixups WHERE name='super_admin_v24') THEN
    SELECT 'ALREADY APPLIED — nothing done.' AS result;
  ELSEIF EXISTS (SELECT 1 FROM users WHERE role='super_admin') THEN
    SELECT 'A super_admin already exists — nothing changed.' AS result;
  ELSE
    SELECT id, username INTO v_id, v_un
      FROM users WHERE role='admin' ORDER BY id LIMIT 1;

    IF v_id IS NULL THEN
      SELECT 'No admin account found — nothing to promote.' AS result;
    ELSE
      UPDATE users SET role='super_admin' WHERE id=v_id;
      INSERT INTO schema_fixups(name,applied_at,note)
      VALUES('super_admin_v24', NOW(), CONCAT('promoted user #', v_id, ' (', v_un, ') to super_admin'));
      SELECT CONCAT('OK — "', v_un, '" is now super_admin.') AS result;
    END IF;
  END IF;
END //
DELIMITER ;

CALL adhere_seed_superadmin();
DROP PROCEDURE IF EXISTS adhere_seed_superadmin;
