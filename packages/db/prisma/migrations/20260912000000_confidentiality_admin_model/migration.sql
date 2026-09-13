-- Replace the label-intersection authorization model with immutable document
-- confidentiality and explicit employee clearance. This is intentionally a
-- one-way cutover: legacy label data is not retained for compatibility.

UPDATE `employees` SET `role` = 'admin' WHERE `role` = 'manager';

ALTER TABLE `employees`
    ADD COLUMN `clearance` TINYINT UNSIGNED NOT NULL DEFAULT 3;

ALTER TABLE `documents`
    ADD COLUMN `confidentiality_level` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    ADD INDEX `documents_org_id_status_confidentiality_level_idx` (`org_id`, `status`, `confidentiality_level`);

ALTER TABLE `employees`
    MODIFY `role` ENUM('admin', 'employee') NOT NULL,
    MODIFY `clearance` TINYINT UNSIGNED NOT NULL,
    ADD CONSTRAINT `employees_clearance_range` CHECK (`clearance` BETWEEN 0 AND 3);

ALTER TABLE `documents`
    ADD CONSTRAINT `documents_confidentiality_level_range` CHECK (`confidentiality_level` BETWEEN 0 AND 3);

DELETE FROM `document_labels`;
DELETE FROM `employee_labels`;
DELETE FROM `labels`;

ALTER TABLE `document_labels`
    DROP FOREIGN KEY `document_labels_document_id_fkey`,
    DROP FOREIGN KEY `document_labels_label_id_fkey`;

ALTER TABLE `employee_labels`
    DROP FOREIGN KEY `employee_labels_employee_id_fkey`,
    DROP FOREIGN KEY `employee_labels_label_id_fkey`;

ALTER TABLE `labels`
    DROP FOREIGN KEY `labels_org_id_fkey`;

DROP TABLE `document_labels`;
DROP TABLE `employee_labels`;
DROP TABLE `labels`;
