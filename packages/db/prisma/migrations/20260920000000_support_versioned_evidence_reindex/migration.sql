DROP INDEX `document_chunks_document_id_chunk_hash_index_type_key` ON `document_chunks`;

CREATE INDEX `document_chunks_document_id_chunk_hash_index_type_idx`
  ON `document_chunks`(`document_id`, `chunk_hash`, `index_type`);
