CREATE TABLE `notification_reads` (
    `notificationId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `readAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notification_reads_userId_idx`(`userId`),
    PRIMARY KEY (`notificationId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `notification_reads`
    ADD CONSTRAINT `notification_reads_notificationId_fkey`
    FOREIGN KEY (`notificationId`) REFERENCES `Notification`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `notification_reads`
    ADD CONSTRAINT `notification_reads_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
