import express from "express";

import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.service.js";
import { buildConfigSnapshot } from "../services/appConfig.service.js";
import { syncMetaRawToAnalytics } from "../services/metaAnalytics.service.js";
import { createNotificationsForRoles } from "../services/notification.service.js";

export const metaRouter = express.Router();

const hasMetaCredentials = async () => {
  const config = await buildConfigSnapshot();
  return Boolean(config.metaAccessToken || process.env.META_ACCESS_TOKEN) &&
    Boolean(config.metaIgUserId || process.env.META_IG_USER_ID);
};

const testMetaConnection = async () => {
  const config = await buildConfigSnapshot();
  const accessToken = config.metaAccessToken || process.env.META_ACCESS_TOKEN;
  const igUserId = config.metaIgUserId || process.env.META_IG_USER_ID;
  const graphVersion = config.metaGraphVersion || process.env.META_API_VERSION || "v25.0";

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
      return {
        ok: false,
        error: data.error?.message || `Meta API returned status ${response.status}`,
      };
    }

    return { ok: true, username: data.username };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reach Meta API.",
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
const calculateChangePct = (current, previous) => {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);

  if (!previousValue) return 0;

  return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(1));
};
const calculateRatePct = (numerator, denominator) => {
  const numeratorValue = Number(numerator || 0);
  const denominatorValue = Number(denominator || 0);

  if (!denominatorValue) return 0;

  return Number(((numeratorValue / denominatorValue) * 100).toFixed(1));
};

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

const sumInsightValues = (rows = []) =>
  rows.reduce((sum, row) => sum + Number(row.metricValue || 0), 0);

metaRouter.use(authenticate);

metaRouter.get(
  "/status",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const configured = await hasMetaCredentials();
      const latestSync = await prisma.metaSyncLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          status: true,
          message: true,
          startedAt: true,
          finishedAt: true,
        },
      });

      let connectionState = !configured
        ? "not_configured"
        : !latestSync
          ? "ready"
          : latestSync.status?.toLowerCase() === "success"
            ? "connected"
            : latestSync.status?.toLowerCase() === "running"
              ? "syncing"
              : "error";

      let connectionError = null;

      if (configured && connectionState !== "syncing") {
        const testResult = await testMetaConnection();
        if (!testResult.ok) {
          connectionState = "error";
          connectionError = testResult.error;
        }
      }

      return res.json({
        success: true,
        data: {
          configured,
          connectionState,
          latestSync,
          setupMessage: configured ? null : buildMetaSetupResponse().message,
          suggestion: configured
            ? connectionError
              ? "Meta credentials are configured but the API returned an error. Please verify the access token is valid and not expired."
              : null
            : buildMetaSetupResponse().suggestion,
          connectionError,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

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

      const since = req.body?.since || req.query?.since;
      const until = req.body?.until || req.query?.until;
      const result = await syncMetaRawToAnalytics({ since, until });

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
        errorCode: "META_SYNC_FAILED",
        message: "InstaSight could not sync Meta data.",
        suggestion: "Please check the Meta connection and try again.",
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

  const [
  latestAccount,
  media,
  accountReachInsights,
  accountInteractionInsights,
  accountProfileViewInsights,
  previousAccountProfileViewInsights,
  currentFollowInsights,
  previousFollowInsights,
  currentUnfollowInsights,
  previousUnfollowInsights,
  monthlyMediaPerformanceRows,
  previousMonthlyMediaPerformanceRows,
  monthlyMediaTrendRows,
  monthlyProfileViewTrendRows,
] = await Promise.all([
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

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: "reach",
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["total_interactions", "accounts_engaged"],
      },
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["profile_views", "profile_view", "profile_visits"],
      },
      period: "month",
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["profile_views", "profile_view", "profile_visits"],
      },
      period: "month",
      insightDate: {
        gte: previousStartDate,
        lte: previousEndDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["follows", "follow_count", "new_follows"],
      },
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["follows", "follow_count", "new_follows"],
      },
      insightDate: {
        gte: previousStartDate,
        lte: previousEndDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["unfollows", "unfollowers", "unfollow_count"],
      },
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["unfollows", "unfollowers", "unfollow_count"],
      },
      insightDate: {
        gte: previousStartDate,
        lte: previousEndDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
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

  prisma.instagramMonthlyMediaPerformance.findMany({
    where: {
      month: {
        gte: previousStartDate,
        lte: previousEndDate,
      },
      contentType: selectedMonthlyContentType,
    },
    orderBy: {
      month: "asc",
    },
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

  prisma.instagramAccountInsight.findMany({
    where: {
      metricName: {
        in: ["profile_views", "profile_view", "profile_visits"],
      },
      period: "month",
      insightDate: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: {
      insightDate: "asc",
    },
  }),
]);

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

const summarizeMonthlyPerformance = (rows = []) =>
  rows.reduce(
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

      interactions: total.interactions + Number(row.interactions || 0),
      interactionsFromFollowers:
        total.interactionsFromFollowers +
        Number(row.interactionsFromFollowers || 0),
      interactionsFromNonFollowers:
        total.interactionsFromNonFollowers +
        Number(row.interactionsFromNonFollowers || 0),
    }),
    {
      views: 0,
      viewsFromFollowers: 0,
      viewsFromNonFollowers: 0,

      reach: 0,
      reachFromFollowers: 0,
      reachFromNonFollowers: 0,

      interactions: 0,
      interactionsFromFollowers: 0,
      interactionsFromNonFollowers: 0,
    }
  );

