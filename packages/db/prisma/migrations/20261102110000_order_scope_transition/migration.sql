ALTER TABLE `structured_partitions` ADD COLUMN `version` INTEGER UNSIGNED NOT NULL DEFAULT 1;
CREATE TABLE `order_scope_transition_previews` (
  `id` VARCHAR(32) NOT NULL,
  `org_id` VARCHAR(64) NOT NULL,
  `actor_id` VARCHAR(32) NOT NULL,
  `enterprise_key` VARCHAR(191) NOT NULL,
  `enterprise_name` VARCHAR(255) NOT NULL,
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `store_names` JSON NOT NULL,
  `order_scope` ENUM('settled_only', 'all_statuses', 'legacy_unknown') NOT NULL,
  `source_checksum_sha256` CHAR(64) NOT NULL,
  `snapshot` JSON NOT NULL,
  `confirmation_digest` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `job_id` VARCHAR(32) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `order_scope_transition_previews_job_id_key` (`job_id`),
  INDEX `order_scope_transition_previews_org_id_expires_at_idx` (`org_id`, `expires_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
