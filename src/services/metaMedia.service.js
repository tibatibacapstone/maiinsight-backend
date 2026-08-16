import { prisma } from "../config/prisma.js";
import { getIgUserId, metaGet, numberOrNull, startOfDay } from "./meta.service.js";
import {
  META_HISTORY_MONTHS,
  selectStoredMediaForInsightRefresh,
} from "./meta.service.js";

// Media discovery and period filtering
const DEFAULT_MAX_MEDIA_PAGES = 25;

function parseBoundary(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function mediaMatchesContentType(media, contentType = "all") {
  const normalizedType = String(contentType || "all").toLowerCase();
  if (normalizedType === "all") return true;

  const mediaType = String(media?.media_type || media?.mediaType || "").toUpperCase();
  const productType = String(
    media?.media_product_type || media?.mediaProductType || ""
  ).toUpperCase();

  if (normalizedType === "reels") {
    return productType.includes("REEL") || mediaType === "VIDEO";
  }

  if (normalizedType === "feed") {
    return (
      productType.includes("FEED") ||
      mediaType === "IMAGE" ||
      mediaType === "CAROUSEL_ALBUM"
    );
  }

  return true;
}

export async function fetchMediaForPeriod({
  fetchPage,
  since,
  until,
  contentType = "all",
  maxPages = DEFAULT_MAX_MEDIA_PAGES,
}) {
  const startDate = parseBoundary(since);
  const endDate = parseBoundary(until, true);
  const retained = [];
  let after = null;
  let pagesFetched = 0;
  let consecutiveErrors = 0;
  let hasNext = true;

  while (hasNext && pagesFetched < maxPages) {
    try {
      const page = await fetchPage(after);
      pagesFetched += 1;
      consecutiveErrors = 0;

      const items = Array.isArray(page?.data) ? page.data : [];
      const datedItems = items
        .map((item) => ({ item, timestamp: new Date(item.timestamp) }))
        .filter(({ timestamp }) => !Number.isNaN(timestamp.getTime()));

      for (const { item, timestamp } of datedItems) {
        const inRange =
          (!startDate || timestamp >= startDate) &&
          (!endDate || timestamp <= endDate);
        if (inRange && mediaMatchesContentType(item, contentType)) retained.push(item);
      }

      const oldestTimestamp = datedItems.reduce(
        (oldest, { timestamp }) => (!oldest || timestamp < oldest ? timestamp : oldest),
        null
      );
      const passedRequestedPeriod = Boolean(
        startDate && oldestTimestamp && oldestTimestamp < startDate
      );

      after = page?.paging?.cursors?.after || null;
      hasNext = Boolean(page?.paging?.next && after) && !passedRequestedPeriod;
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) break;
    }
  }

  return {
    mediaItems: retained,
    pagesFetched,
    truncated: hasNext && pagesFetched >= maxPages,
  };
}

export async function fetchAllMedia({ since, until, contentType = "all" } = {}) {
  const igUserId = await getIgUserId();
  const result = await fetchMediaForPeriod({
    since, until, contentType, maxPages: MAX_MEDIA_PAGES_PER_SYNC,
    fetchPage: (after) => metaGet(`/${igUserId}/media`, {
      fields: "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
      limit: 100, after,
    }),
  });
  if (result.truncated) console.warn(`[fetchAllMedia] Stopped at the safe ${MAX_MEDIA_PAGES_PER_SYNC}-page limit.`);
  return result.mediaItems;
}

const classifyInstagramContent = (caption = "") => {
  const text = String(caption || "").toLowerCase();

  const promotionKeywords = [
    "promo",
    "promotion",
    "promosi",
    "discount",
    "diskon",
    "voucher",
    "cashback",
    "special offer",
    "limited offer",
    "limited time",
    "early bird",
    "bundle",
    "sale",
    "free",
    "buy 1 get 1",
    "competition",
    "membership",
    "member",
    "paket",
    "hemat",
  ];

  const isPromotion = promotionKeywords.some((keyword) =>
    text.includes(keyword)
  );

  if (isPromotion) {
    return "content_promotion";
  }

  return "content_advertisement";
};



const MEDIA_INSIGHT_GROUPS = [
  {
    normalizedName: "views",
    candidates: ["views", "impressions", "plays", "video_views"],
  },
  {
    normalizedName: "reach",
    candidates: ["reach"],
  },
  {
    normalizedName: "likes",
    candidates: ["likes"],
  },
  {
    normalizedName: "comments",
    candidates: ["comments"],
  },
  {
    normalizedName: "shares",
    candidates: ["shares"],
  },
  {
    normalizedName: "saved",
    candidates: ["saved"],
  },
  {
    normalizedName: "total_interactions",
    candidates: ["total_interactions", "engagement"],
  },
];

