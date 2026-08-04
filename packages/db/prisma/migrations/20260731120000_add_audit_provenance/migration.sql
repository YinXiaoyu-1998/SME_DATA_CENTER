ALTER TABLE `audit_logs`
  ADD COLUMN `client_source` VARCHAR(32) NULL,
  ADD COLUMN `launcher_version` VARCHAR(64) NULL;
