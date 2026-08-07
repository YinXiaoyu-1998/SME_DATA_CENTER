CREATE TABLE `device_authorizations` (
  `id` VARCHAR(32) NOT NULL,
  `client_id` VARCHAR(128) NOT NULL,
  `device_code_hash` CHAR(64) NOT NULL,
  `user_code_hash` CHAR(64) NOT NULL,
  `status` ENUM('pending', 'completed', 'expired', 'revoked') NOT NULL DEFAULT 'pending',
  `instance_name` VARCHAR(128) NOT NULL,
  `instance_hostname` VARCHAR(255) NOT NULL,
  `identity_id` VARCHAR(32) NULL,
  `employee_id` VARCHAR(32) NULL,
  `org_id` VARCHAR(64) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  `redeemed_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `device_authorizations_device_code_hash_key` (`device_code_hash`),
  UNIQUE INDEX `device_authorizations_user_code_hash_key` (`user_code_hash`),
  INDEX `device_authorizations_instance_status_idx` (`client_id`, `instance_name`, `instance_hostname`, `status`),
  INDEX `device_authorizations_identity_id_status_idx` (`identity_id`, `status`),
  INDEX `device_authorizations_expires_at_idx` (`expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `device_authorizations`
  ADD CONSTRAINT `device_authorizations_identity_id_fkey`
  FOREIGN KEY (`identity_id`) REFERENCES `login_identities` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `device_authorizations_employee_id_fkey`
  FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `device_authorizations_org_id_fkey`
  FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
