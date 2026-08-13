CREATE TABLE `ai_usage_logs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NULL,
  `model` VARCHAR(100) NOT NULL,
  `feature` VARCHAR(100) NOT NULL,
  `promptTokens` INTEGER NOT NULL DEFAULT 0,
  `candidatesTokens` INTEGER NOT NULL DEFAULT 0,
  `totalTokens` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ai_usage_logs_createdAt_idx`(`createdAt`),
  INDEX `ai_usage_logs_userId_idx`(`userId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ai_usage_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
