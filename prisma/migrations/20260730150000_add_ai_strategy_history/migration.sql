CREATE TABLE `ai_strategies` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `provider` VARCHAR(50) NOT NULL,
  `model` VARCHAR(100) NOT NULL,
  `targetSegmentKey` VARCHAR(50) NOT NULL,
  `targetVenueKey` VARCHAR(50) NULL,
  `targetSessionKey` VARCHAR(50) NULL,
  `campaignObjectiveKey` VARCHAR(100) NULL,
  `offerFrameworkKey` VARCHAR(100) NULL,
  `strategy` JSON NOT NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ai_strategies_generatedAt_idx`(`generatedAt`),
  INDEX `ai_strategies_targetSegmentKey_idx`(`targetSegmentKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
