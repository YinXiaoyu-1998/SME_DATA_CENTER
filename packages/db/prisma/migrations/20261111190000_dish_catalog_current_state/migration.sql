-- Dish catalog becomes one current row per (organization, enterprise, SKU).
-- The previous append-only snapshot table is dropped; no data is migrated or backfilled.

-- CreateTable
CREATE TABLE `dish_catalog_entries` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `enterprise_key` VARCHAR(128) NOT NULL,
    `sku_id` VARCHAR(128) NOT NULL,
    `department_id` VARCHAR(36) NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `dish_catalog_entries_org_enterprise_sku_uq`(`org_id`, `enterprise_key`, `sku_id`),
    INDEX `dish_catalog_entries_org_enterprise_department_idx`(`org_id`, `enterprise_key`, `department_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `dish_catalog_entries` ADD CONSTRAINT `dish_catalog_entries_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dish_catalog_entries` ADD CONSTRAINT `dish_catalog_entries_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `business_departments`(`department_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable
DROP TABLE `dish_catalog_rows`;
