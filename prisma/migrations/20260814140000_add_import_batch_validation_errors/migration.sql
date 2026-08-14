-- Persists the row-level validation error table (row/column/value/message) for a failed
-- import so it can be viewed later from import history, instead of only being shown once
-- in the upload response at the moment the file was rejected.
ALTER TABLE `import_batches`
    ADD COLUMN `validationErrors` JSON NULL;
