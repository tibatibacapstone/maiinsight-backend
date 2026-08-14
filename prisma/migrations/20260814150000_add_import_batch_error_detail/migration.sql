-- Persists the errorCode and suggestion text shown in the upload-time failure alert, so a
-- failed import's history preview can render the exact same BusinessErrorAlert (title,
-- message, suggestion, errorCode) plus the row-level table, instead of only the bare message.
ALTER TABLE `import_batches`
    ADD COLUMN `errorCode` VARCHAR(50) NULL,
    ADD COLUMN `errorSuggestion` TEXT NULL;
