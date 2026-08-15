import { metricValueOrNull } from "./metaHistorical.service.js"

const getLatestMetricValue = (insights, metricNames) => {
  const matchedInsights = insights
    .filter((insight) => metricNames.includes(insight.metricName))
    .sort((left, right) => {
      const dateDifference =
        new Date(right.insightDate).getTime() - new Date(left.insightDate).getTime()
      if (dateDifference !== 0) return dateDifference
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    })

  if (!matchedInsights.length || matchedInsights[0].metricValue == null) return null
  return metricValueOrNull(matchedInsights[0].metricValue)
}

const round2 = (value) => Number(value.toFixed(2))

// One row per InstagramMedia post: latest known value per metric, plus
// engagement/share/save rate derived from reach. Shared by the InstaSight
// dashboard and the GenAI Workspace's social-content evidence so both read
// posts the exact same way.
export const computeContentPerformance = (mediaRows = []) =>
  mediaRows
    .map((item) => {
      const insights = item.insights || []
      const rawMedia = item.rawJson || {}

      const views = getLatestMetricValue(insights, ["views", "impressions", "plays"])
      const reach = getLatestMetricValue(insights, ["reach"])
      const likes = getLatestMetricValue(insights, ["likes"]) ?? metricValueOrNull(rawMedia.like_count)
      const comments =
        getLatestMetricValue(insights, ["comments"]) ?? metricValueOrNull(rawMedia.comments_count)
      const shares = getLatestMetricValue(insights, ["shares"])
      const saved = getLatestMetricValue(insights, ["saved"])
      const interactions =
        getLatestMetricValue(insights, ["total_interactions"]) ??
        (likes ?? 0) + (comments ?? 0) + (shares ?? 0) + (saved ?? 0)

      const engagementRate = reach == null ? null : reach > 0 ? round2((interactions / reach) * 100) : 0
      const shareRate =
        reach == null || shares == null ? null : reach > 0 ? round2((shares / reach) * 100) : 0
      const saveRate =
        reach == null || saved == null ? null : reach > 0 ? round2((saved / reach) * 100) : 0

      return {
        id: item.id,
        igMediaId: item.igMediaId,
        caption: item.caption,
        contentLabel: item.contentLabel || "content_advertisement",
        mediaType: item.mediaType,
        mediaProductType: item.mediaProductType,
        mediaUrl: item.mediaUrl,
        thumbnailUrl: item.thumbnailUrl,
        permalink: item.permalink,
        postedAt: item.postedAt,
        views,
        reach,
        likes,
        comments,
        interactions,
        shares,
        saved,
        engagementRate,
        shareRate,
        saveRate,
      }
    })
    .sort((left, right) => (right.views ?? -1) - (left.views ?? -1))
