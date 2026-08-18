ALTER TABLE `instagram_media` ADD COLUMN `cachedImageData` MEDIUMTEXT NULL,
    ADD COLUMN `cachedImageContentType` VARCHAR(100) NULL,
    ADD COLUMN `cachedImageFetchedAt` DATETIME(3) NULL;
