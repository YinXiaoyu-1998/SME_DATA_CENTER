ALTER TABLE `workflow_migrations`
  ADD COLUMN `target_versions` JSON NOT NULL,
  ADD COLUMN `sealed_at` DATETIME(3) NULL,
  ADD COLUMN `chunk_count` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `record_count` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `chunks_digest` CHAR(64) NULL,
  ADD COLUMN `imported_chunks` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `validated_chunks` INT UNSIGNED NOT NULL DEFAULT 0;
CREATE TABLE `workflow_migration_chunks` (
  `org_id` VARCHAR(64) NOT NULL,
  `migration_id` VARCHAR(64) NOT NULL,
  `sequence` INT UNSIGNED NOT NULL,
  `payload` JSON NOT NULL,
  `digest` CHAR(64) NOT NULL,
  `record_count` INT UNSIGNED NOT NULL,
  `imported_at` DATETIME(3) NULL,
  PRIMARY KEY (`org_id`, `migration_id`, `sequence`),
  CONSTRAINT `workflow_migration_chunks_migration_fkey` FOREIGN KEY (`migration_id`) REFERENCES `workflow_migrations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
