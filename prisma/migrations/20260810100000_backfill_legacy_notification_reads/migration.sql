-- Preserve the legacy shared read state when moving to per-user receipts.
-- Under the old model, a read notification was read for every user who could
-- see its target role. INSERT IGNORE makes this safe when receipts already
-- exist or when deployment tooling retries the data migration.
INSERT IGNORE INTO `notification_reads` (`notificationId`, `userId`, `readAt`)
SELECT
    `notification`.`id`,
    `user`.`id`,
    CURRENT_TIMESTAMP(3)
FROM `Notification` AS `notification`
INNER JOIN `User` AS `user`
    ON `user`.`role` = `notification`.`role`
WHERE `notification`.`read` = true;