const previousMonthlyMediaPerformance = summarizeMonthlyPerformance(
  previousMonthlyMediaPerformanceRows
);
const previousBreakdownTotalInteractions =
  Number(previousMonthlyMediaPerformance.interactionsFromFollowers || 0) +
  Number(previousMonthlyMediaPerformance.interactionsFromNonFollowers || 0);

const previousTotalInteractions =
  previousBreakdownTotalInteractions > 0
    ? previousBreakdownTotalInteractions
    : Number(previousMonthlyMediaPerformance.interactions || 0);


      const preferredAccountInteractionMetric = accountInteractionInsights.some(
        (insight) => insight.metricName === "total_interactions"
      )
        ? "total_interactions"
        : "accounts_engaged";
      const selectedAccountInteractionInsights = accountInteractionInsights.filter(
        (insight) => insight.metricName === preferredAccountInteractionMetric
      );

      const allInsights = media.flatMap((item) =>
        item.insights
          .filter((insight) => {
            const insightDate = new Date(insight.insightDate);
            return insightDate >= startDate && insightDate <= endDate;
          })
          .map((insight) => ({
            ...insight,
            mediaId: item.id,
          }))
      );

      const sumMetric = (metricName) =>
        allInsights
          .filter((insight) => insight.metricName === metricName)
          .reduce((sum, insight) => sum + Number(insight.metricValue || 0), 0);

      const breakdownTotalViews =
  Number(monthlyMediaPerformance.viewsFromFollowers || 0) +
  Number(monthlyMediaPerformance.viewsFromNonFollowers || 0);

const totalViews =
  breakdownTotalViews > 0
    ? breakdownTotalViews
    : Number(monthlyMediaPerformance.views || 0);
  
    const previousBreakdownTotalViews =
  Number(previousMonthlyMediaPerformance.viewsFromFollowers || 0) +
  Number(previousMonthlyMediaPerformance.viewsFromNonFollowers || 0);

const previousTotalViews =
  previousBreakdownTotalViews > 0
    ? previousBreakdownTotalViews
    : Number(previousMonthlyMediaPerformance.views || 0);

    const previousBreakdownTotalReach =
  Number(previousMonthlyMediaPerformance.reachFromFollowers || 0) +
  Number(previousMonthlyMediaPerformance.reachFromNonFollowers || 0);

const previousTotalReach =
  previousBreakdownTotalReach > 0
    ? previousBreakdownTotalReach
    : Number(previousMonthlyMediaPerformance.reach || 0);

const viewsFromFollowers = Number(
  monthlyMediaPerformance.viewsFromFollowers || 0
);

