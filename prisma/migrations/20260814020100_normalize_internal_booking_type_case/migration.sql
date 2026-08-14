-- The previous migration's WHERE clause compared bookingType using the column's default
-- (case-insensitive) collation, so rows already spelled 'internal' were treated as already
-- equal to 'Internal' and skipped, leaving them lowercase. That still matches correctly at
-- query time under the same collation, but this normalizes the stored value to the exact
-- canonical casing so bookingType no longer depends on collation behavior to stay consistent.
UPDATE `facility_transactions`
SET `bookingType` = 'Internal'
WHERE `status` = 'Internal' AND BINARY `bookingType` != 'Internal';
