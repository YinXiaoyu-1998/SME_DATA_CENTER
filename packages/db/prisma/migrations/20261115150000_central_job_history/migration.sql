-- CreateTable
CREATE TABLE `job_history` (
    `org_id` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `job_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `workflow_id` VARCHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL,
    `idempotency_hash` CHAR(64) NULL,
    `summary` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `finished_at` DATETIME(3) NOT NULL,

    INDEX `ix_job_history_owner`(`org_id`, `kind`, `enterprise_key`, `owner_id`, `created_at`, `job_id`),
    INDEX `ix_job_history_workflow`(`org_id`, `kind`, `enterprise_key`, `workflow_id`, `created_at`, `job_id`),
    INDEX `ix_job_history_idempotency`(`org_id`, `kind`, `owner_id`, `idempotency_hash`),
    PRIMARY KEY (`org_id`, `kind`, `job_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_metadata` (
    `org_id` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `job_id` VARCHAR(64) NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `note` VARCHAR(1000) NULL,
    `tags` JSON NOT NULL,

    PRIMARY KEY (`org_id`, `kind`, `job_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_upload_links` (
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `run_id` VARCHAR(64) NOT NULL,
    `action_id` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `job_id` VARCHAR(64) NOT NULL,
    `result` VARCHAR(32) NOT NULL,
    `dataset` VARCHAR(32) NOT NULL,
    `store_names` JSON NOT NULL,
    `store_keys` JSON NOT NULL,
    `receipt_id` VARCHAR(255) NULL,
    `actor_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`org_id`, `workflow_id`, `run_id`, `action_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `job_history` ADD CONSTRAINT `job_history_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_metadata` ADD CONSTRAINT `job_metadata_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_upload_links` ADD CONSTRAINT `workflow_upload_links_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
