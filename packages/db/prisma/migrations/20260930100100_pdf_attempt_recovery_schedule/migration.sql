ALTER TABLE `pdf_evidence_attempts`
  ADD COLUMN `next_recovery_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  DROP INDEX `pdf_evidence_attempts_state_updated_at_idx`,
  ADD INDEX `pdf_evidence_attempts_state_next_recovery_at_idx` (`state`, `next_recovery_at`);
