-- Hard cut over the QA-only business/dishes datasets. No row data or source
-- workbook is retained or copied into the partition catalog.
CREATE TEMPORARY TABLE `_partition_cutover_documents` (
    `id` VARCHAR(32) NOT NULL PRIMARY KEY
) ENGINE=MEMORY DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_partition_cutover_documents` (`id`)
SELECT `source_document_id`
FROM `import_batches`
WHERE `dataset` IN ('business', 'dishes');

DELETE `processing_runs`
FROM `processing_runs`
INNER JOIN `_partition_cutover_documents` AS `cutover`
    ON `cutover`.`id` = `processing_runs`.`document_id`;

DELETE `import_window_claims`
FROM `import_window_claims`
INNER JOIN `import_batches`
    ON `import_batches`.`id` = `import_window_claims`.`import_batch_id`
WHERE `import_batches`.`dataset` IN ('business', 'dishes');

DROP TABLE `dish_rows`;
DROP TABLE `business_rows`;

DELETE FROM `import_batches`
WHERE `dataset` IN ('business', 'dishes');

DELETE `documents`
FROM `documents`
INNER JOIN `_partition_cutover_documents` AS `cutover`
    ON `cutover`.`id` = `documents`.`id`;

DROP TEMPORARY TABLE `_partition_cutover_documents`;

CREATE TABLE `partition_import_jobs` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `uploader_employee_id` VARCHAR(32) NOT NULL,
    `dataset` ENUM('dishes', 'business') NOT NULL,
    `enterprise_key` VARCHAR(191) NOT NULL,
    `enterprise_name` VARCHAR(255) NOT NULL,
    `confidentiality_level` TINYINT UNSIGNED NOT NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `request_fingerprint` VARCHAR(64) NOT NULL,
    `original_file_name` VARCHAR(512) NOT NULL,
    `media_type` VARCHAR(255) NOT NULL,
    `source_byte_size` BIGINT NOT NULL,
    `source_checksum_sha256` VARCHAR(64) NOT NULL,
    `source_start_date` DATE NOT NULL,
    `source_end_date` DATE NOT NULL,
    `temporary_object_key` VARCHAR(512) NULL,
    `multipart_upload_id` VARCHAR(512) NULL,
    `status` ENUM('uploading', 'queued', 'processing', 'published', 'rejected', 'failed', 'cancelled', 'expired') NOT NULL DEFAULT 'uploading',
    `total_row_count` BIGINT NOT NULL DEFAULT 0,
    `partition_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(128) NULL,
    `error_summary` TEXT NULL,
    `validation_errors` JSON NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `published_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `partition_import_jobs_org_id_idempotency_key_key` (`org_id`, `idempotency_key`),
    INDEX `partition_import_jobs_status_expires_at_idx` (`status`, `expires_at`),
    INDEX `partition_import_jobs_org_id_uploader_employee_id_created_at_idx` (`org_id`, `uploader_employee_id`, `created_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `partition_import_jobs_confidentiality_level_range` CHECK (`confidentiality_level` BETWEEN 0 AND 3)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `structured_partitions` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(191) NOT NULL,
    `enterprise_name` VARCHAR(255) NOT NULL,
    `dataset` ENUM('dishes', 'business') NOT NULL,
    `store_key` VARCHAR(255) NOT NULL,
    `merchant_id` VARCHAR(255) NULL,
    `store_name` VARCHAR(255) NOT NULL,
    `business_date` DATE NOT NULL,
    `object_key` VARCHAR(512) NOT NULL,
    `row_count` BIGINT NOT NULL,
    `byte_size` BIGINT NOT NULL,
    `checksum_sha256` VARCHAR(64) NOT NULL,
    `confidentiality_level` TINYINT UNSIGNED NOT NULL,
    `published_by_job_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `structured_partitions_object_key_key` (`object_key`),
    UNIQUE INDEX `structured_partitions_identity_uq` (`org_id`, `enterprise_key`, `dataset`, `store_key`, `business_date`),
    INDEX `structured_partitions_manifest_idx` (`org_id`, `dataset`, `enterprise_key`, `business_date`),
    INDEX `structured_partitions_auth_idx` (`org_id`, `confidentiality_level`, `dataset`, `business_date`),
    PRIMARY KEY (`id`),
    CONSTRAINT `structured_partitions_confidentiality_level_range` CHECK (`confidentiality_level` BETWEEN 0 AND 3)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `storage_garbage` (
    `id` VARCHAR(32) NOT NULL,
    `object_key` VARCHAR(512) NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_error_code` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `storage_garbage_object_key_key` (`object_key`),
    INDEX `storage_garbage_available_at_idx` (`available_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `processing_runs`
    DROP FOREIGN KEY `processing_runs_document_id_fkey`,
    MODIFY `document_id` VARCHAR(32) NULL,
    MODIFY `job_type` ENUM('evidence_document_index', 'structured_import', 'structured_partition_import') NOT NULL,
    ADD COLUMN `partition_import_job_id` VARCHAR(32) NULL,
    ADD UNIQUE INDEX `processing_runs_partition_import_job_id_key` (`partition_import_job_id`);

ALTER TABLE `processing_runs`
    ADD CONSTRAINT `processing_runs_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `processing_runs_partition_import_job_id_fkey` FOREIGN KEY (`partition_import_job_id`) REFERENCES `partition_import_jobs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `partition_import_jobs`
    ADD CONSTRAINT `partition_import_jobs_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `partition_import_jobs_uploader_employee_id_fkey` FOREIGN KEY (`uploader_employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `structured_partitions`
    ADD CONSTRAINT `structured_partitions_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
