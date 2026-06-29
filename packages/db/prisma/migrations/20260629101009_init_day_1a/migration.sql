-- CreateTable
CREATE TABLE `organizations` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `role` ENUM('admin', 'manager', 'employee') NOT NULL DEFAULT 'employee',
    `disabled` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_email_key`(`email`),
    INDEX `employees_org_id_idx`(`org_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `labels` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `type` ENUM('all_staff', 'store', 'personal') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `labels_org_id_type_idx`(`org_id`, `type`),
    UNIQUE INDEX `labels_org_id_key_key`(`org_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_labels` (
    `employee_id` VARCHAR(32) NOT NULL,
    `label_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_labels_label_id_idx`(`label_id`),
    PRIMARY KEY (`employee_id`, `label_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `documents` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(512) NOT NULL,
    `document_type` ENUM('raw_material', 'structured_dataset', 'analysis_artifact', 'business_event', 'management_knowledge') NOT NULL,
    `status` ENUM('uploading', 'pending_processing', 'processing', 'active', 'processing_failed', 'archived') NOT NULL DEFAULT 'uploading',
    `storage_object_key` VARCHAR(1024) NOT NULL,
    `original_file_name` VARCHAR(512) NULL,
    `content_type` VARCHAR(255) NULL,
    `byte_size` BIGINT NULL,
    `checksum_sha256` VARCHAR(64) NULL,
    `uploader_employee_id` VARCHAR(32) NOT NULL,
    `source_system` VARCHAR(255) NULL,
    `source_time` DATETIME(3) NULL,
    `source_metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `archived_at` DATETIME(3) NULL,

    INDEX `documents_org_id_status_idx`(`org_id`, `status`),
    INDEX `documents_org_id_document_type_idx`(`org_id`, `document_type`),
    INDEX `documents_uploader_employee_id_idx`(`uploader_employee_id`),
    INDEX `documents_source_time_idx`(`source_time`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_labels` (
    `document_id` VARCHAR(32) NOT NULL,
    `label_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_labels_label_id_idx`(`label_id`),
    PRIMARY KEY (`document_id`, `label_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `processing_runs` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `document_id` VARCHAR(32) NOT NULL,
    `status` ENUM('queued', 'running', 'succeeded', 'failed', 'retry_scheduled') NOT NULL DEFAULT 'queued',
    `attempt_number` INTEGER NOT NULL DEFAULT 1,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(128) NULL,
    `error_summary` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `processing_runs_org_id_status_idx`(`org_id`, `status`),
    INDEX `processing_runs_document_id_idx`(`document_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_chunks` (
    `id` VARCHAR(32) NOT NULL,
    `document_id` VARCHAR(32) NOT NULL,
    `chunk_index` INTEGER NOT NULL,
    `chunk_text` TEXT NOT NULL,
    `chunk_hash` VARCHAR(64) NOT NULL,
    `index_type` VARCHAR(64) NOT NULL DEFAULT 'text',
    `model_name` VARCHAR(128) NULL,
    `model_version` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_chunks_document_id_chunk_index_idx`(`document_id`, `chunk_index`),
    UNIQUE INDEX `document_chunks_document_id_chunk_hash_index_type_key`(`document_id`, `chunk_hash`, `index_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `actor_employee_id` VARCHAR(32) NULL,
    `action` VARCHAR(128) NOT NULL,
    `target_type` VARCHAR(128) NOT NULL,
    `target_id` VARCHAR(128) NULL,
    `result` VARCHAR(64) NOT NULL DEFAULT 'succeeded',
    `metadata` JSON NULL,
    `request_id` VARCHAR(128) NULL,
    `client_ip` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_org_id_created_at_idx`(`org_id`, `created_at`),
    INDEX `audit_logs_actor_employee_id_idx`(`actor_employee_id`),
    INDEX `audit_logs_target_type_target_id_idx`(`target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `skill_entries` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `version` VARCHAR(64) NOT NULL,
    `category` VARCHAR(128) NOT NULL,
    `input_requirements` JSON NOT NULL,
    `install_instructions` TEXT NOT NULL,
    `example_prompts` JSON NOT NULL,
    `status` ENUM('approved', 'disabled') NOT NULL DEFAULT 'approved',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `skill_entries_org_id_status_idx`(`org_id`, `status`),
    UNIQUE INDEX `skill_entries_org_id_name_version_key`(`org_id`, `name`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `access_tokens` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `employee_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `last_used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `access_tokens_token_hash_key`(`token_hash`),
    INDEX `access_tokens_org_id_employee_id_idx`(`org_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `labels` ADD CONSTRAINT `labels_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_labels` ADD CONSTRAINT `employee_labels_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_labels` ADD CONSTRAINT `employee_labels_label_id_fkey` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_uploader_employee_id_fkey` FOREIGN KEY (`uploader_employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_labels` ADD CONSTRAINT `document_labels_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_labels` ADD CONSTRAINT `document_labels_label_id_fkey` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `processing_runs` ADD CONSTRAINT `processing_runs_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_chunks` ADD CONSTRAINT `document_chunks_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_employee_id_fkey` FOREIGN KEY (`actor_employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `skill_entries` ADD CONSTRAINT `skill_entries_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
