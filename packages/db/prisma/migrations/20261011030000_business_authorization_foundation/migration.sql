-- Additive authorization foundation; no existing enterprise is enabled or backfilled.
-- Keep legacy organization/employee/document FK columns on their existing collation.
-- New stable IDs, enterprise keys and store names use binary NO PAD comparison.
-- CreateTable
CREATE TABLE `business_authorization_states` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `mode` ENUM('legacy', 'preparing', 'enabled', 'suspended') NOT NULL DEFAULT 'legacy',
    `version` BIGINT UNSIGNED NOT NULL DEFAULT 0,

    PRIMARY KEY (`org_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_categories` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NULL,
    `name` VARCHAR(255) NOT NULL,
    `kind` ENUM('fixed', 'evidence') NOT NULL,
    `confidentiality_level` TINYINT UNSIGNED NULL,
    `allow_group` BOOLEAN NOT NULL,
    `allow_store` BOOLEAN NOT NULL,
    `retired` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `business_categories_org_id_key_key`(`org_id`, `key`),
    PRIMARY KEY (`org_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_dimensions` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `retired` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`org_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_dimension_values` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `dimension_id` VARCHAR(64) NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `retired` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`org_id`, `dimension_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_category_dimensions` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `category_id` VARCHAR(64) NOT NULL,
    `dimension_id` VARCHAR(64) NOT NULL,

    PRIMARY KEY (`org_id`, `category_id`, `dimension_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_stores` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `retired` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`org_id`, `enterprise_key`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_grants` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `employee_id` VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `ownership` ENUM('group', 'store') NOT NULL,
    `all_stores` BOOLEAN NOT NULL DEFAULT false,

    INDEX `business_grants_org_id_employee_id_idx`(`org_id`, `employee_id`),
    UNIQUE INDEX `business_grant_enterprise_uq`(`org_id`, `id`, `enterprise_key`),
    PRIMARY KEY (`org_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_grant_categories` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `grant_id` VARCHAR(64) NOT NULL,
    `category_id` VARCHAR(64) NOT NULL,

    PRIMARY KEY (`org_id`, `grant_id`, `category_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_grant_stores` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `grant_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `store_name` VARCHAR(255) NOT NULL,

    PRIMARY KEY (`org_id`, `grant_id`, `store_name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_grant_dimensions` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `grant_id` VARCHAR(64) NOT NULL,
    `dimension_id` VARCHAR(64) NOT NULL,
    `all_values` BOOLEAN NOT NULL,

    PRIMARY KEY (`org_id`, `grant_id`, `dimension_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_grant_dimension_values` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `grant_id` VARCHAR(64) NOT NULL,
    `dimension_id` VARCHAR(64) NOT NULL,
    `value_id` VARCHAR(64) NOT NULL,

    PRIMARY KEY (`org_id`, `grant_id`, `dimension_id`, `value_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_resources` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `kind` ENUM('evidence', 'structured', 'quarantine_certificate', 'ledger_pdf', 'source_fragment') NOT NULL,
    `resource_key` VARCHAR(191) NOT NULL,
    `category_id` VARCHAR(64) NOT NULL,
    `valid` BOOLEAN NOT NULL DEFAULT false,
    `file_confidentiality_level` TINYINT UNSIGNED NULL,
    `content_version` BIGINT UNSIGNED NOT NULL DEFAULT 1,
    `authorization_version` BIGINT UNSIGNED NOT NULL DEFAULT 1,
    `document_id` VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,
    `source_document_id` VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,

    INDEX `business_resources_org_id_source_document_id_idx`(`org_id`, `source_document_id`),
    UNIQUE INDEX `business_resource_identity_uq`(`org_id`, `kind`, `resource_key`),
    PRIMARY KEY (`org_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_resource_scopes` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `resource_id` VARCHAR(64) NOT NULL,
    `id` VARCHAR(32) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `ownership` ENUM('group', 'store') NOT NULL,
    `store_name` VARCHAR(255) NULL,

    PRIMARY KEY (`org_id`, `resource_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_scope_dimensions` (
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `resource_id` VARCHAR(64) NOT NULL,
    `scope_id` VARCHAR(32) NOT NULL,
    `dimension_id` VARCHAR(64) NOT NULL,
    `value_id` VARCHAR(64) NOT NULL,

    PRIMARY KEY (`org_id`, `resource_id`, `scope_id`, `dimension_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `business_authorization_audits` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `actor_id` VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `target_id` VARCHAR(255) NOT NULL,
    `before` JSON NOT NULL,
    `after` JSON NOT NULL,
    `outcome` VARCHAR(32) NOT NULL,
    `version` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `business_authorization_audits_org_id_version_idx`(`org_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- AddForeignKey
ALTER TABLE `business_authorization_states` ADD CONSTRAINT `business_authorization_states_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_categories` ADD CONSTRAINT `business_categories_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_dimensions` ADD CONSTRAINT `business_dimensions_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_dimension_values` ADD CONSTRAINT `business_dimension_values_org_id_dimension_id_fkey` FOREIGN KEY (`org_id`, `dimension_id`) REFERENCES `business_dimensions`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_category_dimensions` ADD CONSTRAINT `business_category_dimensions_org_id_category_id_fkey` FOREIGN KEY (`org_id`, `category_id`) REFERENCES `business_categories`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_category_dimensions` ADD CONSTRAINT `business_category_dimensions_org_id_dimension_id_fkey` FOREIGN KEY (`org_id`, `dimension_id`) REFERENCES `business_dimensions`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_stores` ADD CONSTRAINT `business_stores_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grants` ADD CONSTRAINT `business_grants_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grants` ADD CONSTRAINT `business_grants_org_id_employee_id_fkey` FOREIGN KEY (`org_id`, `employee_id`) REFERENCES `employees`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_categories` ADD CONSTRAINT `business_grant_categories_org_id_grant_id_fkey` FOREIGN KEY (`org_id`, `grant_id`) REFERENCES `business_grants`(`org_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_categories` ADD CONSTRAINT `business_grant_categories_org_id_category_id_fkey` FOREIGN KEY (`org_id`, `category_id`) REFERENCES `business_categories`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_stores` ADD CONSTRAINT `business_grant_stores_org_id_grant_id_enterprise_key_fkey` FOREIGN KEY (`org_id`, `grant_id`, `enterprise_key`) REFERENCES `business_grants`(`org_id`, `id`, `enterprise_key`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_stores` ADD CONSTRAINT `business_grant_stores_org_id_enterprise_key_store_name_fkey` FOREIGN KEY (`org_id`, `enterprise_key`, `store_name`) REFERENCES `business_stores`(`org_id`, `enterprise_key`, `name`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_dimensions` ADD CONSTRAINT `business_grant_dimensions_org_id_grant_id_fkey` FOREIGN KEY (`org_id`, `grant_id`) REFERENCES `business_grants`(`org_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_dimensions` ADD CONSTRAINT `business_grant_dimensions_org_id_dimension_id_fkey` FOREIGN KEY (`org_id`, `dimension_id`) REFERENCES `business_dimensions`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_dimension_values` ADD CONSTRAINT `business_grant_dimension_values_org_id_grant_id_dimension_i_fkey` FOREIGN KEY (`org_id`, `grant_id`, `dimension_id`) REFERENCES `business_grant_dimensions`(`org_id`, `grant_id`, `dimension_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_grant_dimension_values` ADD CONSTRAINT `business_grant_dimension_values_org_id_dimension_id_value_i_fkey` FOREIGN KEY (`org_id`, `dimension_id`, `value_id`) REFERENCES `business_dimension_values`(`org_id`, `dimension_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resources` ADD CONSTRAINT `business_resources_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resources` ADD CONSTRAINT `business_resources_org_id_category_id_fkey` FOREIGN KEY (`org_id`, `category_id`) REFERENCES `business_categories`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resources` ADD CONSTRAINT `business_resources_org_id_document_id_fkey` FOREIGN KEY (`org_id`, `document_id`) REFERENCES `documents`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resources` ADD CONSTRAINT `business_resources_org_id_source_document_id_fkey` FOREIGN KEY (`org_id`, `source_document_id`) REFERENCES `documents`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resource_scopes` ADD CONSTRAINT `business_resource_scopes_org_id_resource_id_fkey` FOREIGN KEY (`org_id`, `resource_id`) REFERENCES `business_resources`(`org_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_resource_scopes` ADD CONSTRAINT `business_resource_scopes_org_id_enterprise_key_store_name_fkey` FOREIGN KEY (`org_id`, `enterprise_key`, `store_name`) REFERENCES `business_stores`(`org_id`, `enterprise_key`, `name`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_scope_dimensions` ADD CONSTRAINT `business_scope_dimensions_org_id_resource_id_scope_id_fkey` FOREIGN KEY (`org_id`, `resource_id`, `scope_id`) REFERENCES `business_resource_scopes`(`org_id`, `resource_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_scope_dimensions` ADD CONSTRAINT `business_scope_dimensions_org_id_dimension_id_value_id_fkey` FOREIGN KEY (`org_id`, `dimension_id`, `value_id`) REFERENCES `business_dimension_values`(`org_id`, `dimension_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_authorization_audits` ADD CONSTRAINT `business_authorization_audits_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `business_authorization_states`(`org_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_authorization_audits` ADD CONSTRAINT `business_authorization_audits_org_id_actor_id_fkey` FOREIGN KEY (`org_id`, `actor_id`) REFERENCES `employees`(`org_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
