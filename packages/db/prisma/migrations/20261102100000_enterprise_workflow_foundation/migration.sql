-- AlterTable
ALTER TABLE `partition_import_jobs` ADD COLUMN `order_scope` ENUM('settled_only', 'all_statuses', 'legacy_unknown') NULL;

-- AlterTable
ALTER TABLE `structured_partitions` ADD COLUMN `order_scope` ENUM('settled_only', 'all_statuses', 'legacy_unknown') NULL;

-- CreateTable
CREATE TABLE `enterprise_integrations` (
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `schema_version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `configuration` JSON NOT NULL,
    `order_scope_required` BOOLEAN NOT NULL DEFAULT false,
    `updated_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`org_id`, `enterprise_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `enterprise_workflows` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `type` ENUM('meituan-daily-ingestion', 'meituan-review-operations', 'weekly-business-report') NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `control_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `control_state` ENUM('active', 'paused', 'revoked') NOT NULL DEFAULT 'paused',
    `assignment_epoch` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `assigned_installation_id` VARCHAR(64) NULL,
    `lease_run_id` VARCHAR(64) NULL,
    `lease_expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `enterprise_workflows_org_id_id_key`(`org_id`, `id`),
    UNIQUE INDEX `uq_enterprise_workflow_type`(`org_id`, `enterprise_key`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_configuration_versions` (
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL,
    `schema_version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `configuration` JSON NOT NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`org_id`, `workflow_id`, `version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_change_previews` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `workflow_type` ENUM('meituan-daily-ingestion', 'meituan-review-operations', 'weekly-business-report') NOT NULL,
    `expected_version` INTEGER UNSIGNED NOT NULL,
    `expected_integration_version` INTEGER UNSIGNED NOT NULL,
    `expected_control_version` INTEGER UNSIGNED NOT NULL,
    `change` JSON NOT NULL,
    `confirmation_digest` CHAR(64) NOT NULL,
    `prepared_by` VARCHAR(32) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `workflow_change_previews_org_id_enterprise_key_expires_at_idx`(`org_id`, `enterprise_key`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_authorizations` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `scope` JSON NOT NULL,
    `configuration_version` INTEGER UNSIGNED NOT NULL,
    `control_version` INTEGER UNSIGNED NOT NULL,
    `granted_by` VARCHAR(32) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_by` VARCHAR(32) NULL,
    `revoked_at` DATETIME(3) NULL,

    INDEX `workflow_authorizations_org_id_workflow_id_revoked_at_idx`(`org_id`, `workflow_id`, `revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_installations` (
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `installation_id` VARCHAR(64) NOT NULL,
    `employee_id` VARCHAR(32) NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `device_alias` VARCHAR(255) NOT NULL,
    `host` VARCHAR(32) NOT NULL,
    `platform` VARCHAR(32) NOT NULL,
    `launcher_version` VARCHAR(64) NOT NULL,
    `workflow_package_version` VARCHAR(64) NOT NULL,
    `state` ENUM('not_installed', 'pending', 'paused', 'enabled', 'revoked') NOT NULL DEFAULT 'pending',
    `host_snapshot` JSON NULL,
    `readiness_checks` JSON NULL,
    `first_run_verification` VARCHAR(32) NOT NULL DEFAULT 'not_run',
    `last_checked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`org_id`, `workflow_id`, `installation_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_runs` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `installation_id` VARCHAR(64) NOT NULL,
    `employee_id` VARCHAR(32) NOT NULL,
    `configuration_version` INTEGER UNSIGNED NOT NULL,
    `integration_version` INTEGER UNSIGNED NOT NULL,
    `control_version` INTEGER UNSIGNED NOT NULL,
    `assignment_epoch` INTEGER UNSIGNED NOT NULL,
    `workflow_package_version` VARCHAR(64) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `mode` VARCHAR(32) NOT NULL,
    `snapshot` JSON NOT NULL,
    `phase` VARCHAR(32) NOT NULL DEFAULT 'preparing',
    `status` ENUM('running', 'succeeded', 'partial', 'needs_attention', 'failed', 'unknown') NOT NULL DEFAULT 'running',
    `summary` JSON NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `renewed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `retain_until` DATETIME(3) NOT NULL,

    INDEX `workflow_runs_org_id_workflow_id_started_at_idx`(`org_id`, `workflow_id`, `started_at`),
    INDEX `workflow_runs_retain_until_status_idx`(`retain_until`, `status`),
    UNIQUE INDEX `workflow_runs_org_id_workflow_id_id_key`(`org_id`, `workflow_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_actions` (
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `action_id` VARCHAR(64) NOT NULL,
    `run_id` VARCHAR(64) NOT NULL,
    `idempotency_key` CHAR(64) NOT NULL,
    `identity` JSON NOT NULL,
    `artifact_hash` CHAR(64) NULL,
    `correlation_marker` VARCHAR(64) NULL,
    `state` ENUM('intent', 'confirmed', 'failed', 'unknown') NOT NULL DEFAULT 'intent',
    `receipt` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `confirmed_at` DATETIME(3) NULL,

    INDEX `workflow_actions_org_id_workflow_id_state_idx`(`org_id`, `workflow_id`, `state`),
    UNIQUE INDEX `uq_workflow_action_dedup`(`org_id`, `workflow_id`, `idempotency_key`),
    PRIMARY KEY (`org_id`, `workflow_id`, `action_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_migrations` (
    `id` VARCHAR(64) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `source_snapshot_hash` CHAR(64) NOT NULL,
    `target_version` INTEGER UNSIGNED NOT NULL,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `stage` ENUM('preview', 'validated', 'imported', 'host_switched', 'verified') NOT NULL DEFAULT 'preview',
    `manifest` JSON NOT NULL,
    `confirmation_digest` CHAR(64) NOT NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_workflow_migration_source_target`(`org_id`, `enterprise_key`, `source_snapshot_hash`, `target_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_action_deduplication` (
    `org_id` VARCHAR(64) NOT NULL,
    `workflow_id` VARCHAR(64) NOT NULL,
    `key` CHAR(64) NOT NULL,
    `action_id` VARCHAR(64) NOT NULL,

    INDEX `workflow_action_deduplication_org_id_workflow_id_action_id_idx`(`org_id`, `workflow_id`, `action_id`),
    PRIMARY KEY (`org_id`, `workflow_id`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `enterprise_integrations` ADD CONSTRAINT `enterprise_integrations_org_id_enterprise_key_fkey` FOREIGN KEY (`org_id`, `enterprise_key`) REFERENCES `business_enterprise_identities`(`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `enterprise_workflows` ADD CONSTRAINT `enterprise_workflows_org_id_enterprise_key_fkey` FOREIGN KEY (`org_id`, `enterprise_key`) REFERENCES `enterprise_integrations`(`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_configuration_versions` ADD CONSTRAINT `workflow_configuration_versions_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_change_previews` ADD CONSTRAINT `workflow_change_previews_org_id_enterprise_key_fkey` FOREIGN KEY (`org_id`, `enterprise_key`) REFERENCES `enterprise_integrations`(`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_authorizations` ADD CONSTRAINT `workflow_authorizations_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_installations` ADD CONSTRAINT `workflow_installations_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_runs` ADD CONSTRAINT `workflow_runs_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_actions` ADD CONSTRAINT `workflow_actions_org_id_workflow_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`) REFERENCES `enterprise_workflows`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_migrations` ADD CONSTRAINT `workflow_migrations_org_id_enterprise_key_fkey` FOREIGN KEY (`org_id`, `enterprise_key`) REFERENCES `enterprise_integrations`(`org_id`, `enterprise_key`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workflow_action_deduplication` ADD CONSTRAINT `workflow_action_deduplication_org_id_workflow_id_action_id_fkey` FOREIGN KEY (`org_id`, `workflow_id`, `action_id`) REFERENCES `workflow_actions`(`org_id`, `workflow_id`, `action_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Existing content does not prove a source query scope. Other datasets remain NULL.
UPDATE `partition_import_jobs` SET `order_scope` = 'legacy_unknown' WHERE `dataset` = 'in_store_orders';
UPDATE `structured_partitions` SET `order_scope` = 'legacy_unknown' WHERE `dataset` = 'in_store_orders';