const viewsFromNonFollowers = Number(
  monthlyMediaPerformance.viewsFromNonFollowers || 0
);

const hasViewAudienceBreakdown =
  viewsFromFollowers > 0 || viewsFromNonFollowers > 0;

const viewsFromFollowersPct =
  hasViewAudienceBreakdown && totalViews > 0
    ? Number(((viewsFromFollowers / totalViews) * 100).toFixed(1))
    : 0;

const viewsFromNonFollowersPct =
  hasViewAudienceBreakdown && totalViews > 0
    ? Number(((viewsFromNonFollowers / totalViews) * 100).toFixed(1))
    : 0;

const viewsChangePct = calculateChangePct(totalViews, previousTotalViews);
const viewsFromFollowersChangePct = 0;
const viewsFromNonFollowersChangePct = 0;

const breakdownTotalReach =
  Number(monthlyMediaPerformance.reachFromFollowers || 0) +
  Number(monthlyMediaPerformance.reachFromNonFollowers || 0);

const mediaReach = Number(monthlyMediaPerformance?.reach || 0);

const accountReach = accountReachInsights.reduce(
  (sum, insight) => sum + Number(insight.metricValue || 0),
  0
);

const totalReach =
  breakdownTotalReach > 0
    ? breakdownTotalReach
    : accountReach || mediaReach;

      const reachFromFollowers = Number(
  monthlyMediaPerformance.reachFromFollowers || 0
);

const reachFromNonFollowers = Number(
  monthlyMediaPerformance.reachFromNonFollowers || 0
);

const hasReachAudienceBreakdown =
  reachFromFollowers > 0 || reachFromNonFollowers > 0;

const reachFromFollowersPct =
  hasReachAudienceBreakdown && totalReach > 0
    ? Number(((reachFromFollowers / totalReach) * 100).toFixed(1))
    : 0;

const reachFromNonFollowersPct =
  hasReachAudienceBreakdown && totalReach > 0
    ? Number(((reachFromNonFollowers / totalReach) * 100).toFixed(1))
    : 0;

const reachChangePct = calculateChangePct(totalReach, previousTotalReach);
const reachFromFollowersChangePct = 0;
const reachFromNonFollowersChangePct = 0;

      const totalLikes = Number(monthlyMediaPerformance?.likes || 0);
const totalComments = Number(monthlyMediaPerformance?.comments || 0);
const totalShares = Number(monthlyMediaPerformance?.shares || 0);
const totalSaved = Number(monthlyMediaPerformance?.saved || 0);

      const totalProfileViews = accountProfileViewInsights.reduce(
  (sum, insight) => sum + Number(insight.metricValue || 0),
  0
);

const previousTotalProfileViews = previousAccountProfileViewInsights.reduce(
  (sum, insight) => sum + Number(insight.metricValue || 0),
  0
);

const profileViewsChangePct = calculateChangePct(
  totalProfileViews,
  previousTotalProfileViews
);
      const mediaInteractions =
        sumMetric("total_interactions") || totalLikes + totalComments + totalShares + totalSaved;
      const accountInteractions = selectedAccountInteractionInsights.reduce(
        (sum, insight) => sum + Number(insight.metricValue || 0),
        0
      );
      const allMediaInsightRows = media.flatMap((item) => item.insights || []);
      const fallbackMediaTotalInteractions = allMediaInsightRows
        .filter((insight) => insight.metricName === "total_interactions")
        .reduce((sum, insight) => sum + Number(insight.metricValue || 0), 0);
      const fallbackMediaComponentInteractions = allMediaInsightRows
        .filter((insight) => ["likes", "comments", "shares", "saved"].includes(insight.metricName))
        .reduce((sum, insight) => sum + Number(insight.metricValue || 0), 0);
      const fallbackMediaInteractions = fallbackMediaTotalInteractions || fallbackMediaComponentInteractions;


      const breakdownTotalInteractions =
  Number(monthlyMediaPerformance.interactionsFromFollowers || 0) +
  Number(monthlyMediaPerformance.interactionsFromNonFollowers || 0);

