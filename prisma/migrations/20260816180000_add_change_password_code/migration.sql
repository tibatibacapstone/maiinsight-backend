-- Adds a short-lived, hashed one-time code used by the "Change password" flow in the
-- profile menu (Settings -> profile -> Send confirmation code -> Update password).
ALTER TABLE `User`
    ADD COLUMN `changePasswordCode` VARCHAR(191) NULL,
    ADD COLUMN `changePasswordCodeExpiresAt` DATETIME(3) NULL;
