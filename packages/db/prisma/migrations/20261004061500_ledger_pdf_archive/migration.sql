-- DropIndex
DROP INDEX `processing_runs_status_available_at_locked_until_idx` ON `processing_runs`;

-- AlterTable
ALTER TABLE `processing_runs` ADD COLUMN `ledger_artifact_request_id` VARCHAR(32) NULL,
    ADD COLUMN `ledger_artifact_request_item_id` VARCHAR(32) NULL,
    ADD COLUMN `ledger_pdf_reconciliation_run_id` VARCHAR(32) NULL,
    ADD COLUMN `priority` INTEGER NOT NULL DEFAULT 0,
    MODIFY `job_type` ENUM('evidence_document_index', 'structured_import', 'structured_partition_import', 'ledger_pdf_generate', 'ledger_pdf_bundle', 'ledger_pdf_reconcile') NOT NULL;

-- CreateTable
CREATE TABLE `ledger_pdf_partitions` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `store_name` VARCHAR(512) NOT NULL,
    `store_name_hash` CHAR(64) NOT NULL,
    `purchase_date` DATE NOT NULL,
    `data_revision` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `requested_generation` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `published_generation` INTEGER UNSIGNED NULL,
    `published_data_revision` INTEGER UNSIGNED NULL,
    `published_source_fingerprint` CHAR(64) NULL,
    `current_object_key` VARCHAR(1024) NULL,
    `checksum_sha256` CHAR(64) NULL,
    `byte_size` BIGINT UNSIGNED NULL,
    `row_count` INTEGER UNSIGNED NULL,
    `certificate_count` INTEGER UNSIGNED NULL,
    `confidentiality_level` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `template_version` VARCHAR(128) NULL,
    `generated_at` DATETIME(3) NULL,
    `error_code` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ledger_pdf_partitions_org_id_purchase_date_idx`(`org_id`, `purchase_date`),
    UNIQUE INDEX `ledger_pdf_partitions_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `ledger_pdf_partition_key_uq`(`org_id`, `store_name_hash`, `purchase_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_artifact_requests` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `kind` ENUM('refresh', 'download') NOT NULL,
    `actor_kind` ENUM('employee', 'operator', 'system_reconciler') NOT NULL,
    `actor_employee_id` VARCHAR(32) NULL,
    `actor_label` VARCHAR(255) NULL,
    `reconciliation_run_id` VARCHAR(32) NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `request_fingerprint` CHAR(64) NOT NULL,
    `scope` JSON NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'partial_failed', 'failed') NOT NULL DEFAULT 'queued',
    `zip_object_key` VARCHAR(1024) NULL,
    `zip_expires_at` DATETIME(3) NULL,
    `retry_of_request_id` VARCHAR(32) NULL,
    `error_code` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ledger_artifact_requests_org_id_status_created_at_idx`(`org_id`, `status`, `created_at`),
    UNIQUE INDEX `ledger_artifact_requests_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `ledger_artifact_request_idempotency_uq`(`org_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_artifact_request_items` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `request_id` VARCHAR(32) NOT NULL,
    `partition_id` VARCHAR(32) NOT NULL,
    `generation` INTEGER UNSIGNED NOT NULL,
    `data_revision` INTEGER UNSIGNED NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'empty', 'superseded', 'failed') NOT NULL DEFAULT 'queued',
    `error_code` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ledger_artifact_request_items_org_id_partition_id_generation_idx`(`org_id`, `partition_id`, `generation`),
    INDEX `ledger_artifact_request_items_org_id_request_id_status_idx`(`org_id`, `request_id`, `status`),
    UNIQUE INDEX `ledger_artifact_request_items_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `ledger_artifact_request_items_request_id_partition_id_key`(`request_id`, `partition_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_pdf_sources` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `partition_id` VARCHAR(32) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `kind` ENUM('ledger', 'supplier', 'certificate') NOT NULL,
    `confidentiality_level` TINYINT UNSIGNED NOT NULL,
    `checksum_sha256` CHAR(64) NOT NULL,

    INDEX `ledger_pdf_sources_org_id_source_document_id_idx`(`org_id`, `source_document_id`),
    UNIQUE INDEX `ledger_pdf_sources_partition_id_source_document_id_kind_key`(`partition_id`, `source_document_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_pdf_reconciliation_runs` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `schedule_date` DATE NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'partial_failed', 'failed') NOT NULL DEFAULT 'queued',
    `phase` VARCHAR(32) NOT NULL DEFAULT 'facts',
    `cursor` JSON NULL,
    `scanned_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `healthy_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `abnormal_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `submitted_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `inflight_skipped_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `failed_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `error_code` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ledger_pdf_reconciliation_runs_org_id_status_idx`(`org_id`, `status`),
    UNIQUE INDEX `ledger_pdf_reconciliation_runs_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `ledger_reconciliation_schedule_uq`(`org_id`, `schedule_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `employees_org_id_id_key` ON `employees`(`org_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `documents_org_id_id_key` ON `documents`(`org_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_runs_ledger_artifact_request_item_id_key` ON `processing_runs`(`ledger_artifact_request_item_id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_runs_ledger_artifact_request_id_key` ON `processing_runs`(`ledger_artifact_request_id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_runs_ledger_pdf_reconciliation_run_id_key` ON `processing_runs`(`ledger_pdf_reconciliation_run_id`);

-- CreateIndex
CREATE INDEX `processing_runs_status_priority_available_at_locked_until_idx` ON `processing_runs`(`status`, `priority`, `available_at`, `locked_until`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_run_ledger_item_uq` ON `processing_runs`(`org_id`, `ledger_artifact_request_item_id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_run_ledger_request_uq` ON `processing_runs`(`org_id`, `ledger_artifact_request_id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_run_ledger_reconcile_uq` ON `processing_runs`(`org_id`, `ledger_pdf_reconciliation_run_id`);

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_org_id_ledger_artifact_request_item_id_fkey` FOREIGN KEY (`org_id`, `ledger_artifact_request_item_id`) REFERENCES `ledger_artifact_request_items`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_org_id_ledger_artifact_request_id_fkey` FOREIGN KEY (`org_id`, `ledger_artifact_request_id`) REFERENCES `ledger_artifact_requests`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_org_id_ledger_pdf_reconciliation_run_id_fkey` FOREIGN KEY (`org_id`, `ledger_pdf_reconciliation_run_id`) REFERENCES `ledger_pdf_reconciliation_runs`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_pdf_partitions` ADD CONSTRAINT `ledger_pdf_partitions_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_requests` ADD CONSTRAINT `ledger_artifact_requests_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_requests` ADD CONSTRAINT `ledger_artifact_requests_org_id_actor_employee_id_fkey` FOREIGN KEY (`org_id`, `actor_employee_id`) REFERENCES `employees`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_requests` ADD CONSTRAINT `ledger_artifact_requests_org_id_reconciliation_run_id_fkey` FOREIGN KEY (`org_id`, `reconciliation_run_id`) REFERENCES `ledger_pdf_reconciliation_runs`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_requests` ADD CONSTRAINT `ledger_artifact_requests_org_id_retry_of_request_id_fkey` FOREIGN KEY (`org_id`, `retry_of_request_id`) REFERENCES `ledger_artifact_requests`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_request_items` ADD CONSTRAINT `ledger_artifact_request_items_org_id_request_id_fkey` FOREIGN KEY (`org_id`, `request_id`) REFERENCES `ledger_artifact_requests`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_artifact_request_items` ADD CONSTRAINT `ledger_artifact_request_items_org_id_partition_id_fkey` FOREIGN KEY (`org_id`, `partition_id`) REFERENCES `ledger_pdf_partitions`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_pdf_sources` ADD CONSTRAINT `ledger_pdf_sources_org_id_partition_id_fkey` FOREIGN KEY (`org_id`, `partition_id`) REFERENCES `ledger_pdf_partitions`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_pdf_sources` ADD CONSTRAINT `ledger_pdf_sources_org_id_source_document_id_fkey` FOREIGN KEY (`org_id`, `source_document_id`) REFERENCES `documents`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_pdf_reconciliation_runs` ADD CONSTRAINT `ledger_pdf_reconciliation_runs_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
