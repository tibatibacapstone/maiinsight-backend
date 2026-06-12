ALTER TABLE `User`
MODIFY `role` ENUM('admin','marketing','management','it_support')
NOT NULL DEFAULT 'marketing';

ALTER TABLE `Notification`
MODIFY `role` ENUM('admin','marketing','management','it_support')
NOT NULL;

UPDATE `User`
SET `role` = 'marketing'
WHERE `role` = 'admin';

UPDATE `Notification`
SET `role` = 'marketing'
WHERE `role` = 'admin';
