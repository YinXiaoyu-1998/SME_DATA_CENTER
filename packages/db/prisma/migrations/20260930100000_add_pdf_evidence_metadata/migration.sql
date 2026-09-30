-- Append to preserve the existing ENUM ordinals and its one-byte storage width.
-- Fail rather than silently fall back to a table copy when INSTANT is unavailable.
ALTER TABLE `documents`
  MODIFY COLUMN `file_type` ENUM('md', 'txt', 'docx', 'xlsx', 'csv', 'jpg', 'jpeg', 'png', 'pdf') NULL,
  ALGORITHM=INSTANT;

-- Add nullable metadata without rewriting existing document/index identities or backfilling.
-- INSTANT still needs a metadata lock; deployment must account for active transactions.
ALTER TABLE `document_indexes`
  ADD COLUMN `parser_fingerprint` VARCHAR(256) NULL,
  ADD COLUMN `parsed_object_key` VARCHAR(1024) NULL,
  ADD COLUMN `parse_summary` JSON NULL,
  ALGORITHM=INSTANT;
