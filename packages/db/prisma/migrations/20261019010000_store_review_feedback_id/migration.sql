ALTER TABLE `store_reviews`
  ADD COLUMN `feedback_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD COLUMN `feedback_id_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  DROP INDEX `uq_store_reviews_identity`,
  ADD UNIQUE KEY `uq_store_reviews_identity` (`org_id`, `enterprise_key`, `source`, `store_name`, `reviewed_at`, `reviewer_name`, `feedback_id_key`);
