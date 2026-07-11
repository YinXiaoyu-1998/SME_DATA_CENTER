-- AlterTable
ALTER TABLE `document_chunks` ADD COLUMN `chunk_id` VARCHAR(128) NULL,
    ADD COLUMN `content_version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `document_index_id` VARCHAR(32) NULL,
    ADD COLUMN `qdrant_point_id` VARCHAR(128) NULL,
    ADD COLUMN `retrieval_config_version` VARCHAR(128) NULL,
    ADD COLUMN `source_location` JSON NULL;

-- AlterTable
ALTER TABLE `documents` ADD COLUMN `content_version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `document_kind` ENUM('evidence', 'structured') NULL,
    ADD COLUMN `file_type` ENUM('md', 'txt', 'docx', 'xlsx', 'csv') NULL;

-- AlterTable
ALTER TABLE `processing_runs` ADD COLUMN `job_type` ENUM('legacy_text_extract', 'evidence_document_index', 'structured_import') NOT NULL DEFAULT 'legacy_text_extract';

-- CreateTable
CREATE TABLE `retrieval_configs` (
    `id` VARCHAR(32) NOT NULL,
    `version` VARCHAR(128) NOT NULL,
    `status` ENUM('active', 'candidate', 'deprecated') NOT NULL DEFAULT 'candidate',
    `chunker_name` VARCHAR(128) NOT NULL,
    `dense_embedding_provider` VARCHAR(128) NOT NULL,
    `dense_embedding_model` VARCHAR(255) NOT NULL,
    `dense_vector_dimension` INTEGER NOT NULL,
    `sparse_model` VARCHAR(255) NULL,
    `rerank_provider` VARCHAR(128) NULL,
    `rerank_model` VARCHAR(255) NULL,
    `qdrant_collection` VARCHAR(255) NOT NULL,
    `config_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `retrieval_configs_version_key`(`version`),
    INDEX `retrieval_configs_status_version_idx`(`status`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_indexes` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `document_id` VARCHAR(32) NOT NULL,
    `retrieval_config_id` VARCHAR(32) NOT NULL,
    `content_version` INTEGER NOT NULL,
    `status` ENUM('pending', 'indexing', 'ready', 'failed', 'superseded') NOT NULL DEFAULT 'pending',
    `qdrant_collection` VARCHAR(255) NOT NULL,
    `indexed_chunk_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(128) NULL,
    `error_summary` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `ready_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `document_indexes_org_id_status_idx`(`org_id`, `status`),
    INDEX `document_indexes_document_id_status_idx`(`document_id`, `status`),
    UNIQUE INDEX `document_indexes_document_id_retrieval_config_id_content_ver_key`(`document_id`, `retrieval_config_id`, `content_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_batches` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `dataset` ENUM('dishes', 'business') NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `request_fingerprint` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'validating', 'applying', 'applied', 'failed', 'rejected', 'archived') NOT NULL DEFAULT 'pending',
    `source_sheet_summary` JSON NULL,
    `validation_errors` JSON NULL,
    `total_row_count` INTEGER NOT NULL DEFAULT 0,
    `applied_row_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(128) NULL,
    `error_summary` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `archived_at` DATETIME(3) NULL,

    UNIQUE INDEX `import_batches_source_document_id_key`(`source_document_id`),
    INDEX `import_batches_org_id_dataset_status_idx`(`org_id`, `dataset`, `status`),
    INDEX `import_batches_org_id_dataset_start_date_end_date_idx`(`org_id`, `dataset`, `start_date`, `end_date`),
    UNIQUE INDEX `import_batches_org_id_idempotency_key_key`(`org_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_window_claims` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `dataset` ENUM('dishes', 'business') NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `import_window_claims_import_batch_id_key`(`import_batch_id`),
    UNIQUE INDEX `import_window_claims_org_id_dataset_start_date_end_date_key`(`org_id`, `dataset`, `start_date`, `end_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dish_rows` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `source_row_number` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `dish_rows_org_id_import_batch_id_idx`(`org_id`, `import_batch_id`),
    UNIQUE INDEX `dish_rows_import_batch_id_source_row_number_key`(`import_batch_id`, `source_row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_rows` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `import_batch_id` VARCHAR(32) NOT NULL,
    `source_row_number` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `business_rows_org_id_import_batch_id_idx`(`org_id`, `import_batch_id`),
    UNIQUE INDEX `business_rows_import_batch_id_source_row_number_key`(`import_batch_id`, `source_row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `document_chunks_qdrant_point_id_idx` ON `document_chunks`(`qdrant_point_id`);

-- CreateIndex
CREATE UNIQUE INDEX `document_chunks_document_index_id_chunk_id_key` ON `document_chunks`(`document_index_id`, `chunk_id`);

-- CreateIndex
CREATE INDEX `documents_org_id_document_kind_status_idx` ON `documents`(`org_id`, `document_kind`, `status`);

-- AddForeignKey
ALTER TABLE `document_chunks` ADD CONSTRAINT `document_chunks_document_index_id_fkey` FOREIGN KEY (`document_index_id`) REFERENCES `document_indexes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_indexes` ADD CONSTRAINT `document_indexes_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_indexes` ADD CONSTRAINT `document_indexes_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_indexes` ADD CONSTRAINT `document_indexes_retrieval_config_id_fkey` FOREIGN KEY (`retrieval_config_id`) REFERENCES `retrieval_configs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_source_document_id_fkey` FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_window_claims` ADD CONSTRAINT `import_window_claims_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_window_claims` ADD CONSTRAINT `import_window_claims_import_batch_id_fkey` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dish_rows` ADD CONSTRAINT `dish_rows_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dish_rows` ADD CONSTRAINT `dish_rows_source_document_id_fkey` FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dish_rows` ADD CONSTRAINT `dish_rows_import_batch_id_fkey` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_rows` ADD CONSTRAINT `business_rows_org_id_fkey` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_rows` ADD CONSTRAINT `business_rows_source_document_id_fkey` FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_rows` ADD CONSTRAINT `business_rows_import_batch_id_fkey` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
