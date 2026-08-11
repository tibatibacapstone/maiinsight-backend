-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `downloadRecordId` INTEGER NULL;

-- CreateTable
CREATE TABLE `DownloadRecord` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileName` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(191) NOT NULL DEFAULT 'text/csv; charset=utf-8',
    `fileData` MEDIUMTEXT NOT NULL,
    `fileSizeBytes` INTEGER NOT NULL DEFAULT 0,
    `downloadedById` INTEGER NOT NULL,
    `downloadedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DownloadRecord_downloadedById_idx`(`downloadedById`),
    INDEX `DownloadRecord_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_downloadRecordId_fkey` FOREIGN KEY (`downloadRecordId`) REFERENCES `DownloadRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
