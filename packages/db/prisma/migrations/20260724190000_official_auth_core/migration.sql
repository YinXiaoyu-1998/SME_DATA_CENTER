-- Refuse to remove the unused legacy table if any deployment unexpectedly contains data.
-- A nonempty source attempts to insert 1 into a CHECK-constrained zero-only guard and stops here.
DROP TABLE IF EXISTS `_legacy_access_tokens_empty_guard`;
CREATE TABLE `_legacy_access_tokens_empty_guard` (
  `legacy_access_tokens_must_be_empty_before_official_auth_cutover` TINYINT NOT NULL,
  CONSTRAINT `legacy_access_tokens_must_be_empty_before_official_auth_cutover`
    CHECK (`legacy_access_tokens_must_be_empty_before_official_auth_cutover` = 0)
);
INSERT INTO `_legacy_access_tokens_empty_guard`
  (`legacy_access_tokens_must_be_empty_before_official_auth_cutover`)
SELECT 1 FROM `access_tokens` LIMIT 1;
DROP TABLE `_legacy_access_tokens_empty_guard`;

ALTER TABLE `access_tokens` DROP FOREIGN KEY `access_tokens_org_id_fkey`;
ALTER TABLE `access_tokens` DROP FOREIGN KEY `access_tokens_employee_id_fkey`;
DROP TABLE `access_tokens`;

