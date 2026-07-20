ALTER TABLE `processing_runs`
  ADD COLUMN `job_key` VARCHAR(255) NULL,
  ADD COLUMN `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `locked_by` VARCHAR(128) NULL,
  ADD COLUMN `locked_until` DATETIME(3) NULL,
  ADD COLUMN `last_heartbeat_at` DATETIME(3) NULL;

UPDATE `processing_runs`
SET `job_key` = CONCAT('legacy:', `id`)
WHERE `job_key` IS NULL;

ALTER TABLE `processing_runs`
  MODIFY COLUMN `job_key` VARCHAR(255) NOT NULL;

CREATE UNIQUE INDEX `processing_runs_job_key_key` ON `processing_runs`(`job_key`);
CREATE INDEX `processing_runs_status_available_at_locked_until_idx`
  ON `processing_runs`(`status`, `available_at`, `locked_until`);
