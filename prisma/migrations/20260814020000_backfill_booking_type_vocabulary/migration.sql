-- The transaction-status classifier (transactionStatus.service.js) was refactored to write
-- canonical bookingType values ('GeloraApp Booking', 'Manual/Walk-in', 'Internal',
-- 'Tutup/Maintenance') for newly imported rows, but historical rows imported before that
-- refactor still carry the old vocabulary ('membership', 'non_membership', 'internal',
-- 'blocked'). Every place that filters/aggregates by bookingType today (dashboard heatmap
-- and playtime-mix filters, low-occupancy-targeting customer filter, customerType
-- recalculation) compares against the new canonical strings, so historical rows silently
-- fail to match. `status` was always written in canonical form, so it is used here as the
-- single source of truth to re-derive bookingType for any row not already canonical.
UPDATE `facility_transactions`
SET `bookingType` = CASE `status`
    WHEN 'Payment Completed' THEN 'GeloraApp Booking'
    WHEN 'Manual/Walk-in' THEN 'Manual/Walk-in'
    WHEN 'Internal' THEN 'Internal'
    WHEN 'Tutup/Maintenance' THEN 'Tutup/Maintenance'
    ELSE `bookingType`
END
WHERE `bookingType` NOT IN ('GeloraApp Booking', 'Manual/Walk-in', 'Internal', 'Tutup/Maintenance');
