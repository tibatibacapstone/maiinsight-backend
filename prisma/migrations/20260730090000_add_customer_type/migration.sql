ALTER TABLE `customers`
    ADD COLUMN `customerType` VARCHAR(50) NOT NULL DEFAULT 'unknown',
    ADD COLUMN `membershipTransactionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `nonMembershipTransactionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `internalTransactionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `customerTypeCalculatedAt` DATETIME(3) NULL;

-- Operational rows historically used SYS identities without Customer records.
-- Persist those identities in the existing canonical Customer model so the
-- requested internal/unknown customer-level classification can be represented.
INSERT INTO `customers` (
    `customerIdentity`,
    `customerKey`,
    `name`,
    `email`,
    `phone`,
    `customerProfile`,
    `customerKeyType`,
    `customerKeyConfidence`,
    `customerType`,
    `membershipTransactionCount`,
    `nonMembershipTransactionCount`,
    `internalTransactionCount`,
    `customerTypeCalculatedAt`,
    `createdAt`,
    `updatedAt`
)
SELECT
    ft.`customerIdentity`,
    ft.`customerKey`,
    MAX(ft.`customerName`),
    NULL,
    NULL,
    NULL,
    'operational',
    1,
    'unknown',
    0,
    0,
    0,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM `facility_transactions` ft
WHERE ft.`customerKey` LIKE 'SYS-%'
GROUP BY ft.`customerIdentity`, ft.`customerKey`
ON DUPLICATE KEY UPDATE
    `customerKeyType` = 'operational',
    `customerKeyConfidence` = 1,
    `updatedAt` = CURRENT_TIMESTAMP(3);

UPDATE `facility_transactions` ft
INNER JOIN `customers` c
    ON c.`customerIdentity` = ft.`customerIdentity`
SET
    ft.`customerId` = c.`id`,
    ft.`customerKey` = c.`customerKey`
WHERE ft.`customerId` IS NULL
  AND ft.`customerKey` LIKE 'SYS-%';

UPDATE `customers` c
LEFT JOIN (
    SELECT
        ft.`customerId`,
        SUM(CASE WHEN ft.`bookingType` = 'membership' THEN 1 ELSE 0 END) AS membershipCount,
        SUM(CASE WHEN ft.`bookingType` = 'non_membership' THEN 1 ELSE 0 END) AS nonMembershipCount,
        SUM(CASE WHEN ft.`bookingType` = 'internal' THEN 1 ELSE 0 END) AS internalCount
    FROM `facility_transactions` ft
    WHERE ft.`validBooking` = TRUE
      AND ft.`customerId` IS NOT NULL
      AND ft.`bookingType` IN ('membership', 'non_membership', 'internal')
    GROUP BY ft.`customerId`
) counts ON counts.`customerId` = c.`id`
SET
    c.`membershipTransactionCount` = COALESCE(counts.membershipCount, 0),
    c.`nonMembershipTransactionCount` = COALESCE(counts.nonMembershipCount, 0),
    c.`internalTransactionCount` = COALESCE(counts.internalCount, 0),
    c.`customerType` = CASE
        WHEN COALESCE(counts.membershipCount, 0) > 0 THEN 'membership'
        WHEN COALESCE(counts.nonMembershipCount, 0) > 0 THEN 'non_membership'
        WHEN c.`customerKeyType` = 'operational'
          AND COALESCE(counts.internalCount, 0) > 0 THEN 'internal'
        ELSE 'unknown'
    END,
    c.`customerTypeCalculatedAt` = CURRENT_TIMESTAMP(3);
