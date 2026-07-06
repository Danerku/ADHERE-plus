-- =====================================================================
-- ADHERE+ init 11 — Wave 4 (folded in from migration_v10)
-- ANC risk screening care-plan capture: widen item_group/response to VARCHAR.
-- Idempotent — safe on fresh install and re-runs.
-- =====================================================================
SET NAMES utf8mb4;

ALTER TABLE anc_risk_screening MODIFY COLUMN item_group VARCHAR(30) NOT NULL;
ALTER TABLE anc_risk_screening MODIFY COLUMN response   VARCHAR(255) NOT NULL;
