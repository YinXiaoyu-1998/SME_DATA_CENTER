-- Additive browser sessions; no tenant/grant or launcher-session changes.
CREATE TABLE `browser_sessions` (
  `id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `employee_id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `secret_hash` CHAR(64) NOT NULL,
  `credential_fingerprint` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `browser_sessions_secret_hash_key` (`secret_hash`),
  INDEX `browser_sessions_identity_id_revoked_at_idx` (`identity_id`, `revoked_at`),
  INDEX `browser_sessions_expires_at_idx` (`expires_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `browser_sessions_identity_id_fkey` FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
