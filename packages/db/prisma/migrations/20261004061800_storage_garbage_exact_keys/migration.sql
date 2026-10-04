ALTER TABLE storage_garbage
  DROP INDEX storage_garbage_object_key_key,
  MODIFY object_key VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  ADD COLUMN object_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN processing_run_id VARCHAR(32) NULL,
  ADD COLUMN repeat_deletion BOOLEAN NOT NULL DEFAULT false;
UPDATE storage_garbage SET object_key_hash = SHA2(CAST(object_key AS BINARY), 256);
ALTER TABLE storage_garbage
  MODIFY object_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD UNIQUE INDEX storage_garbage_object_key_hash_key (object_key_hash),
  ADD INDEX storage_garbage_processing_run_id_idx (processing_run_id),
  ADD CONSTRAINT storage_garbage_processing_run_id_fkey FOREIGN KEY (processing_run_id) REFERENCES processing_runs(id) ON DELETE SET NULL ON UPDATE CASCADE;
