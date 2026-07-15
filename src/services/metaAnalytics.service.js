import { prisma } from "../config/prisma.js";
import { buildConfigSnapshot } from "./appConfig.service.js";
import { metaGet } from "./metaRaw.service.js";

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

async function getIgUserId() {
  const config = await buildConfigSnapshot();
  return config.metaIgUserId || process.env.META_IG_USER_ID || "";
}

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
const MAX_MEDIA_INSIGHTS_PER_SYNC = Number(process.env.META_MAX_MEDIA_INSIGHT_SYNC || 12);
const STALE_SYNC_MINUTES = Number(process.env.META_STALE_SYNC_MINUTES || 15);

function startOfDay(dateInput = new Date()) {
  const date = new Date(dateInput);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function dateString(dateInput = new Date()) {
  return new Date(dateInput).toISOString().slice(0, 10);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function saveAccountProfile() {
  const igUserId = await getIgUserId();
  const accountData = await metaGet(`/${igUserId}`, {
    fields: "id,username,name,followers_count,follows_count,media_count",
  });

  const account = await prisma.instagramAccount.upsert({
    where: {
      igUserId: accountData.id,
    },
    update: {
      username: accountData.username ?? null,
      name: accountData.name ?? null,
      followersCount: accountData.followers_count ?? null,
      followsCount: accountData.follows_count ?? null,
      mediaCount: accountData.media_count ?? null,
      rawJson: accountData,
    },
    create: {
      igUserId: accountData.id,
      username: accountData.username ?? null,
      name: accountData.name ?? null,
      followersCount: accountData.followers_count ?? null,
      followsCount: accountData.follows_count ?? null,
      mediaCount: accountData.media_count ?? null,
      rawJson: accountData,
    },
  });

 

const snapshotDate = new Date()
snapshotDate.setUTCDate(1)
snapshotDate.setUTCHours(0, 0, 0, 0)

await prisma.instagramAccountSnapshot.upsert({
  where: {
    accountId_snapshotDate: {
      accountId: account.id,
      snapshotDate,
    },
  },
  update: {
    followersCount: Number(accountData.followers_count || 0),
    followsCount: Number(accountData.follows_count || 0),
    mediaCount: Number(accountData.media_count || 0),
    rawJson: {
      ...accountData,
      snapshotType: "monthly",
      source: "meta_current_followers_count",
    },
  },
  create: {
    accountId: account.id,
    followersCount: Number(accountData.followers_count || 0),
    followsCount: Number(accountData.follows_count || 0),
    mediaCount: Number(accountData.media_count || 0),
    snapshotDate,
    rawJson: {
      ...accountData,
      snapshotType: "monthly",
      source: "meta_current_followers_count",
    },
  },
})

  return account;
}

async function fetchAllMedia() {
  const igUserId = await getIgUserId();
  const mediaItems = [];
  let after = null;
  let hasNext = true;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  while (hasNext) {
    try {
      const data = await metaGet(`/${igUserId}/media`, {
        fields:
    "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
        limit: 100,
        after,
      });

      mediaItems.push(...(data.data || []));
      consecutiveErrors = 0;

      after = data.paging?.cursors?.after || null;
      hasNext = Boolean(data.paging?.next && after);
    } catch (error) {
      consecutiveErrors++;
      console.warn(`[fetchAllMedia] Error fetching page: ${error.message} (consecutive errors: ${consecutiveErrors})`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[fetchAllMedia] Stopping after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Returning ${mediaItems.length} items fetched so far.`);
        break;
      }

      hasNext = true;
    }
  }

  return mediaItems;
}

async function saveMediaItems(accountId, mediaItems) {
  const saved = [];

  for (const item of mediaItems) {
    const contentLabel = classifyInstagramContent(item.caption || "");

    const media = await prisma.instagramMedia.upsert({
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

    saved.push(media);
  }

  return saved;
}

async function fetchFirstSupportedMediaMetric(igMediaId, metricCandidates = []) {
  for (const metricName of metricCandidates) {
    try {
      const response = await metaGet(`/${igMediaId}/insights`, {
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

async function saveMediaInsights(media) {
  const today = startOfDay();

  const existingMetrics = await prisma.instagramMediaInsight.findMany({
    where: {
      mediaId: media.id,
      insightDate: today,
      metricName: {
        in: MEDIA_INSIGHT_METRICS,
      },
    },
    select: {
      metricName: true,
    },
  });

  const existingMetricNames = new Set(
    existingMetrics.map((metric) => metric.metricName)
  );

  const pendingGroups = MEDIA_INSIGHT_GROUPS.filter(
    (group) => !existingMetricNames.has(group.normalizedName)
  );

  let savedCount = 0;

  for (const group of pendingGroups) {
    const insightResult = await fetchFirstSupportedMediaMetric(
      media.igMediaId,
      group.candidates
    );

    if (!insightResult?.response?.data?.length) {
      continue;
    }

    for (const metric of insightResult.response.data) {
      const valueItem = metric.values?.[0];

      const metricValue =
        valueItem?.value ??
        metric.total_value?.value ??
        null;

      await prisma.instagramMediaInsight.upsert({
        where: {
          mediaId_metricName_insightDate_period: {
            mediaId: media.id,
            metricName: group.normalizedName,
            insightDate: today,
            period: metric.period || "lifetime",
          },
        },
        update: {
          metricValue: numberOrNull(metricValue),
          rawJson: {
            sourceMetricName: metric.name || insightResult.sourceMetricName,
            normalizedMetricName: group.normalizedName,
            originalResponse: metric,
          },
        },
        create: {
          mediaId: media.id,
          metricName: group.normalizedName,
          metricValue: numberOrNull(metricValue),
          period: metric.period || "lifetime",
          insightDate: today,
          rawJson: {
            sourceMetricName: metric.name || insightResult.sourceMetricName,
            normalizedMetricName: group.normalizedName,
            originalResponse: metric,
          },
        },
      });

      savedCount++;
    }
  }

  return savedCount;
}
async function saveAccountInsightValues(accountId, insightResponse) {
  let savedCount = 0;

  for (const metric of insightResponse.data || []) {
    if (Array.isArray(metric.values)) {
      for (const valueItem of metric.values) {
        const insightDate = valueItem.end_time
          ? startOfDay(valueItem.end_time)
          : startOfDay();

        await prisma.instagramAccountInsight.upsert({
          where: {
            accountId_metricName_insightDate_period: {
              accountId,
              metricName: metric.name,
              insightDate,
              period: metric.period || "day",
            },
          },
          update: {
            metricValue: numberOrNull(valueItem.value),
            rawJson: valueItem,
          },
          create: {
            accountId,
            metricName: metric.name,
            metricValue: numberOrNull(valueItem.value),
            period: metric.period || "day",
            insightDate,
            rawJson: valueItem,
          },
        });

        savedCount++;
      }
    }

    if (metric.total_value?.value !== undefined) {
      const insightDate = startOfDay();

      await prisma.instagramAccountInsight.upsert({
        where: {
          accountId_metricName_insightDate_period: {
            accountId,
            metricName: metric.name,
            insightDate,
            period: metric.period || "day",
          },
        },
        update: {
          metricValue: numberOrNull(metric.total_value.value),
          rawJson: metric.total_value,
        },
        create: {
          accountId,
          metricName: metric.name,
          metricValue: numberOrNull(metric.total_value.value),
          period: metric.period || "day",
          insightDate,
          rawJson: metric.total_value,
        },
      });

      savedCount++;
    }
  }

  return savedCount;
}

async function syncAccountInsights(accountId, since, until) {
  const igUserId = await getIgUserId();
  let savedCount = 0;

  const insightRequests = [
    {
      label: "reach",
      params: {
        metric: "reach",
        period: "day",
        since,
        until,
      },
    },
    
    {
      label: "total_interactions",
      params: {
        metric: "total_interactions",
        period: "day",
        metric_type: "total_value",
        since,
        until,
      },
    },
    {
      label: "accounts_engaged",
      params: {
        metric: "accounts_engaged",
        period: "day",
        metric_type: "total_value",
        since,
        until,
      },
    },
  ];

  for (const request of insightRequests) {
    try {
      const data = await metaGet(`/${igUserId}/insights`, request.params);
      savedCount += await saveAccountInsightValues(accountId, data);
    } catch (error) {
      console.warn(
        `Account metric ${request.label} failed for ${since} - ${until}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return savedCount;
}

async function syncAccountInsightsInChunks(accountId, since, until) {
  const chunks = buildDateChunks(since, until, 28);

  let totalSavedCount = 0;

  for (const chunk of chunks) {
    console.log("SYNC ACCOUNT INSIGHT CHUNK:", chunk);

    totalSavedCount += await syncAccountInsights(
      accountId,
      chunk.since,
      chunk.until
    );
  }

  return totalSavedCount;
}

async function syncAudienceInsights(accountId) {
  const igUserId = await getIgUserId();
  const today = startOfDay()

  const breakdownTypes = ["age", "gender", "city", "country"]

  let savedCount = 0

  for (const breakdownName of breakdownTypes) {
    try {
      const data = await metaGet("/" + igUserId + "/insights", {
        metric: "follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        breakdown: breakdownName,
      })

      console.log(
        `META AUDIENCE RESPONSE ${breakdownName}:`,
        JSON.stringify(data, null, 2)
      )

      for (const metric of data.data || []) {
        const breakdowns = metric.total_value?.breakdowns || []

        for (const breakdown of breakdowns) {
          const results = breakdown.results || []

          for (const result of results) {
            const breakdownValue =
              result.dimension_values?.[0] ??
              result.dimension_value ??
              result.name ??
              null

            const metricValue =
              result.value?.value ??
              result.value ??
              result.metric_value ??
              null

            if (!breakdownValue) continue

            await prisma.instagramAudienceInsight.upsert({
              where: {
                accountId_metricName_breakdownType_breakdownValue_insightDate_period: {
                  accountId,
                  metricName: metric.name || "follower_demographics",
                  breakdownType: breakdownName,
                  breakdownValue: String(breakdownValue),
                  insightDate: today,
                  period: metric.period || "lifetime",
                },
              },
              update: {
                metricValue: numberOrNull(metricValue),
                rawJson: result,
              },
              create: {
                accountId,
                metricName: metric.name || "follower_demographics",
                breakdownType: breakdownName,
                breakdownValue: String(breakdownValue),
                metricValue: numberOrNull(metricValue),
                period: metric.period || "lifetime",
                insightDate: today,
                rawJson: result,
              },
            })

            savedCount++
          }
        }
      }
    } catch (error) {
      console.warn(
        "Audience metric follower_demographics (" +
          breakdownName +
          ") failed:",
        error instanceof Error ? error.message : error
      )
    }
  }

  return savedCount
}
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

async function rebuildMonthlyMediaPerformance(accountId) {
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
        reach: row.reach,
        interactions: row.interactions,
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
        reach: row.reach,
        interactions: row.interactions,
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

async function rebuildMonthlyViewsBreakdown(accountId, since, until) {
  const start = new Date(since);
  const end = new Date(until);

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();

  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();

  let currentYear = startYear;
  let currentMonth = startMonth;

  let updatedCount = 0;

  while (
    currentYear < endYear ||
    (currentYear === endYear && currentMonth <= endMonth)
  ) {
    const monthRange = getMonthRange(currentYear, currentMonth);

    const breakdown = await fetchViewsBreakdownForMonth(
      monthRange.since,
      monthRange.until
    );

    const viewsFromFollowers = Number(breakdown.viewsFromFollowers || 0);
    const viewsFromNonFollowers = Number(breakdown.viewsFromNonFollowers || 0);

    const breakdownTotalViews = viewsFromFollowers + viewsFromNonFollowers;
    const hasBreakdownData = breakdownTotalViews > 0;

    const existingMonthlyRow =
      await prisma.instagramMonthlyMediaPerformance.findUnique({
        where: {
          accountId_month_contentType: {
            accountId,
            month: monthRange.startDate,
            contentType: "all",
          },
        },
      });

    const currentExistingViews = Number(existingMonthlyRow?.views || 0);

    await prisma.instagramMonthlyMediaPerformance.upsert({
      where: {
        accountId_month_contentType: {
          accountId,
          month: monthRange.startDate,
          contentType: "all",
        },
      },
      update: {
        views: hasBreakdownData ? breakdownTotalViews : currentExistingViews,
        viewsFromFollowers: hasBreakdownData ? viewsFromFollowers : 0,
        viewsFromNonFollowers: hasBreakdownData ? viewsFromNonFollowers : 0,
        rawJson: {
          source: "monthly_views_follow_type_breakdown",
          since: monthRange.since,
          until: monthRange.until,
          hasBreakdownData,
          originalResponse: breakdown.rawJson,
        },
      },
      create: {
        accountId,
        month: monthRange.startDate,
        contentType: "all",
        views: hasBreakdownData ? breakdownTotalViews : 0,
        reach: 0,
        interactions: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        contentCount: 0,
        viewsFromFollowers: hasBreakdownData ? viewsFromFollowers : 0,
        viewsFromNonFollowers: hasBreakdownData ? viewsFromNonFollowers : 0,
        rawJson: {
          source: "monthly_views_follow_type_breakdown",
          since: monthRange.since,
          until: monthRange.until,
          hasBreakdownData,
          originalResponse: breakdown.rawJson,
        },
      },
    });

    updatedCount++;

    currentMonth++;

    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
  }

  return updatedCount;
}

async function rebuildMonthlyReachBreakdown(accountId, since, until) {
  const start = new Date(since);
  const end = new Date(until);

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();

  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();

  let currentYear = startYear;
  let currentMonth = startMonth;

  let updatedCount = 0;

  while (
    currentYear < endYear ||
    (currentYear === endYear && currentMonth <= endMonth)
  ) {
    const monthRange = getMonthRange(currentYear, currentMonth);

    const breakdown = await fetchReachBreakdownForMonth(
      monthRange.since,
      monthRange.until
    );

    const reachFromFollowers = Number(breakdown.reachFromFollowers || 0);
    const reachFromNonFollowers = Number(breakdown.reachFromNonFollowers || 0);

    const breakdownTotalReach = reachFromFollowers + reachFromNonFollowers;
    const hasBreakdownData = breakdownTotalReach > 0;

    const existingMonthlyRow =
      await prisma.instagramMonthlyMediaPerformance.findUnique({
        where: {
          accountId_month_contentType: {
            accountId,
            month: monthRange.startDate,
            contentType: "all",
          },
        },
      });

    const currentExistingReach = Number(existingMonthlyRow?.reach || 0);

    await prisma.instagramMonthlyMediaPerformance.upsert({
      where: {
        accountId_month_contentType: {
          accountId,
          month: monthRange.startDate,
          contentType: "all",
        },
      },
      update: {
        reach: hasBreakdownData ? breakdownTotalReach : currentExistingReach,
        reachFromFollowers: hasBreakdownData ? reachFromFollowers : 0,
        reachFromNonFollowers: hasBreakdownData ? reachFromNonFollowers : 0,
        rawJson: {
          ...(existingMonthlyRow?.rawJson || {}),
          reachBreakdown: {
            source: "monthly_reach_follow_type_breakdown",
            since: monthRange.since,
            until: monthRange.until,
            hasBreakdownData,
            originalResponse: breakdown.rawJson,
          },
        },
      },
      create: {
        accountId,
        month: monthRange.startDate,
        contentType: "all",
        views: 0,
        reach: hasBreakdownData ? breakdownTotalReach : 0,
        interactions: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        contentCount: 0,
        reachFromFollowers: hasBreakdownData ? reachFromFollowers : 0,
        reachFromNonFollowers: hasBreakdownData ? reachFromNonFollowers : 0,
        rawJson: {
          reachBreakdown: {
            source: "monthly_reach_follow_type_breakdown",
            since: monthRange.since,
            until: monthRange.until,
            hasBreakdownData,
            originalResponse: breakdown.rawJson,
          },
        },
      },
    });

    updatedCount++;

    currentMonth++;

    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
  }

  return updatedCount;
}

async function rebuildMonthlyInteractionsBreakdown(accountId, since, until) {
  const start = new Date(since);
  const end = new Date(until);

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();

  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();

  let currentYear = startYear;
  let currentMonth = startMonth;

  let updatedCount = 0;

  while (
    currentYear < endYear ||
    (currentYear === endYear && currentMonth <= endMonth)
  ) {
    const monthRange = getMonthRange(currentYear, currentMonth);

    const breakdown = await fetchInteractionsBreakdownForMonth(
      monthRange.since,
      monthRange.until
    );

    const interactionsFromFollowers = Number(
      breakdown.interactionsFromFollowers || 0
    );

    const interactionsFromNonFollowers = Number(
      breakdown.interactionsFromNonFollowers || 0
    );

    const breakdownTotalInteractions =
      interactionsFromFollowers + interactionsFromNonFollowers;

    const hasBreakdownData = breakdownTotalInteractions > 0;

    const existingMonthlyRow =
      await prisma.instagramMonthlyMediaPerformance.findUnique({
        where: {
          accountId_month_contentType: {
            accountId,
            month: monthRange.startDate,
            contentType: "all",
          },
        },
      });

    const currentExistingInteractions = Number(
      existingMonthlyRow?.interactions || 0
    );

    await prisma.instagramMonthlyMediaPerformance.upsert({
      where: {
        accountId_month_contentType: {
          accountId,
          month: monthRange.startDate,
          contentType: "all",
        },
      },
      update: {
        interactions: hasBreakdownData
          ? breakdownTotalInteractions
          : currentExistingInteractions,
        interactionsFromFollowers: hasBreakdownData
          ? interactionsFromFollowers
          : 0,
        interactionsFromNonFollowers: hasBreakdownData
          ? interactionsFromNonFollowers
          : 0,
        rawJson: {
          ...(existingMonthlyRow?.rawJson || {}),
          interactionsBreakdown: {
            source: "monthly_interactions_follow_type_breakdown",
            since: monthRange.since,
            until: monthRange.until,
            hasBreakdownData,
            originalResponse: breakdown.rawJson,
          },
        },
      },
      create: {
        accountId,
        month: monthRange.startDate,
        contentType: "all",
        views: 0,
        reach: 0,
        interactions: hasBreakdownData ? breakdownTotalInteractions : 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        contentCount: 0,
        interactionsFromFollowers: hasBreakdownData
          ? interactionsFromFollowers
          : 0,
        interactionsFromNonFollowers: hasBreakdownData
          ? interactionsFromNonFollowers
          : 0,
        rawJson: {
          interactionsBreakdown: {
            source: "monthly_interactions_follow_type_breakdown",
            since: monthRange.since,
            until: monthRange.until,
            hasBreakdownData,
            originalResponse: breakdown.rawJson,
          },
        },
      },
    });

    updatedCount++;

    currentMonth++;

    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
  }

  return updatedCount;
}

async function syncViewsBreakdownInsights(accountId, since, until) {
  const igUserId = await getIgUserId();
  let savedCount = 0;
  const chunks = buildDateChunks(since, until, 28);

  for (const chunk of chunks) {
    let response = null;

    try {
      response = await metaGet(`/${igUserId}/insights`, {
        metric: "views",
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: chunk.since,
        until: chunk.until,
      });
      } catch (err1) {
        console.warn(
          `Views follow_type breakdown failed for ${chunk.since} - ${chunk.until}:`,
          err1 instanceof Error ? err1.message : err1
        );
        continue;
      }

    const insightDate = startOfDay(chunk.until);

    for (const metric of response?.data || []) {
      const breakdowns = metric.total_value?.breakdowns || [];

      for (const breakdown of breakdowns) {
        const results = breakdown.results || [];

        for (const result of results) {
          const breakdownValue =
            result.dimension_values?.[0] ??
            result.dimension_value ??
            result.name ??
            null;

          const metricValue =
            result.value?.value ??
            result.value ??
            result.metric_value ??
            null;

          if (!breakdownValue) continue;

          const normalizedBreakdown = String(breakdownValue).toLowerCase();

          const metricName =
            normalizedBreakdown.includes("follower") &&
            !normalizedBreakdown.includes("non")
              ? "views_from_followers"
              : normalizedBreakdown.includes("non")
                ? "views_from_non_followers"
                : `views_${normalizedBreakdown.replace(/\s+/g, "_")}`;

          await prisma.instagramAccountInsight.upsert({
            where: {
              accountId_metricName_insightDate_period: {
                accountId,
                metricName,
                insightDate,
                period: "total_value",
              },
            },
            update: {
              metricValue: numberOrNull(metricValue),
              rawJson: {
                source: "meta_views_follow_type_breakdown",
                since: chunk.since,
                until: chunk.until,
                breakdownValue,
                originalResult: result,
                originalMetric: metric,
              },
            },
            create: {
              accountId,
              metricName,
              metricValue: numberOrNull(metricValue),
              period: "total_value",
              insightDate,
              rawJson: {
                source: "meta_views_follow_type_breakdown",
                since: chunk.since,
                until: chunk.until,
                breakdownValue,
                originalResult: result,
                originalMetric: metric,
              },
            },
          });

          savedCount++;
        }
      }
    }
  }

  return savedCount;
}

function getMonthRange(year, monthIndex) {
  const startDate = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59));

  return {
    startDate,
    endDate,
    since: startDate.toISOString().slice(0, 10),
    until: endDate.toISOString().slice(0, 10),
  };
}


async function fetchViewsBreakdownForMonth(since, until) {
  const igUserId = await getIgUserId();
  const chunks = buildDateChunks(since, until, 28);

  let viewsFromFollowers = 0;
  let viewsFromNonFollowers = 0;
  const rawResponses = [];

  for (const chunk of chunks) {
    let response = null;

    try {
  response = await metaGet(`/${igUserId}/insights`, {
    metric: "views",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    since: chunk.since,
    until: chunk.until,
  });
} catch (firstError) {
  const message = firstError instanceof Error ? firstError.message : String(firstError);
  console.warn(
    `Views breakdown failed for ${chunk.since} - ${chunk.until}:`,
    message
  );
  rawResponses.push({
    since: chunk.since,
    until: chunk.until,
    error: message,
  });
  continue;
}

    rawResponses.push({
      since: chunk.since,
      until: chunk.until,
      response,
    });

    for (const metric of response?.data || []) {
      const breakdowns = metric.total_value?.breakdowns || [];

      for (const breakdown of breakdowns) {
        for (const result of breakdown.results || []) {
          const breakdownValue =
            result.dimension_values?.[0] ??
            result.dimension_value ??
            result.name ??
            "";

          const normalized = String(breakdownValue).toLowerCase();

          const rawValue =
            result.value?.value ??
            result.value ??
            result.metric_value ??
            0;

          const value = Number(rawValue || 0);

          if (normalized.includes("non")) {
            viewsFromNonFollowers += value;
          } else if (normalized.includes("follower")) {
            viewsFromFollowers += value;
          }
        }
      }
    }
  }

  return {
    viewsFromFollowers,
    viewsFromNonFollowers,
    rawJson: rawResponses,
  };
}
async function fetchReachBreakdownForMonth(since, until) {
  const igUserId = await getIgUserId();
  const chunks = buildDateChunks(since, until, 28);

  let reachFromFollowers = 0;
  let reachFromNonFollowers = 0;
  const rawResponses = [];

  for (const chunk of chunks) {
    let response = null;

    try {
      response = await metaGet(`/${igUserId}/insights`, {
        metric: "reach",
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: chunk.since,
        until: chunk.until,
      });
    } catch (firstError) {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      console.warn(
        `Reach breakdown failed for ${chunk.since} - ${chunk.until}:`,
        message
      );
      rawResponses.push({
        since: chunk.since,
        until: chunk.until,
        error: message,
      });
      continue;
    }

    rawResponses.push({
      since: chunk.since,
      until: chunk.until,
      response,
    });

    for (const metric of response?.data || []) {
      const breakdowns = metric.total_value?.breakdowns || [];

      for (const breakdown of breakdowns) {
        for (const result of breakdown.results || []) {
          const breakdownValue =
            result.dimension_values?.[0] ??
            result.dimension_value ??
            result.name ??
            "";

          const normalized = String(breakdownValue).toLowerCase();

          const rawValue =
            result.value?.value ??
            result.value ??
            result.metric_value ??
            0;

          const value = Number(rawValue || 0);

          if (normalized.includes("non")) {
            reachFromNonFollowers += value;
          } else if (normalized.includes("follower")) {
            reachFromFollowers += value;
          }
        }
      }
    }
  }

  return {
    reachFromFollowers,
    reachFromNonFollowers,
    rawJson: rawResponses,
  };
}

function extractFollowTypeBreakdown(response) {
  let fromFollowers = 0;
  let fromNonFollowers = 0;
  let hasBreakdown = false;

  for (const metric of response?.data || []) {
    const breakdowns =
      metric.total_value?.breakdowns ||
      metric.breakdowns ||
      [];

    for (const breakdown of breakdowns) {
      const results =
        breakdown.results ||
        breakdown.values ||
        [];

      for (const result of results) {
        const breakdownValue =
          result.dimension_values?.[0] ??
          result.dimensionValues?.[0] ??
          result.dimension_value ??
          result.dimensionValue ??
          result.name ??
          result.title ??
          result.key ??
          "";

        const normalized = String(breakdownValue).toLowerCase();

        const rawValue =
          result.value?.value ??
          result.value ??
          result.metric_value ??
          result.metricValue ??
          result.total_value?.value ??
          result.totalValue?.value ??
          0;

        const value = Number(rawValue || 0);

        if (!Number.isFinite(value)) continue;

        if (
          normalized.includes("non") ||
          normalized.includes("non_follower") ||
          normalized.includes("non-follower")
        ) {
          fromNonFollowers += value;
          hasBreakdown = true;
        } else if (
          normalized.includes("follower") ||
          normalized.includes("followers")
        ) {
          fromFollowers += value;
          hasBreakdown = true;
        }
      }
    }
  }

  return {
    fromFollowers,
    fromNonFollowers,
    hasBreakdown,
  };
}

async function fetchInteractionsBreakdownForMonth(since, until) {
  const igUserId = await getIgUserId();
  const chunks = buildDateChunks(since, until, 28);

  let interactionsFromFollowers = 0;
  let interactionsFromNonFollowers = 0;
  const rawResponses = [];

  const metricCandidates = ["total_interactions", "accounts_engaged"];

  for (const chunk of chunks) {
    let chunkHasBreakdown = false;

    for (const metricName of metricCandidates) {
      const params = {
        metric: metricName,
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: chunk.since,
        until: chunk.until,
      };

      try {
        const response = await metaGet(`/${igUserId}/insights`, params);

        const parsed = extractFollowTypeBreakdown(response);

        rawResponses.push({
          since: chunk.since,
          until: chunk.until,
          usedMetric: metricName,
          usedBreakdownParam: "breakdown",
          hasBreakdown: parsed.hasBreakdown,
          response,
        });

        if (parsed.hasBreakdown) {
          interactionsFromFollowers += parsed.fromFollowers;
          interactionsFromNonFollowers += parsed.fromNonFollowers;
          chunkHasBreakdown = true;
          break;
        }
      } catch (error) {
        rawResponses.push({
          since: chunk.since,
          until: chunk.until,
          usedMetric: metricName,
          usedBreakdownParam: "breakdown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (chunkHasBreakdown) break;
  }

  return {
    interactionsFromFollowers,
    interactionsFromNonFollowers,
    rawJson: rawResponses,
  };
}

function addDays(dateInput, days) {
  const date = new Date(dateInput);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function toDateString(dateInput) {
  return new Date(dateInput).toISOString().slice(0, 10);
}

function buildDateChunks(since, until, maxDays = 28) {
  const chunks = [];

  let currentStart = startOfDay(since);
  const finalEnd = startOfDay(until);

  while (currentStart <= finalEnd) {
    let currentEnd = addDays(currentStart, maxDays);

    if (currentEnd > finalEnd) {
      currentEnd = finalEnd;
    }

    chunks.push({
      since: toDateString(currentStart),
      until: toDateString(currentEnd),
    });

    currentStart = addDays(currentEnd, 1);
  }

  return chunks;
}

async function saveAccountInsightMetric({
  accountId,
  metricName,
  metricValue,
  insightDate,
  period = "total_value",
  rawJson = null,
}) {
  await prisma.instagramAccountInsight.upsert({
    where: {
      accountId_metricName_insightDate_period: {
        accountId,
        metricName,
        insightDate,
        period,
      },
    },
    update: {
      metricValue: numberOrNull(metricValue),
      rawJson,
    },
    create: {
      accountId,
      metricName,
      metricValue: numberOrNull(metricValue),
      period,
      insightDate,
      rawJson,
    },
  });
}

function extractFollowUnfollowBreakdown(response) {
  let follows = 0;
  let unfollows = 0;
  let hasBreakdown = false;

  for (const metric of response?.data || []) {
    const breakdowns = metric.total_value?.breakdowns || [];

    for (const breakdown of breakdowns) {
      for (const result of breakdown.results || []) {
        const breakdownValue =
          result.dimension_values?.[0] ??
          result.dimension_value ??
          result.name ??
          "";

        const normalized = String(breakdownValue).toLowerCase();

        const rawValue =
          result.value?.value ??
          result.value ??
          result.metric_value ??
          0;

        const value = Number(rawValue || 0);

        if (!Number.isFinite(value)) continue;

        if (normalized.includes("unfollow")) {
          unfollows += value;
          hasBreakdown = true;
        } else if (
          normalized === "follow" ||
          normalized === "follower" ||
          normalized.includes("follows")
        ) {
          follows += value;
          hasBreakdown = true;
        }
      }
    }
  }

  return {
    follows,
    unfollows,
    hasBreakdown,
  };
}

async function syncFollowUnfollowInsights(accountId, since, until) {
  const igUserId = await getIgUserId();
  const chunks = buildDateChunks(since, until, 28);
  let savedCount = 0;

  for (const chunk of chunks) {
    const insightDate = startOfDay(chunk.until);

    let parsed = {
      follows: 0,
      unfollows: 0,
      hasBreakdown: false,
    };

    const rawResponses = [];

    try {
      const response = await metaGet(`/${igUserId}/insights`, {
        metric: "follows_and_unfollows",
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: chunk.since,
        until: chunk.until,
      });

      parsed = extractFollowUnfollowBreakdown(response);

      rawResponses.push({
        source: "follows_and_unfollows_breakdown",
        since: chunk.since,
        until: chunk.until,
        hasBreakdown: parsed.hasBreakdown,
        response,
      });
    } catch (error) {
      rawResponses.push({
        source: "follows_and_unfollows_breakdown",
        since: chunk.since,
        until: chunk.until,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!parsed.hasBreakdown) {
      try {
        const followsResponse = await metaGet(`/${igUserId}/insights`, {
          metric: "follows",
          period: "day",
          metric_type: "total_value",
          since: chunk.since,
          until: chunk.until,
        });

        const followsValue =
          followsResponse?.data?.[0]?.total_value?.value ??
          followsResponse?.data?.[0]?.values?.[0]?.value ??
          0;

        parsed.follows = Number(followsValue || 0);

        rawResponses.push({
          source: "follows_metric",
          since: chunk.since,
          until: chunk.until,
          response: followsResponse,
        });
      } catch (error) {
        rawResponses.push({
          source: "follows_metric",
          since: chunk.since,
          until: chunk.until,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const unfollowsResponse = await metaGet(`/${igUserId}/insights`, {
          metric: "unfollows",
          period: "day",
          metric_type: "total_value",
          since: chunk.since,
          until: chunk.until,
        });

        const unfollowsValue =
          unfollowsResponse?.data?.[0]?.total_value?.value ??
          unfollowsResponse?.data?.[0]?.values?.[0]?.value ??
          0;

        parsed.unfollows = Number(unfollowsValue || 0);

        rawResponses.push({
          source: "unfollows_metric",
          since: chunk.since,
          until: chunk.until,
          response: unfollowsResponse,
        });
      } catch (error) {
        rawResponses.push({
          source: "unfollows_metric",
          since: chunk.since,
          until: chunk.until,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await saveAccountInsightMetric({
      accountId,
      metricName: "follows",
      metricValue: parsed.follows,
      insightDate,
      period: "total_value",
      rawJson: {
        since: chunk.since,
        until: chunk.until,
        source: "follow_unfollow_sync",
        rawResponses,
      },
    });

    await saveAccountInsightMetric({
      accountId,
      metricName: "unfollows",
      metricValue: parsed.unfollows,
      insightDate,
      period: "total_value",
      rawJson: {
        since: chunk.since,
        until: chunk.until,
        source: "follow_unfollow_sync",
        rawResponses,
      },
    });

    savedCount += 2;
  }

  return savedCount;
}

async function fetchProfileViewsForRange(since, until) {
  const igUserId = await getIgUserId();
  let profileViews = 0;
  const rawResponses = [];

  try {
    const response = await metaGet(`/${igUserId}/insights`, {
      metric: "profile_views",
      period: "day",
      metric_type: "total_value",
      since,
      until,
    });

    for (const metric of response?.data || []) {
      if (metric.total_value?.value !== undefined) {
        profileViews += Number(metric.total_value.value || 0);
      }

      for (const valueItem of metric.values || []) {
        profileViews += Number(valueItem.value || 0);
      }
    }

    rawResponses.push({
      since,
      until,
      response,
    });
  } catch (error) {
    rawResponses.push({
      since,
      until,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    profileViews,
    rawResponses,
  };
}

async function syncMonthlyProfileViewsInsights(accountId, since, until) {
  const start = new Date(since);
  const end = new Date(until);

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();

  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();

  let currentYear = startYear;
  let currentMonth = startMonth;

  let savedCount = 0;

  while (
    currentYear < endYear ||
    (currentYear === endYear && currentMonth <= endMonth)
  ) {
    const monthRange = getMonthRange(currentYear, currentMonth);

    const chunks = buildDateChunks(monthRange.since, monthRange.until, 28);

    let monthProfileViews = 0;
    const monthRawResponses = [];

    for (const chunk of chunks) {
      const result = await fetchProfileViewsForRange(
        chunk.since,
        chunk.until
      );

      monthProfileViews += Number(result.profileViews || 0);

      monthRawResponses.push({
        since: chunk.since,
        until: chunk.until,
        result,
      });
    }

    await saveAccountInsightMetric({
      accountId,
      metricName: "profile_views",
      metricValue: monthProfileViews,
      insightDate: monthRange.startDate,
      period: "month",
      rawJson: {
        source: "monthly_profile_views_sync",
        since: monthRange.since,
        until: monthRange.until,
        rawResponses: monthRawResponses,
      },
    });

    savedCount++;

    currentMonth++;

    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
  }

  return savedCount;
}

export async function syncMetaRawToAnalytics({ since, until } = {}) {
  const startDate = since || dateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const endDate = until || dateString(new Date());
  const staleStartedBefore = new Date(Date.now() - STALE_SYNC_MINUTES * 60 * 1000);

  await prisma.metaSyncLog.updateMany({
    where: {
      status: "RUNNING",
      finishedAt: null,
      startedAt: { lt: staleStartedBefore },
    },
    data: {
      status: "FAILED",
      message: "Sync was marked failed after becoming stale.",
      finishedAt: new Date(),
    },
  });

  const log = await prisma.metaSyncLog.create({
    data: {
      syncType: "META_RAW_TO_ANALYTICS",
      status: "RUNNING",
    },
  });

  try {
    const account = await saveAccountProfile();

    const mediaItems = await fetchAllMedia();
    const savedMedia = await saveMediaItems(account.id, mediaItems);

    let mediaInsightCount = 0;
    const mediaForInsightSync = savedMedia.slice(0, MAX_MEDIA_INSIGHTS_PER_SYNC);

    for (const media of mediaForInsightSync) {
  mediaInsightCount += await saveMediaInsights(media);
}

const monthlyMediaPerformanceCount = await rebuildMonthlyMediaPerformance(account.id);

const monthlyViewsBreakdownCount = await rebuildMonthlyViewsBreakdown(
  account.id,
  startDate,
  endDate
);

const monthlyReachBreakdownCount = await rebuildMonthlyReachBreakdown(
  account.id,
  startDate,
  endDate
);

const monthlyInteractionsBreakdownCount =
  await rebuildMonthlyInteractionsBreakdown(
    account.id,
    startDate,
    endDate
  );

const accountInsightCount = await syncAccountInsightsInChunks(
  account.id,
  startDate,
  endDate
);

const monthlyProfileViewsInsightCount =
  await syncMonthlyProfileViewsInsights(
    account.id,
    startDate,
    endDate
  );

const followUnfollowInsightCount = await syncFollowUnfollowInsights(
  account.id,
  startDate,
  endDate
);

const viewsBreakdownInsightCount = await syncViewsBreakdownInsights(
  account.id,
  startDate,
  endDate
);
console.log("VIEWS BREAKDOWN COUNT:", viewsBreakdownInsightCount);

    const audienceInsightCount = await syncAudienceInsights(account.id);

    await prisma.metaSyncLog.update({
      where: { id: log.id },
      data: {
        status: "SUCCESS",
        message: `Synced ${savedMedia.length} media, refreshed insights for ${mediaForInsightSync.length} media item(s), ${mediaInsightCount} media insights, ${monthlyMediaPerformanceCount} monthly media performance rows, ${accountInsightCount} account insights, ${audienceInsightCount} audience insights.`,
        finishedAt: new Date(),
      },
    });

    return {
      success: true,
      since: startDate,
      until: endDate,
      mediaCount: savedMedia.length,
      mediaInsightCount,
      mediaInsightLimit: mediaForInsightSync.length,
      monthlyMediaPerformanceCount,
      accountInsightCount,
      audienceInsightCount,
      viewsBreakdownInsightCount,
      monthlyViewsBreakdownCount,
      monthlyReachBreakdownCount,
      monthlyInteractionsBreakdownCount,
      followUnfollowInsightCount,
      monthlyProfileViewsInsightCount,
    };
  } catch (error) {
    await prisma.metaSyncLog.update({
      where: { id: log.id },
      data: {
        status: "FAILED",
        message: error.message,
        finishedAt: new Date(),
      },
    });

    throw error;
  }
}