const MEDIA_INSIGHT_METRICS = MEDIA_INSIGHT_GROUPS.map(
  (group) => group.normalizedName
);

export function mediaInsightGroupsFor(media) {
  const productType = String(media?.mediaProductType || "").toUpperCase();
  if (!productType.includes("REEL")) return MEDIA_INSIGHT_GROUPS;

  const reelSourceOverrides = {
    views: "total_views",
    likes: "total_likes",
    comments: "total_comments",
  };

  return MEDIA_INSIGHT_GROUPS.map((group) =>
    reelSourceOverrides[group.normalizedName]
      ? { ...group, candidates: [reelSourceOverrides[group.normalizedName]] }
      : group
  );
}
const MAX_MEDIA_INSIGHTS_PER_SYNC = Number(process.env.META_MAX_MEDIA_INSIGHT_SYNC || 60);
const MAX_INITIAL_MEDIA_INSIGHTS_PER_SYNC = Number(
  process.env.META_MAX_INITIAL_MEDIA_INSIGHT_SYNC || 250
);
const MAX_MEDIA_PAGES_PER_SYNC = Number(process.env.META_MAX_MEDIA_PAGES_PER_SYNC || 25);

// Media persistence, insight normalization, and bounded refresh
export async function saveMediaItems(
  accountId,
  mediaItems,
  { database = prisma } = {}
) {
  const saved = [];
  const existingMedia = await database.instagramMedia.findMany({
    where: { igMediaId: { in: mediaItems.map((item) => item.id) } },
    select: { igMediaId: true },
  });
  const existingIds = new Set(existingMedia.map((item) => item.igMediaId));

  for (const item of mediaItems) {
    const contentLabel = classifyInstagramContent(item.caption || "");

    const media = await database.instagramMedia.upsert({
      where: {
        igMediaId: item.id,
      },
      update: {
        caption: item.caption ?? null,
        mediaType: item.media_type ?? null,
        mediaProductType: item.media_product_type ?? null,
        mediaUrl: item.media_url ?? null,
        thumbnailUrl: item.thumbnail_url ?? null,
        permalink: item.permalink ?? null,
        postedAt: item.timestamp ? new Date(item.timestamp) : null,
        rawJson: item,
        contentLabel,
      },
      create: {
        igMediaId: item.id,
        accountId,
        caption: item.caption ?? null,
        mediaType: item.media_type ?? null,
        mediaProductType: item.media_product_type ?? null,
        mediaUrl: item.media_url ?? null,
        thumbnailUrl: item.thumbnail_url ?? null,
        permalink: item.permalink ?? null,
        postedAt: item.timestamp ? new Date(item.timestamp) : null,
        rawJson: item,
        contentLabel,
      },
    });

    saved.push({ ...media, newlyCreated: !existingIds.has(item.id) });
  }

  return saved;
}

