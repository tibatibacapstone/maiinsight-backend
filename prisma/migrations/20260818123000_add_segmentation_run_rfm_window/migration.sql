ALTER TABLE `segmentation_runs` ADD COLUMN `rfmWindowStartYear` INTEGER NULL,
    ADD COLUMN `rfmWindowEndYear` INTEGER NULL,
    ADD COLUMN `rfmWindowYears` INTEGER NULL,
    ADD COLUMN `numberOfTransactionsUsed` INTEGER NULL,
    ADD COLUMN `numberOfCustomersUsed` INTEGER NULL;
