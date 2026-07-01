ALTER TABLE `playtime_customer_segments`
  ADD COLUMN `sesiEvening` INTEGER NOT NULL DEFAULT 0 AFTER `sesiSiang`,
  ADD COLUMN `ratioEvening` DOUBLE NOT NULL DEFAULT 0 AFTER `ratioSiang`;

ALTER TABLE `playtime_segment_summaries`
  ADD COLUMN `avgRatioEvening` DOUBLE NOT NULL DEFAULT 0 AFTER `avgRatioSiang`,
  ADD COLUMN `avgSesiEvening` DOUBLE NOT NULL DEFAULT 0 AFTER `avgSesiSiang`;
