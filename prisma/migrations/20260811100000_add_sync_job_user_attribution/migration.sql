ALTER TABLE `import_batches`
  ADD COLUMN `performedByUserId` INTEGER NULL;

ALTER TABLE `meta_sync_logs`
  ADD COLUMN `performedByUserId` INTEGER NULL;

ALTER TABLE `segmentation_runs`
  ADD COLUMN `performedByUserId` INTEGER NULL;

ALTER TABLE `ai_strategies`
  ADD COLUMN `performedByUserId` INTEGER NULL;

CREATE INDEX `import_batches_performedByUserId_idx`
  ON `import_batches`(`performedByUserId`);
CREATE INDEX `meta_sync_logs_performedByUserId_idx`
  ON `meta_sync_logs`(`performedByUserId`);
CREATE INDEX `segmentation_runs_performedByUserId_idx`
  ON `segmentation_runs`(`performedByUserId`);
CREATE INDEX `ai_strategies_performedByUserId_idx`
  ON `ai_strategies`(`performedByUserId`);

ALTER TABLE `import_batches`
  ADD CONSTRAINT `import_batches_performedByUserId_fkey`
  FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `meta_sync_logs`
  ADD CONSTRAINT `meta_sync_logs_performedByUserId_fkey`
  FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `segmentation_runs`
  ADD CONSTRAINT `segmentation_runs_performedByUserId_fkey`
  FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ai_strategies`
  ADD CONSTRAINT `ai_strategies_performedByUserId_fkey`
  FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
