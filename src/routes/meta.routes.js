import express from "express";

import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.service.js";
import { buildConfigSnapshot } from "../services/appConfig.service.js";
import { syncMetaRawToAnalytics, resolveMetaConnectionStatus, META_HISTORY_MONTHS } from "../services/meta.service.js";
import { createNotificationsForRoles } from "../services/notification.service.js";
import { computeContentPerformance } from "../services/instagramContentPerformance.service.js";
import { buildCampaignAttribution, generateCampaignAttributionInsights } from "../services/campaignAttribution.service.js";
import {
  calculateAvailableChangePct,
  resolveFollowerSnapshot,
} from "../services/followerSnapshot.service.js";
import {
  aggregateHistoricalAccountMetrics,
  buildHistoricalAccountTrend,
  buildHistoricalCoverage,
  HISTORICAL_DASHBOARD_METRICS,
} from "../services/metaHistorical.service.js";

export const metaRouter = express.Router();

const hasMetaCredentials = async () => {
  const config = await buildConfigSnapshot();
  if (!config.metaEnabled) return false;
  return Boolean(config.metaAccessToken) && Boolean(config.metaIgUserId);
};

const testMetaConnection = async () => {
  const config = await buildConfigSnapshot();
  const accessToken = config.metaAccessToken;
  const igUserId = config.metaIgUserId;
  const graphVersion = config.metaGraphVersion;

  if (!config.metaEnabled) {
    return { ok: false, error: "Meta integration is disabled in System Settings." };
  }

  if (!accessToken || !igUserId) {
    return { ok: false, error: "Meta credentials are not configured." };
  }

  try {
    const baseUrl = process.env.META_API_BASE_URL || "https://graph.facebook.com";
    const url = `${baseUrl.replace(/\/$/, "")}/${graphVersion}/${igUserId}?fields=username,followers_count`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      const errorCode = data.error?.code;
      const errorSubcode = data.error?.error_subcode;
      const isTokenExpired = errorCode === 190 && (errorSubcode === 463 || errorSubcode === 467);

      return {
        ok: false,
        error: data.error?.message || `Meta API returned status ${response.status}`,
        tokenExpired: isTokenExpired,
      };
    }

    return { ok: true, username: data.username, tokenExpired: false };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reach Meta API.",
      tokenExpired: false,
    };
  }
};

const buildMetaSetupResponse = () => ({
  success: false,
  errorCode: "META_NOT_CONFIGURED",
  message: "Meta API is not connected yet.",
  suggestion:
    "Please ask IT Support to configure Meta credentials in Settings or environment variables.",
});

const isFullMonthRange = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const lastDayOfStartMonth = new Date(
    start.getFullYear(),
    start.getMonth() + 1,
    0
  ).getDate();

  return (
    start.getDate() === 1 &&
    end.getDate() === lastDayOfStartMonth &&
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear()
  );
};

const isFullYearRange = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);

  return (
    start.getMonth() === 0 &&
    start.getDate() === 1 &&
    end.getMonth() === 11 &&
    end.getDate() === 31 &&
    start.getFullYear() === end.getFullYear()
  );
};

const getPreviousDateRange = (startDate, endDate) => {
  if (isFullMonthRange(startDate, endDate)) {
    const previousStartDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth() - 1,
      1
    );

    const previousEndDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      0,
      23,
      59,
      59,
      999
    );

    return {
      previousStartDate,
      previousEndDate,
    };
  }

  if (isFullYearRange(startDate, endDate)) {
    const previousStartDate = new Date(startDate.getFullYear() - 1, 0, 1);
    const previousEndDate = new Date(
      startDate.getFullYear() - 1,
      11,
      31,
      23,
      59,
      59,
      999
    );

    return {
      previousStartDate,
      previousEndDate,
    };
  }

  const durationMs = endDate.getTime() - startDate.getTime();

  const previousEndDate = new Date(startDate);
  previousEndDate.setMilliseconds(previousEndDate.getMilliseconds() - 1);

  const previousStartDate = new Date(previousEndDate.getTime() - durationMs);

  return {
    previousStartDate,
    previousEndDate,
  };
};

