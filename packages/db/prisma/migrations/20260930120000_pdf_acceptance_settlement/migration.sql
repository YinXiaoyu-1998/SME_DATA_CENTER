-- Nullable controller-derived cleanup proof; no backfill or change to existing ownership.
ALTER TABLE `pdf_evidence_attempts`
  ADD COLUMN `acceptance_run_id` VARCHAR(32) NULL,
  ALGORITHM=INSTANT;
