-- AlterTable: add the `vip` (会员主题) structured dataset to both ENUM columns.
ALTER TABLE `import_batches`
    MODIFY `dataset` ENUM('dishes', 'business', 'vip') NOT NULL;

ALTER TABLE `import_window_claims`
    MODIFY `dataset` ENUM('dishes', 'business', 'vip') NOT NULL;

-- CreateTable: VIP member rows mirror the current dish_rows/business_rows shape
-- (worksheet lineage columns included from the start).
CREATE TABLE `vip_rows` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `source_sheet_index` INTEGER NOT NULL DEFAULT 0,
    `source_sheet_name` VARCHAR(255) NOT NULL DEFAULT 'Sheet1',
    `source_row_number` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vip_rows_org_id_import_batch_id_idx`(`org_id`, `import_batch_id`),
    UNIQUE INDEX `vip_rows_batch_sheet_row_uq`(`import_batch_id`, `source_sheet_index`, `source_row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `vip_rows` ADD CONSTRAINT `vip_rows_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vip_rows` ADD CONSTRAINT `vip_rows_source_document_id_fkey` FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vip_rows` ADD CONSTRAINT `vip_rows_import_batch_id_fkey` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