const monthlyInteractions = Number(monthlyMediaPerformance?.interactions || 0);

const totalInteractions =
  breakdownTotalInteractions > 0
    ? breakdownTotalInteractions
    : monthlyInteractions > 0
      ? monthlyInteractions
      : accountInteractions || mediaInteractions || fallbackMediaInteractions;

      const interactionsChangePct = calculateChangePct(
  totalInteractions,
  previousTotalInteractions
);

const interactionsFromNonFollowers = Number(
  monthlyMediaPerformance.interactionsFromNonFollowers || 0
);


const interactionsFromFollowersChangePct = 0;
const interactionsFromNonFollowersChangePct = 0;

const engagementRate = calculateRatePct(totalInteractions, totalReach);

const previousEngagementRate = calculateRatePct(
  previousTotalInteractions,
  previousTotalReach
);

const engagementRateChangePct = calculateChangePct(
  engagementRate,
  previousEngagementRate
);

const conversionRate = calculateRatePct(totalProfileViews, totalReach);

const previousConversionRate = calculateRatePct(
  previousTotalProfileViews,
  previousTotalReach
);

const profileVisitRate = conversionRate;

const profileVisitRateChangePct = calculateChangePct(
  profileVisitRate,
  previousConversionRate
);

const shareRate =
  totalReach > 0
    ? Number(((totalShares / totalReach) * 100).toFixed(2))
    : 0;

const saveRate =
  totalReach > 0
    ? Number(((totalSaved / totalReach) * 100).toFixed(2))
    : 0;

      const currentFollowersCount = Number(latestAccount?.followersCount || 0);

const followersChangePct = 0;

const currentFollowsCount = Number(latestAccount?.followsCount || 0);

const currentInstagramMediaCount = Number(latestAccount?.mediaCount || 0);
const newFollowsCount = sumInsightValues(currentFollowInsights);
const previousNewFollowsCount = sumInsightValues(previousFollowInsights);

const newFollowsChangePct = calculateChangePct(
  newFollowsCount,
  previousNewFollowsCount
);

const unfollowsCount = sumInsightValues(currentUnfollowInsights);
const previousUnfollowsCount = sumInsightValues(previousUnfollowInsights);

const unfollowsChangePct = calculateChangePct(
  unfollowsCount,
  previousUnfollowsCount
);



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
const profileViewsTrendMap = new Map();

monthlyProfileViewTrendRows.forEach((row) => {
  const monthKey = new Date(row.insightDate).toISOString().slice(0, 7);
  const currentValue = Number(profileViewsTrendMap.get(monthKey) || 0);

  profileViewsTrendMap.set(
    monthKey,
    currentValue + Number(row.metricValue || 0)
  );
});