const countCalendarMonths = (startDate, endDate) =>
  Math.max(
    0,
    (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      endDate.getUTCMonth() - startDate.getUTCMonth() + 1
  );

metaRouter.use(authenticate);

metaRouter.get(
  "/status",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const configured = await hasMetaCredentials()

      const syncSelect = {
        id: true,
        status: true,
        message: true,
        startedAt: true,
        finishedAt: true,
      }

      const [latestSync, latestSuccessfulSync] = await Promise.all([
        prisma.metaSyncLog.findFirst({
          orderBy: { startedAt: "desc" },
          select: syncSelect,
        }),

        prisma.metaSyncLog.findFirst({
          where: { status: "SUCCESS" },
          orderBy: { finishedAt: "desc" },
          select: syncSelect,
        }),
      ])

      const {
        connectionState,
        connectionError,
      } = await resolveMetaConnectionStatus({
        configured,
        latestSync,
        testConnection: testMetaConnection,
      })

      let tokenStatus = "unknown"

      if (!configured) {
        tokenStatus = "unknown"
      } else {
        const connectionTest = await testMetaConnection()

        if (connectionTest.ok) {
          tokenStatus = "valid"
        } else if (connectionTest.tokenExpired) {
          tokenStatus = "expired"
        } else {
          tokenStatus = "error"
        }
      }

      return res.json({
        success: true,
        data: {
          configured,
          connectionState,
          tokenStatus,
          latestSync,
          latestSuccessfulSync,

          setupMessage: configured
            ? null
            : buildMetaSetupResponse().message,

          suggestion: configured
            ? connectionError
              ? tokenStatus === "expired"
                ? "The access token has expired. Please generate a new token from Meta Graph API Explorer and update it in System Settings > Integrations."
                : "Meta credentials are configured but the API returned an error. Please verify the access token is valid and not expired."
              : null
            : buildMetaSetupResponse().suggestion,

          connectionError,
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

metaRouter.get(
  "/test-connection",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const configured = await hasMetaCredentials();
      if (!configured) {
        return res.json({
          success: false,
          data: { ok: false, error: "Meta credentials are not configured." },
        });
      }

      const result = await testMetaConnection();
      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

metaRouter.post(
  "/sync",
  authorize("operational", "it_support"),
  async (req, res) => {
    try {
      if (!(await hasMetaCredentials())) {
        return res.status(400).json(buildMetaSetupResponse());
      }

      await logActivity(req, "INSTASIGHT_SYNC_STARTED", {
        status: "started",
      }).catch(() => null);

      const result = await syncMetaRawToAnalytics({ performedByUserId: req.user.userId });

      await logActivity(req, "INSTASIGHT_SYNC_COMPLETED", {
        status: "success",
        ...result,
      });
      await createNotificationsForRoles(prisma, ["operational", "it_support"], {
        title: "InstaSight Sync Completed",
        message: `Meta performance data sync completed successfully (${result.mediaCount} media item(s)).`,
      });

      return res.json({
        success: true,
        message: "InstaSight data synced successfully.",
        data: result,
      });
    } catch (error) {
      const isTokenExpired =
        error instanceof Error &&
        error.message.includes("190") &&
        (error.message.includes("463") || error.message.includes("467"));

      if (isTokenExpired) {
        await createNotificationsForRoles(prisma, ["it_support"], {
          title: "Meta Access Token Expired",
          message:
            "The Meta Graph API access token has expired during sync. Instagram data sync will fail until a new token is generated and configured.",
        }).catch(() => null);
      }

      await logActivity(req, "INSTASIGHT_SYNC_FAILED", {
        status: "failed",
        technicalMessage: error instanceof Error ? error.message : "Meta sync failed.",
      }).catch(() => null);
      await createNotificationsForRoles(prisma, ["operational", "it_support"], {
        title: "InstaSight Sync Failed",
        message: "InstaSight could not sync Meta data.",
      }).catch(() => null);

      return res.status(500).json({
        success: false,
        errorCode: isTokenExpired ? "META_TOKEN_EXPIRED" : "META_SYNC_FAILED",
        message: isTokenExpired
          ? "Meta access token has expired. Please update the token in System Settings."
          : "InstaSight could not sync Meta data.",
        suggestion: isTokenExpired
          ? "Generate a new access token from Meta Graph API Explorer and update it in System Settings > Integrations."
          : "Please check the Meta connection and try again.",
        technicalMessage: error instanceof Error ? error.message : "Meta sync failed.",
      });
    }
  }
);

metaRouter.get(
  ["/dashboard", "/overview"],
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const { since, until, type, contentLabel } = req.query

const startDate = since ? new Date(since) : new Date("2026-05-01")
const endDate = until ? new Date(until) : new Date()
endDate.setHours(23, 59, 59, 999)

const { previousStartDate, previousEndDate } = getPreviousDateRange(startDate, endDate);

const normalizedType = String(type || "all").toLowerCase()
const selectedMonthlyContentType =
  normalizedType === "feed" || normalizedType === "reels"
    ? normalizedType
    : "all";
const normalizedContentLabel = String(contentLabel || "all").toLowerCase();

const contentLabelWhere =
  normalizedContentLabel === "content_promotion" ||
  normalizedContentLabel === "content_advertisement"
    ? { contentLabel: normalizedContentLabel }
    : {};

const mediaTypeWhere =
  normalizedType === "reels"
    ? {
        OR: [
          { mediaProductType: { contains: "REELS" } },
          { mediaProductType: { contains: "REEL" } },
          { mediaType: { contains: "VIDEO" } },
        ],
      }
    : normalizedType === "feed"
      ? {
          OR: [
            { mediaProductType: { contains: "FEED" } },
            { mediaType: { contains: "IMAGE" } },
            { mediaType: { contains: "CAROUSEL_ALBUM" } },
          ],
        }
      : {}

      const latestSync = await prisma.metaSyncLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, status: true, message: true },
      });
      const latestSuccessfulSync = await prisma.metaSyncLog.findFirst({
        where: { status: "SUCCESS" },
        orderBy: { finishedAt: "desc" },
        select: { startedAt: true, finishedAt: true },
      });

  const [latestAccount, media, monthlyMediaPerformanceRows] = await Promise.all([
  prisma.instagramAccount.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
    select: {
      id: true,
      followersCount: true,
      followsCount: true,
      mediaCount: true,
      username: true,
      updatedAt: true,
    },
  }),

  prisma.instagramMedia.findMany({
    where: {
      postedAt: {
        gte: startDate,
        lte: endDate,
      },
      ...mediaTypeWhere,
      ...contentLabelWhere,
    },
    include: {
      insights: true,
    },
    orderBy: {
      postedAt: "desc",
    },
    take: 1000,
  }),

  prisma.instagramMonthlyMediaPerformance.findMany({
    where: {
      month: {
        gte: startDate,
        lte: endDate,
      },
      contentType: selectedMonthlyContentType,
    },
    orderBy: {
      month: "asc",
    },
  }),

]);

const [selectedFollowerSnapshot, latestFollowerSnapshot] = latestAccount?.id
  ? await Promise.all([
      prisma.instagramAccountSnapshot.findFirst({
        where: {
          accountId: latestAccount.id,
          followersCount: { not: null },
          snapshotDate: { gte: startDate, lte: endDate },
        },
        orderBy: { snapshotDate: "desc" },
        select: { followersCount: true, snapshotDate: true },
      }),
      prisma.instagramAccountSnapshot.findFirst({
        where: {
          accountId: latestAccount.id,
          followersCount: { not: null },
        },
        orderBy: { snapshotDate: "desc" },
        select: { followersCount: true, snapshotDate: true },
      }),
    ])
  : [null, null];

const followerSnapshot = resolveFollowerSnapshot({
  selectedPeriodSnapshot: selectedFollowerSnapshot,
  latestSnapshot: latestFollowerSnapshot,
});

const [historicalAccountRows, previousHistoricalAccountRows] = latestAccount?.id
  ? await Promise.all([
      prisma.instagramAccountInsight.findMany({
        where: {
          accountId: latestAccount.id,
          period: "month",
          metricName: { in: HISTORICAL_DASHBOARD_METRICS },
          insightDate: { gte: startDate, lte: endDate },
        },
        orderBy: { insightDate: "asc" },
      }),
      prisma.instagramAccountInsight.findMany({
        where: {
          accountId: latestAccount.id,
          period: "month",
          metricName: { in: HISTORICAL_DASHBOARD_METRICS },
          insightDate: { gte: previousStartDate, lte: previousEndDate },
        },
        orderBy: { insightDate: "asc" },
      }),
    ])
  : [[], []];

const historicalMetrics = aggregateHistoricalAccountMetrics(historicalAccountRows);
const previousHistoricalMetrics = aggregateHistoricalAccountMetrics(
  previousHistoricalAccountRows
);
const historicalMonthlyTrend = buildHistoricalAccountTrend(historicalAccountRows);
const historicalCoverage = buildHistoricalCoverage(
  historicalAccountRows,
  countCalendarMonths(startDate, endDate)
);
const historicalPercent = (part, total) =>
  part == null || total == null || total === 0
    ? null
    : Number(((part / total) * 100).toFixed(1));
const historicalViewsChangePct = calculateAvailableChangePct(
  historicalMetrics.totalViews,
  previousHistoricalMetrics.totalViews
);
const historicalReachChangePct = calculateAvailableChangePct(
  historicalMetrics.totalReach,
  previousHistoricalMetrics.totalReach
);
const historicalInteractionsChangePct = calculateAvailableChangePct(
  historicalMetrics.totalInteractions,
  previousHistoricalMetrics.totalInteractions
);
const historicalProfileViewsChangePct = calculateAvailableChangePct(
  historicalMetrics.totalProfileViews,
  previousHistoricalMetrics.totalProfileViews
);
const historicalEngagementChangePct = calculateAvailableChangePct(
  historicalMetrics.engagementRate,
  previousHistoricalMetrics.engagementRate
);
const historicalProfileVisitChangePct = calculateAvailableChangePct(
  historicalMetrics.profileVisitRate,
  previousHistoricalMetrics.profileVisitRate
);

const monthlyMediaPerformance = monthlyMediaPerformanceRows.reduce(
  (total, row) => ({
    views: total.views + Number(row.views || 0),
    viewsFromFollowers:
      total.viewsFromFollowers + Number(row.viewsFromFollowers || 0),
    viewsFromNonFollowers:
      total.viewsFromNonFollowers + Number(row.viewsFromNonFollowers || 0),

    reach: total.reach + Number(row.reach || 0),
    reachFromFollowers:
      total.reachFromFollowers + Number(row.reachFromFollowers || 0),
    reachFromNonFollowers:
      total.reachFromNonFollowers + Number(row.reachFromNonFollowers || 0),

      interactionsFromFollowers:
  total.interactionsFromFollowers + Number(row.interactionsFromFollowers || 0),
interactionsFromNonFollowers:
  total.interactionsFromNonFollowers + Number(row.interactionsFromNonFollowers || 0),

    interactions: total.interactions + Number(row.interactions || 0),
    likes: total.likes + Number(row.likes || 0),
    comments: total.comments + Number(row.comments || 0),
    shares: total.shares + Number(row.shares || 0),
    saved: total.saved + Number(row.saved || 0),
    contentCount: total.contentCount + Number(row.contentCount || 0),
  }),
  {
    views: 0,
    viewsFromFollowers: 0,
    viewsFromNonFollowers: 0,

    reach: 0,
    reachFromFollowers: 0,
    reachFromNonFollowers: 0,

    interactionsFromFollowers: 0,
interactionsFromNonFollowers: 0,

    interactions: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saved: 0,
    contentCount: 0,
  }
);

const viewsFromFollowersChangePct = 0;
const viewsFromNonFollowersChangePct = 0;
const reachFromFollowersChangePct = 0;
const reachFromNonFollowersChangePct = 0;

      const totalLikes = Number(monthlyMediaPerformance?.likes || 0);
const totalComments = Number(monthlyMediaPerformance?.comments || 0);
const totalShares = Number(monthlyMediaPerformance?.shares || 0);
const totalSaved = Number(monthlyMediaPerformance?.saved || 0);
const interactionsFromFollowersChangePct = 0;
const interactionsFromNonFollowersChangePct = 0;
const mediaReachForRates = Number(monthlyMediaPerformance?.reach || 0);
const shareRate =
  mediaReachForRates > 0
    ? Number(((totalShares / mediaReachForRates) * 100).toFixed(2))
    : 0;

const saveRate =
  mediaReachForRates > 0
    ? Number(((totalSaved / mediaReachForRates) * 100).toFixed(2))
    : 0;

      const currentFollowersCount = followerSnapshot.followerCount;

const followersChangePct = 0;

const currentFollowsCount = Number(latestAccount?.followsCount || 0);

const currentInstagramMediaCount = Number(latestAccount?.mediaCount || 0);




const followerSnapshots = latestAccount?.id
  ? await prisma.instagramAccountSnapshot.findMany({
      where: {
        accountId: latestAccount.id,
        snapshotDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        snapshotDate: "asc",
      },
      select: {
        followersCount: true,
        followsCount: true,
        mediaCount: true,
        snapshotDate: true,
      },
    })
  : []

  const buildMonthlyFollowersTrend = (snapshots = []) => {
  const monthMap = new Map()

  snapshots.forEach((snapshot) => {
    const date = new Date(snapshot.snapshotDate)
    const monthKey = date.toISOString().slice(0, 7)

    const existing = monthMap.get(monthKey)

    if (!existing || new Date(snapshot.snapshotDate) > new Date(existing.snapshotDate)) {
      monthMap.set(monthKey, {
        month: monthKey,
        followersCount: Number(snapshot.followersCount || 0),
        followsCount: Number(snapshot.followsCount || 0),
        mediaCount: Number(snapshot.mediaCount || 0),
        snapshotDate: snapshot.snapshotDate,
      })
    }
  })

  const monthlyRows = Array.from(monthMap.values()).sort((a, b) =>
    a.month.localeCompare(b.month)
  )

  return monthlyRows.map((item, index) => {
    const previous = monthlyRows[index - 1]
    const followersChange = previous
      ? item.followersCount - previous.followersCount
      : 0

    const followersChangePct =
      previous && previous.followersCount > 0
        ? Number(((followersChange / previous.followersCount) * 100).toFixed(1))
        : 0

    return {
      ...item,
      followersChange,
      followersChangePct,
    }
  })
}

const followersTrend = buildMonthlyFollowersTrend(followerSnapshots)

      const trend = historicalMonthlyTrend.map((item) => ({
        ...item,
        date: item.month,
        engagementRate:
          item.interactions == null || item.reach == null
            ? null
            : item.reach > 0
              ? Number(((item.interactions / item.reach) * 100).toFixed(2))
              : 0,
      }));

      const contentPerformance = computeContentPerformance(media);

      const metaInsightRetentionStart = new Date();
      metaInsightRetentionStart.setUTCMonth(
        metaInsightRetentionStart.getUTCMonth() - META_HISTORY_MONTHS
      );
      const mediaWithoutInsights = media.filter(
        (item) => !(Array.isArray(item.insights) && item.insights.length)
      );
      const mediaOutsideInsightRetention = mediaWithoutInsights.filter(
        (item) => item.postedAt && new Date(item.postedAt) < metaInsightRetentionStart
      );
      const contentInsightsAvailability = {
        totalMedia: media.length,
        mediaWithInsights: media.length - mediaWithoutInsights.length,
        mediaWithoutInsights: mediaWithoutInsights.length,
        outsideInsightRetention: mediaOutsideInsightRetention.length,
      };

      const contentList = [...contentPerformance].sort(
  (a, b) =>
    new Date(b.postedAt || 0).getTime() -
    new Date(a.postedAt || 0).getTime()
);

const topContent = [...contentPerformance]
  .filter((item) => item.views !== null)
  .sort((a, b) => b.views - a.views)
  .slice(0, 10);

      const contentMixMap = new Map();
      contentPerformance.forEach((item) => {
        const type = item.mediaProductType || item.mediaType || "Unknown";
        const existing = contentMixMap.get(type) || { type, count: 0, views: 0, reach: 0, interactions: 0 };
        existing.count += 1;
        existing.views += item.views ?? 0;
        existing.reach += item.reach ?? 0;
        existing.interactions += item.interactions;
        contentMixMap.set(type, existing);
      });

      const contentMix = Array.from(contentMixMap.values())
        .map((item) => ({
          ...item,
          engagementRate: item.reach == null ? null : item.reach > 0 ? Number(((item.interactions / item.reach) * 100).toFixed(2)) : 0,
        }))
        .sort((a, b) => b.views - a.views);

        const isContentLabelFiltered =
  normalizedContentLabel === "content_promotion" ||
  normalizedContentLabel === "content_advertisement";

const filteredContentTotals = contentPerformance.reduce(
  (total, item) => ({
    views: total.views + Number(item.views || 0),
    reach: total.reach + Number(item.reach || 0),
    interactions: total.interactions + Number(item.interactions || 0),
    likes: total.likes + Number(item.likes || 0),
    comments: total.comments + Number(item.comments || 0),
    shares: total.shares + Number(item.shares || 0),
    saved: total.saved + Number(item.saved || 0),
    contentCount: total.contentCount + 1,
  }),
  {
    views: 0,
    reach: 0,
    interactions: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saved: 0,
    contentCount: 0,
  }
);


      const topContentType = contentMix[0]?.type || "-";
      const contentInteractionTotal = contentPerformance.reduce((sum, item) => sum + item.interactions, 0);
      const averageInteractionsPerContent = contentPerformance.length
        ? Number((contentInteractionTotal / contentPerformance.length).toFixed(1))
        : 0;


      return res.json({
        success: true,
        data: {
          configured: await hasMetaCredentials(),
          hasData: Boolean(
  media.length || historicalAccountRows.length || monthlyMediaPerformanceRows.length
),
          lastSyncedAt: latestSuccessfulSync?.finishedAt || latestSuccessfulSync?.startedAt || null,
          latestSyncStatus: latestSync?.status || null,
         summary: {
  totalViews: historicalMetrics.totalViews,
  viewsChangePct: historicalViewsChangePct,

  viewsFromFollowers: historicalMetrics.viewsFromFollowers,
  viewsFromFollowersPct: historicalPercent(
    historicalMetrics.viewsFromFollowers,
    historicalMetrics.totalViews
  ),
  viewsFromFollowersChangePct,

  viewsFromNonFollowers: historicalMetrics.viewsFromNonFollowers,
  viewsFromNonFollowersPct: historicalPercent(
    historicalMetrics.viewsFromNonFollowers,
    historicalMetrics.totalViews
  ),
  viewsFromNonFollowersChangePct,

  totalReach: historicalMetrics.totalReach,
  reachChangePct: historicalReachChangePct,

  reachFromFollowers: historicalMetrics.reachFromFollowers,
  reachFromFollowersPct: historicalPercent(
    historicalMetrics.reachFromFollowers,
    historicalMetrics.totalReach
  ),
  reachFromFollowersChangePct,

  reachFromNonFollowers: historicalMetrics.reachFromNonFollowers,
  reachFromNonFollowersPct: historicalPercent(
    historicalMetrics.reachFromNonFollowers,
    historicalMetrics.totalReach
  ),
  reachFromNonFollowersChangePct,

  totalProfileViews: historicalMetrics.totalProfileViews,
  profileViewsChangePct: historicalProfileViewsChangePct,
totalInteractions: historicalMetrics.totalInteractions,
totalLikes: isContentLabelFiltered ? filteredContentTotals.likes : totalLikes,
totalComments: isContentLabelFiltered
  ? filteredContentTotals.comments
  : totalComments,
totalShares: isContentLabelFiltered ? filteredContentTotals.shares : totalShares,
totalSaved: isContentLabelFiltered ? filteredContentTotals.saved : totalSaved,
engagementRate: historicalMetrics.engagementRate,
engagementRateChangePct: historicalEngagementChangePct,

shareRate: isContentLabelFiltered
  ? filteredContentTotals.reach > 0
    ? Number(((filteredContentTotals.shares / filteredContentTotals.reach) * 100).toFixed(2))
    : 0
  : shareRate,

saveRate: isContentLabelFiltered
  ? filteredContentTotals.reach > 0
    ? Number(((filteredContentTotals.saved / filteredContentTotals.reach) * 100).toFixed(2))
    : 0
  : saveRate,

profileVisitRate: historicalMetrics.profileVisitRate,
profileVisitRateChangePct: historicalProfileVisitChangePct,

averageInteractionsPerContent,

interactionsChangePct: historicalInteractionsChangePct,
interactionsFromFollowersChangePct,

interactionsFromNonFollowers: null,
interactionsFromNonFollowersChangePct,

contentCount: isContentLabelFiltered
  ? filteredContentTotals.contentCount
  : Number(monthlyMediaPerformance?.contentCount || contentPerformance.length),
topContentType,

followersCount: currentFollowersCount,
followersChangePct,
followerSnapshotDate: followerSnapshot.snapshotDate,
followerSnapshotSource: followerSnapshot.snapshotSource,
hasSelectedPeriodFollowerSnapshot: followerSnapshot.hasSelectedPeriodSnapshot,

newFollowsCount: historicalMetrics.newFollowsCount,
newFollowsChangePct: calculateAvailableChangePct(
  historicalMetrics.newFollowsCount,
  previousHistoricalMetrics.newFollowsCount
),

unfollowsCount: historicalMetrics.unfollowsCount,
unfollowsChangePct: calculateAvailableChangePct(
  historicalMetrics.unfollowsCount,
  previousHistoricalMetrics.unfollowsCount
),

followsCount: currentFollowsCount,
instagramMediaCount: currentInstagramMediaCount,
instagramUsername: latestAccount?.username || null,

availability: {
  views: historicalMetrics.totalViews != null,
  viewsBreakdown:
    historicalMetrics.viewsFromFollowers != null &&
    historicalMetrics.viewsFromNonFollowers != null,
  reach: historicalMetrics.totalReach != null,
  reachBreakdown:
    historicalMetrics.reachFromFollowers != null &&
    historicalMetrics.reachFromNonFollowers != null,
  profileViews: historicalMetrics.totalProfileViews != null,
  follows: historicalMetrics.newFollowsCount != null,
  unfollows: historicalMetrics.unfollowsCount != null,
  followersSnapshot: followerSnapshot.followerCount != null,
},
metricCoverage: historicalCoverage,

},
          trend,
contentMix,
followersTrend,
monthlyViewsTrend: historicalMonthlyTrend,
topContent,
contentList,
contentListTotal: contentList.length,
contentInsightsAvailability,

        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        errorCode: "META_DASHBOARD_FAILED",
        message: "InstaSight data could not be loaded.",
        suggestion: "Please check the Meta connection and try again.",
        technicalMessage: error instanceof Error ? error.message : "Meta dashboard failed.",
      });
    }
  }
);

