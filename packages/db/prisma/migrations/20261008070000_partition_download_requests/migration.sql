-- AlterTable
ALTER TABLE `processing_runs` ADD COLUMN `partition_download_request_id` VARCHAR(32) NULL,
    MODIFY `job_type` ENUM('evidence_document_index', 'structured_import', 'structured_partition_import', 'structured_partition_bundle', 'ledger_pdf_generate', 'ledger_pdf_bundle', 'ledger_pdf_reconcile') NOT NULL;

-- CreateTable
CREATE TABLE `partition_download_requests` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `requester_id` VARCHAR(32) NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_fingerprint` CHAR(64) NOT NULL,
    `scope` JSON NOT NULL,
    `manifest` JSON NOT NULL,
    `manifest_fingerprint` CHAR(64) NOT NULL,
    `limits` JSON NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'failed', 'expired') NOT NULL DEFAULT 'queued',
    `partition_count` INTEGER UNSIGNED NOT NULL,
    `completed_partition_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `total_row_count` BIGINT UNSIGNED NOT NULL,
    `total_byte_size` BIGINT UNSIGNED NOT NULL,
    `object_key` VARCHAR(1024) NULL,
    `byte_size` BIGINT UNSIGNED NULL,
    `checksum_sha256` CHAR(64) NULL,
    `error_code` VARCHAR(128) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `partition_download_requests_org_id_status_requester_id_idx`(`org_id`, `status`, `requester_id`),
    INDEX `partition_download_requests_status_expires_at_idx`(`status`, `expires_at`),
    UNIQUE INDEX `partition_download_requests_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `partition_download_idempotency_uq`(`org_id`, `requester_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `processing_runs_partition_download_request_id_key` ON `processing_runs`(`partition_download_request_id`);

-- CreateIndex
CREATE UNIQUE INDEX `processing_run_partition_download_uq` ON `processing_runs`(`org_id`, `partition_download_request_id`);

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_org_id_partition_download_request_id_fkey` FOREIGN KEY (`org_id`, `partition_download_request_id`) REFERENCES `partition_download_requests`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partition_download_requests` ADD CONSTRAINT `partition_download_requests_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partition_download_requests` ADD CONSTRAINT `partition_download_requests_org_id_requester_id_fkey` FOREIGN KEY (`org_id`, `requester_id`) REFERENCES `employees`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Idempotency tokens are opaque and case-sensitive.
ALTER TABLE `partition_download_requests` MODIFY `idempotency_key` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