const monthlyViewsTrend = monthlyMediaTrendRows.map((row) => {
  const monthKey = new Date(row.month).toISOString().slice(0, 7);

  return {
    month: monthKey,

    views: Number(row.views || 0),
    viewsFromFollowers: Number(row.viewsFromFollowers || 0),
    viewsFromNonFollowers: Number(row.viewsFromNonFollowers || 0),

    reach: Number(row.reach || 0),
    reachFromFollowers: Number(row.reachFromFollowers || 0),
    reachFromNonFollowers: Number(row.reachFromNonFollowers || 0),

    interactions: Number(row.interactions || 0),
    interactionsFromFollowers: Number(row.interactionsFromFollowers || 0),
    interactionsFromNonFollowers: Number(row.interactionsFromNonFollowers || 0),

    profileViews: Number(profileViewsTrendMap.get(monthKey) || 0),

    contentCount: Number(row.contentCount || 0),
  };
});

      const trendMap = {};

      accountReachInsights.forEach((insight) => {
        const date = new Date(insight.insightDate).toISOString().slice(0, 10);
        const value = Number(insight.metricValue || 0);

        if (!trendMap[date]) {
          trendMap[date] = { date, reach: 0, views: 0, interactions: 0, profileViews: 0 };
        }

        trendMap[date].reach += value;
      });

      selectedAccountInteractionInsights.forEach((insight) => {
        const date = new Date(insight.insightDate).toISOString().slice(0, 10);
        const value = Number(insight.metricValue || 0);

        if (!trendMap[date]) {
          trendMap[date] = { date, reach: 0, views: 0, interactions: 0, profileViews: 0 };
        }

        trendMap[date].interactions += value;
      });

      accountProfileViewInsights.forEach((insight) => {
        const date = new Date(insight.insightDate).toISOString().slice(0, 10);
        const value = Number(insight.metricValue || 0);

        if (!trendMap[date]) {
          trendMap[date] = { date, reach: 0, views: 0, interactions: 0, profileViews: 0 };
        }

        trendMap[date].profileViews += value;
      });

      allInsights.forEach((insight) => {
        const date = new Date(insight.insightDate).toISOString().slice(0, 10);
        const value = Number(insight.metricValue || 0);

        if (!trendMap[date]) {
          trendMap[date] = { date, reach: 0, views: 0, interactions: 0, profileViews: 0 };
        }

        if (!accountReachInsights.length && insight.metricName === "reach") trendMap[date].reach += value;
        if (["views", "impressions", "plays"].includes(insight.metricName)) trendMap[date].views += value;
        if (!selectedAccountInteractionInsights.length && ["total_interactions", "likes", "comments", "shares", "saved"].includes(insight.metricName)) {
          trendMap[date].interactions += value;
        }
      });

      const trend = Object.values(trendMap)
        .map((item) => {
          const fallbackInteractions =
            !selectedAccountInteractionInsights.length && !item.interactions && fallbackMediaInteractions > 0 && totalReach > 0
              ? (item.reach / totalReach) * fallbackMediaInteractions
              : 0;
          const interactions = item.interactions || fallbackInteractions;

          return {
            ...item,
            interactions,
            engagementRate: item.reach > 0 ? Number(((interactions / item.reach) * 100).toFixed(2)) : 0,
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      const contentPerformance = media
  .map((item) => {
    const itemInsights = item.insights || [];

    const getLatestMetric = (metricNames = []) => {
      const matchedInsights = itemInsights
        .filter((insight) => metricNames.includes(insight.metricName))
        .sort(
          (a, b) =>
            new Date(b.insightDate).getTime() -
            new Date(a.insightDate).getTime()
        );

      return Number(matchedInsights[0]?.metricValue || 0);
    };

    const rawMedia = item.rawJson || {};

    const views = getLatestMetric(["views", "impressions", "plays"]);
    const reach = getLatestMetric(["reach"]);

    const likes =
      getLatestMetric(["likes"]) || Number(rawMedia.like_count || 0);

    const comments =
      getLatestMetric(["comments"]) || Number(rawMedia.comments_count || 0);

    const shares = getLatestMetric(["shares"]);
    const saved = getLatestMetric(["saved"]);

    const interactions =
      getLatestMetric(["total_interactions"]) ||
      likes + comments + shares + saved;

    const localEngagementRate =
      reach > 0 ? Number(((interactions / reach) * 100).toFixed(2)) : 0;

    const localShareRate =
      reach > 0 ? Number(((shares / reach) * 100).toFixed(2)) : 0;

    const localSaveRate =
      reach > 0 ? Number(((saved / reach) * 100).toFixed(2)) : 0;

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
      engagementRate: localEngagementRate,
      shareRate: localShareRate,
      saveRate: localSaveRate,
    };
  })
  .sort((a, b) => b.views - a.views);

      const contentList = [...contentPerformance].sort(
  (a, b) =>
    new Date(b.postedAt || 0).getTime() -
    new Date(a.postedAt || 0).getTime()
);

const topContent = [...contentPerformance]
  .sort((a, b) => b.views - a.views)
  .slice(0, 10);

      const contentMixMap = new Map();
      contentPerformance.forEach((item) => {
        const type = item.mediaProductType || item.mediaType || "Unknown";
        const existing = contentMixMap.get(type) || { type, count: 0, views: 0, reach: 0, interactions: 0 };
        existing.count += 1;
        existing.views += item.views;
        existing.reach += item.reach;
        existing.interactions += item.interactions;
        contentMixMap.set(type, existing);
      });

      const contentMix = Array.from(contentMixMap.values())
        .map((item) => ({
          ...item,
          engagementRate: item.reach > 0 ? Number(((item.interactions / item.reach) * 100).toFixed(2)) : 0,
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

const buildMonthlyTrendFromContent = (items = []) => {
  const monthMap = new Map();

  items.forEach((item) => {
    if (!item.postedAt) return;

    const monthKey = new Date(item.postedAt).toISOString().slice(0, 7);

    const existing = monthMap.get(monthKey) || {
      month: monthKey,
      views: 0,
      viewsFromFollowers: 0,
      viewsFromNonFollowers: 0,
      reach: 0,
      reachFromFollowers: 0,
      reachFromNonFollowers: 0,
      interactions: 0,
      interactionsFromFollowers: 0,
      interactionsFromNonFollowers: 0,
      profileViews: 0,
      contentCount: 0,
    };

    existing.views += Number(item.views || 0);
    existing.reach += Number(item.reach || 0);
    existing.interactions += Number(item.interactions || 0);
    existing.contentCount += 1;

    monthMap.set(monthKey, existing);
  });

  return Array.from(monthMap.values()).sort((a, b) =>
    a.month.localeCompare(b.month)
  );
};

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
  media.length ||
    allInsights.length ||
    accountReachInsights.length ||
    monthlyMediaPerformanceRows.length
),
          lastSyncedAt: latestSync?.startedAt || null,
         summary: {
  totalViews: isContentLabelFiltered ? filteredContentTotals.views : totalViews,
  viewsChangePct,

  viewsFromFollowers,
  viewsFromFollowersPct,
  viewsFromFollowersChangePct,

  viewsFromNonFollowers,
  viewsFromNonFollowersPct,
  viewsFromNonFollowersChangePct,

  totalReach: isContentLabelFiltered ? filteredContentTotals.reach : totalReach,
  reachChangePct,

  reachFromFollowers,
  reachFromFollowersPct,
  reachFromFollowersChangePct,

  reachFromNonFollowers,
  reachFromNonFollowersPct,
  reachFromNonFollowersChangePct,

  totalProfileViews,
  profileViewsChangePct,
totalInteractions: isContentLabelFiltered
  ? filteredContentTotals.interactions
  : totalInteractions,
totalLikes: isContentLabelFiltered ? filteredContentTotals.likes : totalLikes,
totalComments: isContentLabelFiltered
  ? filteredContentTotals.comments
  : totalComments,
totalShares: isContentLabelFiltered ? filteredContentTotals.shares : totalShares,
totalSaved: isContentLabelFiltered ? filteredContentTotals.saved : totalSaved,
engagementRate: isContentLabelFiltered
  ? calculateRatePct(filteredContentTotals.interactions, filteredContentTotals.reach)
  : engagementRate,
engagementRateChangePct,

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

profileVisitRate,
profileVisitRateChangePct,

averageInteractionsPerContent,

interactionsChangePct,
interactionsFromFollowersChangePct,

interactionsFromNonFollowers,
interactionsFromNonFollowersChangePct,

contentCount: isContentLabelFiltered
  ? filteredContentTotals.contentCount
  : Number(monthlyMediaPerformance?.contentCount || contentPerformance.length),
topContentType,

followersCount: currentFollowersCount,
followersChangePct,

newFollowsCount,
newFollowsChangePct,

unfollowsCount,
unfollowsChangePct,

followsCount: currentFollowsCount,
instagramMediaCount: currentInstagramMediaCount,
instagramUsername: latestAccount?.username || null,

},
          trend,
contentMix,
followersTrend,
monthlyViewsTrend: isContentLabelFiltered
  ? buildMonthlyTrendFromContent(contentPerformance)
  : monthlyViewsTrend,
topContent,
contentList,
contentListTotal: contentList.length,

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
