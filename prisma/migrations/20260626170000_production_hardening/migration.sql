-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `role` ENUM('operational', 'management', 'it_support') NOT NULL DEFAULT 'operational',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ActivityLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(191) NOT NULL,
    `message` VARCHAR(191) NOT NULL,
    `role` ENUM('operational', 'management', 'it_support') NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_batches` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileName` VARCHAR(191) NOT NULL,
    `rowCount` INTEGER NOT NULL DEFAULT 0,
    `headers` JSON NOT NULL,
    `status` ENUM('uploaded', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'uploaded',
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_transaction_table` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchId` INTEGER NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `data` JSON NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'raw',
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `raw_transaction_table_batchId_idx`(`batchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerKey` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(50) NULL,
    `customerProfile` JSON NULL,
    `customerKeyType` VARCHAR(50) NOT NULL,
    `customerKeyConfidence` VARCHAR(50) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customers_customerKey_key`(`customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `facility_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchId` INTEGER NOT NULL,
    `rawRowId` INTEGER NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `orderId` VARCHAR(100) NULL,
    `customerId` INTEGER NULL,
    `customerKey` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `normalizedName` VARCHAR(191) NULL,
    `normalizedEmail` VARCHAR(191) NULL,
    `normalizedPhone` VARCHAR(50) NULL,
    `customerKeyType` VARCHAR(50) NULL,
    `customerKeyConfidence` VARCHAR(50) NULL,
    `nama` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `noTelepon` VARCHAR(50) NULL,
    `customerProfile` VARCHAR(100) NULL,
    `tanggalTransaksi` DATETIME(3) NULL,
    `tanggalMain` DATETIME(3) NULL,
    `jamMain` VARCHAR(50) NULL,
    `transactionDate` DATETIME(3) NULL,
    `playDate` DATETIME(3) NULL,
    `playTime` VARCHAR(50) NULL,
    `startHour` VARCHAR(10) NULL,
    `endHour` VARCHAR(10) NULL,
    `durationHours` DOUBLE NOT NULL,
    `venue` VARCHAR(100) NULL,
    `lapangan` VARCHAR(100) NULL,
    `court` VARCHAR(100) NOT NULL,
    `courtType` VARCHAR(50) NULL,
    `hargaBersih` DECIMAL(14, 2) NULL,
    `addOns` TEXT NULL,
    `hargaAddOns` DECIMAL(14, 2) NULL,
    `netRevenue` DECIMAL(14, 2) NOT NULL,
    `addOnRevenue` DECIMAL(14, 2) NOT NULL,
    `tipeVoucher` VARCHAR(100) NULL,
    `hargaVoucher` DECIMAL(14, 2) NULL,
    `voucherDiscount` DECIMAL(14, 2) NOT NULL,
    `status` VARCHAR(100) NULL,
    `promoName` VARCHAR(191) NULL,
    `sportPurpose` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `reschedule` VARCHAR(50) NULL,
    `promosi` TEXT NULL,
    `keperluan` VARCHAR(100) NULL,
    `deskripsi` TEXT NULL,
    `period` VARCHAR(20) NULL,
    `playTimeGroup` VARCHAR(30) NULL,
    `bookingType` VARCHAR(50) NOT NULL,
    `validBooking` BOOLEAN NOT NULL DEFAULT false,
    `bookingEventKey` VARCHAR(255) NOT NULL,
    `bookingRangeKey` VARCHAR(255) NOT NULL,
    `rawData` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_transactions_batchId_idx`(`batchId`),
    INDEX `facility_transactions_rawRowId_idx`(`rawRowId`),
    INDEX `facility_transactions_customerId_idx`(`customerId`),
    INDEX `facility_transactions_orderId_idx`(`orderId`),
    INDEX `facility_transactions_nama_idx`(`nama`),
    INDEX `facility_transactions_email_idx`(`email`),
    INDEX `facility_transactions_period_idx`(`period`),
    INDEX `facility_transactions_tanggalMain_idx`(`tanggalMain`),
    INDEX `facility_transactions_status_idx`(`status`),
    INDEX `facility_transactions_playTimeGroup_idx`(`playTimeGroup`),
    INDEX `facility_transactions_playDate_idx`(`playDate`),
    INDEX `facility_transactions_courtType_idx`(`courtType`),
    INDEX `facility_transactions_bookingType_idx`(`bookingType`),
    INDEX `facility_transactions_validBooking_idx`(`validBooking`),
    INDEX `facility_transactions_bookingEventKey_idx`(`bookingEventKey`),
    INDEX `facility_transactions_bookingRangeKey_idx`(`bookingRangeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `court_hour_usages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `transactionId` INTEGER NOT NULL,
    `batchId` INTEGER NOT NULL,
    `playDate` DATETIME(3) NOT NULL,
    `hourStart` VARCHAR(10) NOT NULL,
    `court` VARCHAR(100) NOT NULL,
    `courtType` VARCHAR(50) NULL,
    `courtHourKey` VARCHAR(191) NOT NULL,
    `hourlyRevenue` DECIMAL(14, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `court_hour_usages_courtHourKey_key`(`courtHourKey`),
    INDEX `court_hour_usages_transactionId_idx`(`transactionId`),
    INDEX `court_hour_usages_batchId_idx`(`batchId`),
    INDEX `court_hour_usages_playDate_idx`(`playDate`),
    INDEX `court_hour_usages_hourStart_idx`(`hourStart`),
    INDEX `court_hour_usages_courtType_idx`(`courtType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `segmentation_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `method` VARCHAR(50) NOT NULL DEFAULT 'RFM_KMEANS',
    `kValue` INTEGER NOT NULL DEFAULT 0,
    `totalCustomers` INTEGER NOT NULL DEFAULT 0,
    `filterMonth` VARCHAR(20) NULL,
    `filterYear` INTEGER NULL,
    `filterPeriodType` VARCHAR(10) NULL,
    `filterCourtType` VARCHAR(50) NULL,
    `filterBookingType` VARCHAR(50) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'running',
    `errorMessage` TEXT NULL,
    `silhouetteScore` DOUBLE NULL,
    `kEvaluation` JSON NULL,

    INDEX `segmentation_runs_runDate_idx`(`runDate`),
    INDEX `segmentation_runs_status_idx`(`status`),
    INDEX `segmentation_runs_filterYear_filterMonth_filterPeriodType_idx`(`filterYear`, `filterMonth`, `filterPeriodType`),
    INDEX `segmentation_runs_filterCourtType_filterBookingType_idx`(`filterCourtType`, `filterBookingType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_rfm_scores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `customerKey` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `bookingTypeDominant` VARCHAR(50) NULL,
    `recency` INTEGER NOT NULL,
    `frequency` INTEGER NOT NULL,
    `monetary` DOUBLE NOT NULL,
    `rScore` INTEGER NOT NULL,
    `fScore` INTEGER NOT NULL,
    `mScore` INTEGER NOT NULL,
    `clusterId` INTEGER NOT NULL,
    `segmentName` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_rfm_scores_runId_idx`(`runId`),
    INDEX `customer_rfm_scores_customerKey_idx`(`customerKey`),
    INDEX `customer_rfm_scores_segmentName_idx`(`segmentName`),
    INDEX `customer_rfm_scores_clusterId_idx`(`clusterId`),
    UNIQUE INDEX `customer_rfm_scores_runId_customerKey_key`(`runId`, `customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cluster_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `clusterId` INTEGER NOT NULL,
    `segmentName` VARCHAR(100) NOT NULL,
    `segmentDescription` TEXT NULL,
    `labelReason` TEXT NULL,
    `customerCount` INTEGER NOT NULL,
    `avgRecency` DOUBLE NOT NULL,
    `avgFrequency` DOUBLE NOT NULL,
    `avgMonetary` DOUBLE NOT NULL,
    `avgRScore` DOUBLE NULL,
    `avgFScore` DOUBLE NULL,
    `avgMScore` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cluster_profiles_runId_idx`(`runId`),
    INDEX `cluster_profiles_segmentName_idx`(`segmentName`),
    UNIQUE INDEX `cluster_profiles_runId_clusterId_key`(`runId`, `clusterId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `playtime_ml_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `period` VARCHAR(20) NULL,
    `algorithm` VARCHAR(50) NOT NULL DEFAULT 'KMeans',
    `clusterCount` INTEGER NOT NULL,
    `totalCustomers` INTEGER NOT NULL,
    `totalSessions` INTEGER NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'completed',
    `errorMessage` TEXT NULL,
    `sessionByTime` JSON NULL,
    `heatmapData` JSON NULL,
    `topHourData` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `playtime_customer_segments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `customerName` VARCHAR(191) NOT NULL,
    `sesiPagi` INTEGER NOT NULL,
    `sesiSiang` INTEGER NOT NULL,
    `sesiMalam` INTEGER NOT NULL,
    `totalSesi` INTEGER NOT NULL,
    `ratioPagi` DOUBLE NOT NULL,
    `ratioSiang` DOUBLE NOT NULL,
    `ratioMalam` DOUBLE NOT NULL,
    `playtimeCluster` INTEGER NOT NULL,
    `playtimeSegment` VARCHAR(100) NOT NULL,
    `activityLevel` VARCHAR(100) NULL,

    INDEX `playtime_customer_segments_runId_idx`(`runId`),
    INDEX `playtime_customer_segments_customerName_idx`(`customerName`),
    INDEX `playtime_customer_segments_playtimeSegment_idx`(`playtimeSegment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `playtime_segment_summaries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `playtimeCluster` INTEGER NOT NULL,
    `playtimeSegment` VARCHAR(100) NOT NULL,
    `totalCustomers` INTEGER NOT NULL,
    `avgRatioPagi` DOUBLE NOT NULL,
    `avgRatioSiang` DOUBLE NOT NULL,
    `avgRatioMalam` DOUBLE NOT NULL,
    `avgSesiPagi` DOUBLE NOT NULL,
    `avgSesiSiang` DOUBLE NOT NULL,
    `avgSesiMalam` DOUBLE NOT NULL,
    `avgTotalSesi` DOUBLE NOT NULL,

    INDEX `playtime_segment_summaries_runId_idx`(`runId`),
    INDEX `playtime_segment_summaries_playtimeSegment_idx`(`playtimeSegment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `meta_raw_responses` (
    `id` VARCHAR(30) NOT NULL,
    `source` VARCHAR(100) NOT NULL,
    `endpoint` TEXT NOT NULL,
    `method` VARCHAR(20) NOT NULL DEFAULT 'GET',
    `params` JSON NULL,
    `responseJson` JSON NULL,
    `status` VARCHAR(50) NOT NULL,
    `errorMessage` TEXT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_accounts` (
    `id` VARCHAR(30) NOT NULL,
    `igUserId` VARCHAR(100) NOT NULL,
    `username` VARCHAR(100) NULL,
    `name` VARCHAR(150) NULL,
    `followersCount` INTEGER NULL,
    `followsCount` INTEGER NULL,
    `mediaCount` INTEGER NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instagram_accounts_igUserId_key`(`igUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_account_snapshots` (
    `id` VARCHAR(30) NOT NULL,
    `accountId` VARCHAR(30) NOT NULL,
    `followersCount` INTEGER NULL,
    `followsCount` INTEGER NULL,
    `mediaCount` INTEGER NULL,
    `snapshotDate` DATETIME(3) NOT NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instagram_account_snapshots_accountId_snapshotDate_key`(`accountId`, `snapshotDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_media` (
    `id` VARCHAR(30) NOT NULL,
    `igMediaId` VARCHAR(100) NOT NULL,
    `accountId` VARCHAR(30) NOT NULL,
    `caption` TEXT NULL,
    `mediaType` VARCHAR(50) NULL,
    `mediaProductType` VARCHAR(50) NULL,
    `mediaUrl` TEXT NULL,
    `thumbnailUrl` TEXT NULL,
    `permalink` TEXT NULL,
    `postedAt` DATETIME(3) NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instagram_media_igMediaId_key`(`igMediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_media_insights` (
    `id` VARCHAR(30) NOT NULL,
    `mediaId` VARCHAR(30) NOT NULL,
    `metricName` VARCHAR(100) NOT NULL,
    `metricValue` DOUBLE NULL,
    `period` VARCHAR(50) NOT NULL DEFAULT 'lifetime',
    `insightDate` DATETIME(3) NOT NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `instagram_media_insights_metricName_idx`(`metricName`),
    UNIQUE INDEX `instagram_media_insights_mediaId_metricName_insightDate_peri_key`(`mediaId`, `metricName`, `insightDate`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_account_insights` (
    `id` VARCHAR(30) NOT NULL,
    `accountId` VARCHAR(30) NOT NULL,
    `metricName` VARCHAR(100) NOT NULL,
    `metricValue` DOUBLE NULL,
    `period` VARCHAR(50) NOT NULL,
    `insightDate` DATETIME(3) NOT NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `instagram_account_insights_metricName_idx`(`metricName`),
    UNIQUE INDEX `instagram_account_insights_accountId_metricName_insightDate__key`(`accountId`, `metricName`, `insightDate`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_audience_insights` (
    `id` VARCHAR(30) NOT NULL,
    `accountId` VARCHAR(30) NOT NULL,
    `metricName` VARCHAR(100) NOT NULL,
    `breakdownType` VARCHAR(50) NOT NULL,
    `breakdownValue` VARCHAR(191) NOT NULL,
    `metricValue` DOUBLE NULL,
    `period` VARCHAR(50) NOT NULL,
    `insightDate` DATETIME(3) NOT NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instagram_audience_insights_accountId_metricName_breakdownTy_key`(`accountId`, `metricName`, `breakdownType`, `breakdownValue`, `insightDate`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instagram_content_summaries` (
    `id` VARCHAR(30) NOT NULL,
    `mediaId` VARCHAR(30) NOT NULL,
    `summary` TEXT NULL,
    `performanceInsight` TEXT NULL,
    `recommendation` TEXT NULL,
    `generatedBy` VARCHAR(100) NULL,
    `generatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `instagram_content_summaries_mediaId_idx`(`mediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `meta_sync_logs` (
    `id` VARCHAR(30) NOT NULL,
    `syncType` VARCHAR(100) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `message` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ActivityLog` ADD CONSTRAINT `ActivityLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_transaction_table` ADD CONSTRAINT `raw_transaction_table_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transactions` ADD CONSTRAINT `facility_transactions_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `import_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_transactions` ADD CONSTRAINT `facility_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `court_hour_usages` ADD CONSTRAINT `court_hour_usages_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `facility_transactions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_rfm_scores` ADD CONSTRAINT `customer_rfm_scores_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `segmentation_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cluster_profiles` ADD CONSTRAINT `cluster_profiles_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `segmentation_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `playtime_customer_segments` ADD CONSTRAINT `playtime_customer_segments_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `playtime_ml_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `playtime_segment_summaries` ADD CONSTRAINT `playtime_segment_summaries_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `playtime_ml_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instagram_account_snapshots` ADD CONSTRAINT `instagram_account_snapshots_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `instagram_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instagram_media` ADD CONSTRAINT `instagram_media_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `instagram_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instagram_media_insights` ADD CONSTRAINT `instagram_media_insights_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `instagram_media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instagram_account_insights` ADD CONSTRAINT `instagram_account_insights_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `instagram_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instagram_audience_insights` ADD CONSTRAINT `instagram_audience_insights_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `instagram_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