metaRouter.get(
  "/campaign-attribution",
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const data = await buildCampaignAttribution({ since: req.query.since, until: req.query.until })
      let insights = []
      try { insights = await generateCampaignAttributionInsights(data) } catch { insights = [] }
      const insightMap = new Map(insights.map((item) => [item.internalKey, item.text]))
      const campaigns = data.campaigns.map((campaign) => ({ ...campaign, insight: insightMap.get(campaign.internalKey) || null }))
      return res.json({ success: true, message: "Campaign attribution fetched successfully.", data: { campaigns, period: data.period, totalCustomers: data.totalCustomers } })
    } catch (error) {
      return res.status(500).json({ success: false, errorCode: "CAMPAIGN_ATTRIBUTION_FAILED", message: "Campaign attribution could not be loaded.", suggestion: "Please run the campaign attribution sync and try again." })
    }
  }
);
metaRouter.get(
  "/posts",
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const media = await prisma.instagramMedia.findMany({
        include: { insights: true },
        orderBy: { postedAt: "desc" },
        take: 50,
      });

      return res.json({
        success: true,
        data: media,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        errorCode: "META_POSTS_FAILED",
        message: "Instagram post data could not be loaded.",
        suggestion: "Please try syncing InstaSight again.",
        technicalMessage: error instanceof Error ? error.message : "Meta posts failed.",
      });
    }
  }
);

