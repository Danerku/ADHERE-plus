-- =====================================================================================
-- ADHERE+ migration v24 — FACILITY ADMIN vs SUPER-ADMIN
--
-- WHAT WAS WRONG
-- `admin` was global. The users route was gated with require_role(['admin']) and NOTHING ELSE —
-- no check that the target user belonged to the admin's own facility. So an admin at facility A
-- could:
--     GET    /api/users                       -> list every user at every facility
--     POST   /api/users {facility_id: B}      -> mint themselves an admin at facility B
--     PATCH  /api/users/<B's admin> {password}-> reset another facility's admin password
-- and then sign in as that account. Every clinical route scopes to the SESSION's facility, so
-- patient data is otherwise strictly separated between facilities — which makes the users table
-- the one and only lateral path between them. This closes it.
--
-- THE MODEL (chosen deliberately)
--   super_admin  — you. Manages facilities, and users anywhere. There should be very few.
--   admin        — a facility's administrator. Manages users AT THEIR OWN FACILITY only.
--                  Cannot see, create or modify a user at any other facility, cannot create a
--                  super_admin, and cannot promote anyone (including themselves) to one.
--   supervisor / provider / recorder / observer — unchanged.
--
-- WHAT THIS DOES
--   1. Adds 'super_admin' to the role enum (and folds in 'supervisor', which the application has
--      been using for some time but which the original enum never listed).
--   2. Promotes exactly ONE existing admin — the oldest — to super_admin, so that whoever set the
--      system up keeps the reach they have today and nobody is locked out. Every other admin
--      becomes a facility admin.
--
-- IT DOES NOT promote every admin: that would leave the hole exactly as it is. If the account it
-- picks is the wrong one, the last section of this file shows how to move it.
-- =====================================================================================

ALTER TABLE users
  MODIFY COLUMN role ENUM('recorder','provider','observer','supervisor','admin','super_admin') NOT NULL;

CREATE TABLE IF NOT EXISTS schema_fixups (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME    NOT NULL,
  note       VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who the admins are today (look at this before and after).
SELECT id, username, full_name, facility_id, role, is_active
  FROM users WHERE role IN ('admin','super_admin') ORDER BY id;

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
    -- the oldest admin account: whoever bootstrapped the system
    SELECT id, username INTO v_id, v_un
      FROM users WHERE role='admin' ORDER BY id LIMIT 1;

    IF v_id IS NULL THEN
      SELECT 'No admin account found — nothing to promote. Create one, then re-run.' AS result;
    ELSE
      UPDATE users SET role='super_admin' WHERE id=v_id;
      INSERT INTO schema_fixups(name,applied_at,note)
      VALUES('super_admin_v24', NOW(), CONCAT('promoted user #', v_id, ' (', v_un, ') to super_admin'));
      SELECT CONCAT('OK — "', v_un, '" (user #', v_id, ') is now super_admin. Every other admin is now scoped to their own facility.') AS result;
    END IF;
  END IF;
END //
DELIMITER ;

CALL adhere_seed_superadmin();
DROP PROCEDURE IF EXISTS adhere_seed_superadmin;

SELECT id, username, full_name, facility_id, role, is_active
  FROM users WHERE role IN ('admin','super_admin') ORDER BY id;

-- ---------------------------------------------------------------------------------------
-- IF IT PROMOTED THE WRONG ACCOUNT
--   UPDATE users SET role='super_admin' WHERE username='<the right one>';
--   UPDATE users SET role='admin'       WHERE username='<the wrong one>';
-- Keep at least one super_admin, or nobody can create facilities.
-- ---------------------------------------------------------------------------------------
