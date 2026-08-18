ALTER TABLE `customer_rfm_scores` ADD COLUMN `centroidDistance` DOUBLE NULL, ADD COLUMN `centroidThreshold` DOUBLE NULL, ADD COLUMN `clusterFit` VARCHAR(30) NULL;
ALTER TABLE `cluster_profiles` ADD COLUMN `centroidDistance` DOUBLE NULL, ADD COLUMN `centroidThreshold` DOUBLE NULL, ADD COLUMN `clusterFit` VARCHAR(30) NULL;
