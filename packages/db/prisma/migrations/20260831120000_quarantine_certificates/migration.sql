ALTER TABLE `documents`
    MODIFY `document_kind` ENUM('evidence', 'structured', 'quarantine_certificate') NULL,
    MODIFY `file_type` ENUM('md', 'txt', 'docx', 'xlsx', 'csv', 'jpg', 'jpeg', 'png') NULL;

CREATE TABLE `quarantine_certificates` (
    `id` VARCHAR(32) NOT NULL,
    `org_id` VARCHAR(64) NOT NULL,
    `source_document_id` VARCHAR(32) NOT NULL,
    `receipt_id` VARCHAR(255) NOT NULL,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `request_fingerprint` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `quarantine_certificates_source_document_id_key`(`source_document_id`),
    UNIQUE INDEX `quarantine_certificates_org_id_idempotency_key_key`(`org_id`, `idempotency_key`),
    INDEX `quarantine_certificates_org_id_receipt_id_idx`(`org_id`, `receipt_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `quarantine_certificates`
    ADD CONSTRAINT `quarantine_certificates_org_id_fkey`
      FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `quarantine_certificates_source_document_id_fkey`
      FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