metaRouter.get(
  ["/audience-summary", "/insights"],
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const rows = await prisma.instagramAudienceInsight.findMany({
        where: {
          breakdownType: {
            in: ["gender", "age", "city", "country", "age_gender", "gender_age"],
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const toNumber = (value) => {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) ? numberValue : 0;
      };
      const formatPercent = (value) => Number(value.toFixed(1));
      const ageOrder = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
      const getAgeFromValue = (value) => ageOrder.find((age) => String(value || "").toLowerCase().includes(age)) || "-";
      const getGenderFromValue = (value) => {
        const raw = String(value || "").toLowerCase().trim();
        if (["f", "female", "perempuan", "cewe", "cewek"].includes(raw) || raw.startsWith("f")) return "Female";
        if (["m", "male", "laki-laki", "laki laki"].includes(raw) || raw.startsWith("m")) return "Male";
        return "-";
      };

      const latestMap = new Map();
      rows.forEach((row) => {
        const key = `${row.breakdownType}-${row.breakdownValue}`;
        if (!latestMap.has(key)) latestMap.set(key, row);
      });

      const latestRows = Array.from(latestMap.values());
      const genderRows = latestRows.filter((row) => row.breakdownType === "gender");
      const ageRows = latestRows.filter((row) => row.breakdownType === "age");
      const cityRows = latestRows.filter((row) => row.breakdownType === "city");
      const countryRows = latestRows.filter((row) => row.breakdownType === "country");
      const ageGenderRows = latestRows.filter((row) => {
        const age = getAgeFromValue(row.breakdownValue);
        const gender = getGenderFromValue(row.breakdownValue);
        return row.breakdownType === "age_gender" || row.breakdownType === "gender_age" || (age !== "-" && gender !== "-");
      });

      const genderTotal = genderRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);
      const ageTotal = ageRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);
      const cityTotal = cityRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);
      const countryTotal = countryRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);

      const genderDistribution = genderRows
        .map((row) => ({
          name: getGenderFromValue(row.breakdownValue),
          value: genderTotal > 0 ? formatPercent((toNumber(row.metricValue) / genderTotal) * 100) : 0,
        }))
        .filter((item) => item.name !== "-")
        .sort((a, b) => b.value - a.value);

      const ageDistribution = ageRows
        .map((row) => ({
          age: row.breakdownValue,
          value: ageTotal > 0 ? formatPercent((toNumber(row.metricValue) / ageTotal) * 100) : 0,
          total: toNumber(row.metricValue),
        }))
        .filter((item) => item.age && item.value > 0)
        .sort((a, b) => ageOrder.indexOf(a.age) - ageOrder.indexOf(b.age));

      const ageGenderMap = new Map();
      ageOrder.forEach((age) => {
        ageGenderMap.set(age, { age, Male: 0, Female: 0 });
      });

      ageGenderRows.forEach((row) => {
        const age = getAgeFromValue(row.breakdownValue);
        const gender = getGenderFromValue(row.breakdownValue);
        const value = toNumber(row.metricValue);
        if (age === "-" || gender === "-") return;
        const existing = ageGenderMap.get(age);
        existing[gender] += value;
        ageGenderMap.set(age, existing);
      });

      const ageGenderDistribution = Array.from(ageGenderMap.values()).filter((item) => item.Male > 0 || item.Female > 0);
      const derivedAgeGenderDistribution = ageGenderDistribution.length
        ? ageGenderDistribution
        : ageDistribution.map((item) => {
            const malePct = genderDistribution.find((gender) => gender.name === "Male")?.value || 0;
            const femalePct = genderDistribution.find((gender) => gender.name === "Female")?.value || 0;
            const genderPctTotal = malePct + femalePct;
            return {
              age: item.age,
              Male: genderPctTotal > 0 ? formatPercent(item.value * (malePct / genderPctTotal)) : 0,
              Female: genderPctTotal > 0 ? formatPercent(item.value * (femalePct / genderPctTotal)) : 0,
              isEstimated: true,
            };
          });

      const topCities = cityRows
        .map((row) => ({
          city: row.breakdownValue,
          value: cityTotal > 0 ? formatPercent((toNumber(row.metricValue) / cityTotal) * 100) : 0,
        }))
        .filter((item) => item.city && item.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);

      const topCountries = countryRows
        .map((row) => ({
          country: row.breakdownValue,
          value: countryTotal > 0 ? formatPercent((toNumber(row.metricValue) / countryTotal) * 100) : 0,
        }))
        .filter((item) => item.country && item.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 5);

      const dominantGender = genderDistribution[0]?.name || "-";
      const dominantGenderPct = genderDistribution[0]?.value || 0;
      const dominantAgeGroup = [...ageDistribution].sort((a, b) => b.value - a.value)[0]?.age || "-";
      const topCity = topCities[0]?.city || "-";
      const topCityPct = topCities[0]?.value || 0;

      return res.json({
        success: true,
        data: {
          hasData: Boolean(rows.length),
          summary: {
            dominantGender,
            dominantGenderPct,
            dominantAgeGroup,
            topCity,
            topCityPct,
          },
          genderDistribution,
          ageDistribution,
          ageGenderDistribution: derivedAgeGenderDistribution,
          topCities,
          topCountries,
          personaInsight:
            dominantGender !== "-"
              ? `Instagram audience is currently led by ${dominantGender} followers, with ${dominantAgeGroup} as the strongest age band and ${topCity} as the top city.`
              : "Audience demographic data is not available yet.",
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        errorCode: "META_AUDIENCE_FAILED",
        message: "Audience demographic data could not be loaded.",
        suggestion: "Please sync InstaSight data again after the Meta API connection is available.",
        technicalMessage: error instanceof Error ? error.message : "Audience summary failed.",
      });
    }
  }
);