CREATE TABLE `login_identities` (
  `id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `employee_id` VARCHAR(32) NOT NULL,
  `provider` ENUM('local_password') NOT NULL DEFAULT 'local_password',
  `normalized_email` VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `password_hash` TEXT NULL,
  `disabled` BOOLEAN NOT NULL DEFAULT false,
  `failed_attempt_count` INTEGER NOT NULL DEFAULT 0,
  `cooldown_level` INTEGER NOT NULL DEFAULT 0,
  `cooldown_until` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `login_identities_normalized_email_key` (`normalized_email`),
  INDEX `login_identities_org_id_employee_id_idx` (`org_id`, `employee_id`),
  INDEX `login_identities_employee_id_provider_disabled_idx` (`employee_id`, `provider`, `disabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `password_setup_grants` (
  `id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `purpose` ENUM('initial_setup', 'password_reset') NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `used_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `password_setup_grants_token_hash_key` (`token_hash`),
  INDEX `password_setup_grants_identity_id_purpose_expires_at_idx` (`identity_id`, `purpose`, `expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `password_setup_sessions` (
  `id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `grant_id` VARCHAR(32) NOT NULL,
  `session_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `password_setup_sessions_session_hash_key` (`session_hash`),
  INDEX `password_setup_sessions_identity_id_expires_at_idx` (`identity_id`, `expires_at`),
  INDEX `password_setup_sessions_grant_id_idx` (`grant_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `oauth_authorization_transactions` (
  `id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NULL,
  `transaction_hash` CHAR(64) NOT NULL,
  `client_id` VARCHAR(128) NOT NULL,
  `redirect_uri` VARCHAR(2048) NOT NULL,
  `state` VARCHAR(512) NOT NULL,
  `pkce_challenge` VARCHAR(128) NOT NULL,
  `status` ENUM('pending', 'authenticated', 'completed', 'expired') NOT NULL DEFAULT 'pending',
  `expires_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `oauth_authorization_transactions_transaction_hash_key` (`transaction_hash`),
  INDEX `oauth_authorization_transactions_identity_id_status_idx` (`identity_id`, `status`),
  INDEX `oauth_authorization_transactions_expires_at_idx` (`expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `oauth_authorization_codes` (
  `id` VARCHAR(32) NOT NULL,
  `transaction_id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `employee_id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `code_hash` CHAR(64) NOT NULL,
  `client_id` VARCHAR(128) NOT NULL,
  `redirect_uri` VARCHAR(2048) NOT NULL,
  `pkce_challenge` VARCHAR(128) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `redeemed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `oauth_authorization_codes_code_hash_key` (`code_hash`),
  INDEX `oauth_authorization_codes_transaction_id_idx` (`transaction_id`),
  INDEX `oauth_authorization_codes_identity_id_expires_at_idx` (`identity_id`, `expires_at`),
  INDEX `oauth_authorization_codes_org_id_employee_id_idx` (`org_id`, `employee_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `auth_sessions` (
  `id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `employee_id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `status` ENUM('active', 'revoked', 'expired') NOT NULL DEFAULT 'active',
  `absolute_expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `revocation_reason` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  INDEX `auth_sessions_identity_id_status_idx` (`identity_id`, `status`),
  INDEX `auth_sessions_org_id_employee_id_status_idx` (`org_id`, `employee_id`, `status`),
  INDEX `auth_sessions_absolute_expires_at_idx` (`absolute_expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `durable_credentials` (
  `id` VARCHAR(32) NOT NULL,
  `session_id` VARCHAR(32) NOT NULL,
  `credential_hash` CHAR(64) NOT NULL,
  `generation` INTEGER NOT NULL,
  `status` ENUM('active', 'consumed', 'revoked') NOT NULL DEFAULT 'active',
  `consumed_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `durable_credentials_credential_hash_key` (`credential_hash`),
  INDEX `durable_credentials_session_id_status_idx` (`session_id`, `status`),
  UNIQUE INDEX `durable_credentials_session_id_generation_key` (`session_id`, `generation`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `oauth_access_tokens` (
  `id` VARCHAR(32) NOT NULL,
  `session_id` VARCHAR(32) NOT NULL,
  `identity_id` VARCHAR(32) NOT NULL,
  `employee_id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `last_used_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `oauth_access_tokens_token_hash_key` (`token_hash`),
  INDEX `oauth_access_tokens_session_id_expires_at_idx` (`session_id`, `expires_at`),
  INDEX `oauth_access_tokens_identity_id_expires_at_idx` (`identity_id`, `expires_at`),
  INDEX `oauth_access_tokens_org_id_employee_id_idx` (`org_id`, `employee_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `auth_security_events` (
  `id` VARCHAR(32) NOT NULL,
  `event_type` VARCHAR(128) NOT NULL,
  `outcome` ENUM('succeeded', 'failed', 'denied') NOT NULL,
  `reason` VARCHAR(255) NULL,
  `request_id` VARCHAR(128) NULL,
  `source_ip` VARCHAR(128) NULL,
  `launcher_version` VARCHAR(64) NULL,
  `org_id` VARCHAR(64) NULL,
  `identity_id` VARCHAR(32) NULL,
  `employee_id` VARCHAR(32) NULL,
  `session_id` VARCHAR(32) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `auth_security_events_created_at_idx` (`created_at`),
  INDEX `auth_security_events_org_id_created_at_idx` (`org_id`, `created_at`),
  INDEX `auth_security_events_identity_id_created_at_idx` (`identity_id`, `created_at`),
  INDEX `auth_security_events_session_id_created_at_idx` (`session_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `login_identities`
  ADD CONSTRAINT `login_identities_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `login_identities_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `password_setup_grants`
  ADD CONSTRAINT `password_setup_grants_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `password_setup_sessions`
  ADD CONSTRAINT `password_setup_sessions_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `password_setup_sessions_grant_id_fkey`
  FOREIGN KEY (`grant_id`) REFERENCES `password_setup_grants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `oauth_authorization_transactions`
  ADD CONSTRAINT `oauth_authorization_transactions_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `oauth_authorization_codes`
  ADD CONSTRAINT `oauth_authorization_codes_transaction_id_fkey`
  FOREIGN KEY (`transaction_id`) REFERENCES `oauth_authorization_transactions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_authorization_codes_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_authorization_codes_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_authorization_codes_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `auth_sessions`
  ADD CONSTRAINT `auth_sessions_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `auth_sessions_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `auth_sessions_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `durable_credentials`
  ADD CONSTRAINT `durable_credentials_session_id_fkey`
  FOREIGN KEY (`session_id`) REFERENCES `auth_sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `oauth_access_tokens`
  ADD CONSTRAINT `oauth_access_tokens_session_id_fkey`
  FOREIGN KEY (`session_id`) REFERENCES `auth_sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_access_tokens_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_access_tokens_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `oauth_access_tokens_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `auth_security_events`
  ADD CONSTRAINT `auth_security_events_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `auth_security_events_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `auth_security_events_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `auth_security_events_session_id_fkey`
  FOREIGN KEY (`session_id`) REFERENCES `auth_sessions` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
