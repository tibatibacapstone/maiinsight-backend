CREATE TABLE campaign_attributions (
  id VARCHAR(30) NOT NULL,
  displayName VARCHAR(255) NOT NULL,
  matchingName VARCHAR(255) NOT NULL,
  internalKey VARCHAR(320) NOT NULL,
  startDate DATETIME(3) NULL,
  endDate DATETIME(3) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL,
  UNIQUE INDEX campaign_attributions_internalKey_key (internalKey),
  INDEX campaign_attributions_matchingName_idx (matchingName),
  INDEX campaign_attributions_startDate_endDate_idx (startDate, endDate),
  INDEX campaign_attributions_status_idx (status),
  PRIMARY KEY (id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE campaign_attribution_content (
  campaignId VARCHAR(30) NOT NULL,
  mediaId VARCHAR(30) NOT NULL,
  captionHash VARCHAR(64) NOT NULL,
  extractedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX campaign_attribution_content_mediaId_key (mediaId),
  INDEX campaign_attribution_content_mediaId_idx (mediaId),
  PRIMARY KEY (campaignId, mediaId),
  CONSTRAINT campaign_attribution_content_campaignId_fkey FOREIGN KEY (campaignId) REFERENCES campaign_attributions (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT campaign_attribution_content_mediaId_fkey FOREIGN KEY (mediaId) REFERENCES instagram_media (id) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