async function fetchFirstSupportedMediaMetric(
  igMediaId,
  metricCandidates = [],
  fetchMetric = metaGet
) {
  for (const metricName of metricCandidates) {
    try {
      const response = await fetchMetric(`/${igMediaId}/insights`, {
        metric: metricName,
      });

      if (response?.data?.length) {
        return {
          sourceMetricName: metricName,
          response,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.warn(
        `Metric ${metricName} failed for media ${igMediaId}: ${message}`
      );
    }
  }

  return null;
}

async function upsertMediaInsight({ database, media, group, metric, sourceMetricName, today }) {
  const valueItem = metric.values?.[0];
  const metricValue = valueItem?.value ?? metric.total_value?.value ?? null;
  if (metricValue === null || metricValue === undefined) return 0;
  const numericValue = numberOrNull(metricValue);

  // Empty or malformed responses never erase a previously captured value.
  if (numericValue == null) return 0;

  await database.instagramMediaInsight.upsert({
    where: {
      mediaId_metricName_insightDate_period: {
        mediaId: media.id,
        metricName: group.normalizedName,
        insightDate: today,
        period: metric.period || "lifetime",
      },
    },
    update: {
      metricValue: numericValue,
      rawJson: {
        sourceMetricName: metric.name || sourceMetricName,
        normalizedMetricName: group.normalizedName,
        originalResponse: metric,
      },
    },
    create: {
      mediaId: media.id,
      metricName: group.normalizedName,
      metricValue: numericValue,
      period: metric.period || "lifetime",
      insightDate: today,
      rawJson: {
        sourceMetricName: metric.name || sourceMetricName,
        normalizedMetricName: group.normalizedName,
        originalResponse: metric,
      },
    },
  });

  return 1;
}

export async function saveMediaInsights(
  media,
  { database = prisma, fetchMetric = metaGet, now = new Date() } = {}
) {
  const today = startOfDay(now);
  const mediaInsightGroups = mediaInsightGroupsFor(media);
  let savedCount = 0;
  let combinedResponse = null;

  // The common path is one compatible request per media. If a media product
  // rejects the combined set, fall back to the existing metric-specific
  // compatibility probing so one unsupported metric cannot block the others.
  try {
    combinedResponse = await fetchMetric(`/${media.igMediaId}/insights`, {
      metric: mediaInsightGroups.map((group) => group.candidates[0]).join(","),
    });
  } catch {
    combinedResponse = null;
  }

  const combinedMetrics = Array.isArray(combinedResponse?.data)
    ? combinedResponse.data
    : [];

  for (const group of mediaInsightGroups) {
    const combinedMetric = combinedMetrics.find((metric) =>
      group.candidates.includes(metric?.name)
    );
    const insightResult = combinedMetric
      ? { sourceMetricName: combinedMetric.name, response: { data: [combinedMetric] } }
      : await fetchFirstSupportedMediaMetric(media.igMediaId, group.candidates, fetchMetric);

    if (!insightResult?.response?.data?.length) {
      continue;
    }

    for (const metric of insightResult.response.data) {
      savedCount += await upsertMediaInsight({
        database,
        media,
        group,
        metric,
        sourceMetricName: insightResult.sourceMetricName,
        today,
      });
    }
  }

  return savedCount;
}

export async function selectStoredMediaRefreshBatch({
  now,
  mode,
  discoveredMediaIds = [],
  newMediaIds = [],
}) {
  const end = new Date(now);
  const historyStart = new Date(end);
  historyStart.setUTCMonth(historyStart.getUTCMonth() - META_HISTORY_MONTHS);

  const [eligibleMedia, syncAttemptCount] = await Promise.all([
    prisma.instagramMedia.findMany({
      where: {
        postedAt: { gte: historyStart, lte: end },
      },
      select: {
        id: true,
        igMediaId: true,
        postedAt: true,
        mediaType: true,
        mediaProductType: true,
        insights: {
          where: { metricName: { in: MEDIA_INSIGHT_METRICS } },
          select: { insightDate: true, updatedAt: true },
        },
      },
    }),
    prisma.metaSyncLog.count(),
  ]);

  return composeStoredMediaRefreshBatch({
    eligibleMedia,
    mode,
    discoveredMediaIds,
    newMediaIds,
    syncAttemptCount,
  });
}

export function composeStoredMediaRefreshBatch({
  eligibleMedia,
  mode,
  discoveredMediaIds = [],
  newMediaIds = [],
  syncAttemptCount = 0,
}) {
  const limits = {
    initialLimit: MAX_INITIAL_MEDIA_INSIGHTS_PER_SYNC,
    incrementalLimit: MAX_MEDIA_INSIGHTS_PER_SYNC,
  };
  if (mode === "initial") {
    return selectStoredMediaForInsightRefresh(eligibleMedia, mode, limits);
  }

  const discoveredIds = new Set(discoveredMediaIds);
  const newIds = new Set(newMediaIds);
  const newlyDiscovered = eligibleMedia.filter(
    (media) => newIds.has(media.id) && media.insights.length === 0
  );
  const newPriority = selectStoredMediaForInsightRefresh(newlyDiscovered, mode, limits);
  const newPriorityIds = new Set(newPriority.map((media) => media.id));
  const recentPriorityLimit = Math.min(
    Math.ceil(MAX_MEDIA_INSIGHTS_PER_SYNC / 2),
    Math.max(0, MAX_MEDIA_INSIGHTS_PER_SYNC - newPriority.length)
  );
  const recentPriority = selectStoredMediaForInsightRefresh(
    eligibleMedia.filter(
      (media) => discoveredIds.has(media.id) && !newPriorityIds.has(media.id)
    ),
    mode,
    { ...limits, incrementalLimit: recentPriorityLimit }
  );
  const priority = [...newPriority, ...recentPriority];
  const priorityIds = new Set(priority.map((media) => media.id));
  const remainingPool = eligibleMedia.filter((media) => !priorityIds.has(media.id));
  const remainingLimit = Math.max(0, MAX_MEDIA_INSIGHTS_PER_SYNC - priority.length);

  // Media that already carry insights refresh strictly stale-first (oldest
  // successful refresh first) so the oldest data is always replaced before
  // anything newer, without a rotation offset that could skip it.
  const withoutInsights = remainingPool.filter((media) => media.insights.length === 0);
  const withInsights = remainingPool.filter((media) => media.insights.length > 0);
  const staleLimit = Math.min(remainingLimit, withInsights.length);
  const stale = selectStoredMediaForInsightRefresh(withInsights, mode, {
    ...limits,
    incrementalLimit: staleLimit,
  });

  // Media with no insight row yet rotate so one permanently unsupported post
  // cannot keep starving the rest of the warehouse.
  const rotatingLimit = Math.max(0, remainingLimit - stale.length);
  const rotating = selectStoredMediaForInsightRefresh(withoutInsights, mode, {
    ...limits,
    incrementalLimit: rotatingLimit,
    rotation: syncAttemptCount,
  });

  return [...priority, ...stale, ...rotating];
}

// Canonical monthly media aggregation
function getMonthStart(dateInput) {
  const date = new Date(dateInput);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function getMediaContentTypes(media) {
  const productType = String(media.mediaProductType || "").toUpperCase();
  const mediaType = String(media.mediaType || "").toUpperCase();

  if (
    productType.includes("REELS") ||
    productType.includes("REEL") ||
    mediaType.includes("VIDEO")
  ) {
    return ["all", "reels"];
  }

  if (
    productType.includes("FEED") ||
    mediaType.includes("IMAGE") ||
    mediaType.includes("CAROUSEL")
  ) {
    return ["all", "feed"];
  }

  return ["all"];
}

function getLatestInsightValue(insights = [], metricNames = []) {
  const matchedInsights = insights
    .filter((insight) => metricNames.includes(insight.metricName))
    .sort((a, b) => new Date(b.insightDate) - new Date(a.insightDate));

  if (!matchedInsights.length) return 0;

  return Number(matchedInsights[0].metricValue || 0);
}

export async function rebuildMonthlyMediaPerformance(accountId) {
  const mediaRows = await prisma.instagramMedia.findMany({
    where: {
      accountId,
      postedAt: {
        not: null,
      },
    },
    include: {
      insights: true,
    },
    orderBy: {
      postedAt: "asc",
    },
  });

  const monthMap = new Map();

  for (const media of mediaRows) {
    if (!media.postedAt) continue;

    const month = getMonthStart(media.postedAt);
    const monthKey = month.toISOString().slice(0, 10);

    const views = getLatestInsightValue(media.insights, [
      "views",
      "impressions",
      "plays",
    ]);

    const reach = getLatestInsightValue(media.insights, ["reach"]);
    const rawMedia = media.rawJson || {};

const likes =
  getLatestInsightValue(media.insights, ["likes"]) ||
  Number(rawMedia.like_count || 0);

const comments =
  getLatestInsightValue(media.insights, ["comments"]) ||
  Number(rawMedia.comments_count || 0);
    
    const shares = getLatestInsightValue(media.insights, ["shares"]);
    const saved = getLatestInsightValue(media.insights, ["saved"]);

    const totalInteractions =
      getLatestInsightValue(media.insights, ["total_interactions"]) ||
      likes + comments + shares + saved;

    const contentTypes = getMediaContentTypes(media);

    for (const contentType of contentTypes) {
      const key = `${monthKey}-${contentType}`;

      const existing = monthMap.get(key) || {
        month,
        contentType,
        views: 0,
        reach: 0,
        interactions: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        contentCount: 0,
      };

      existing.views += views;
      existing.reach += reach;
      existing.interactions += totalInteractions;
      existing.likes += likes;
      existing.comments += comments;
      existing.shares += shares;
      existing.saved += saved;
      existing.contentCount += 1;

      monthMap.set(key, existing);
    }
  }

  const monthlyRows = Array.from(monthMap.values());

  for (const row of monthlyRows) {
    await prisma.instagramMonthlyMediaPerformance.upsert({
      where: {
        accountId_month_contentType: {
          accountId,
          month: row.month,
          contentType: row.contentType,
        },
      },
      update: {
        views: row.views,
        viewsFromFollowers: 0,
        viewsFromNonFollowers: 0,
        reach: row.reach,
        reachFromFollowers: 0,
        reachFromNonFollowers: 0,
        interactions: row.interactions,
        interactionsFromFollowers: 0,
        interactionsFromNonFollowers: 0,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        saved: row.saved,
        contentCount: row.contentCount,
        rawJson: {
          source: "media_lifetime_insights_grouped_by_posting_month",
          meaning:
            "Aggregated latest lifetime media insights based on the month each media was posted.",
        },
      },
      create: {
        accountId,
        month: row.month,
        contentType: row.contentType,
        views: row.views,
        viewsFromFollowers: 0,
        viewsFromNonFollowers: 0,
        reach: row.reach,
        reachFromFollowers: 0,
        reachFromNonFollowers: 0,
        interactions: row.interactions,
        interactionsFromFollowers: 0,
        interactionsFromNonFollowers: 0,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        saved: row.saved,
        contentCount: row.contentCount,
        rawJson: {
          source: "media_lifetime_insights_grouped_by_posting_month",
          meaning:
            "Aggregated latest lifetime media insights based on the month each media was posted.",
        },
      },
    });
  }

  return monthlyRows.length;

}
