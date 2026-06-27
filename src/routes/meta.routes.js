import express from "express";

import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity } from "../services/activityLog.service.js";
import { syncMetaRawToAnalytics } from "../services/metaAnalytics.service.js";
import { createNotificationsForRoles } from "../services/notification.service.js";

export const metaRouter = express.Router();

const hasMetaCredentials = () =>
  Boolean(process.env.META_ACCESS_TOKEN && process.env.META_IG_USER_ID);

const buildMetaSetupResponse = () => ({
  success: false,
  errorCode: "META_NOT_CONFIGURED",
  message: "Meta API is not connected yet.",
  suggestion:
    "Please ask IT Support to configure Meta credentials in Settings or environment variables.",
});

metaRouter.use(authenticate);

metaRouter.get(
  "/status",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const configured = hasMetaCredentials();
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

      return res.json({
        success: true,
        data: {
          configured,
          connectionState: !configured
            ? "not_configured"
            : !latestSync
              ? "ready"
              : latestSync.status?.toLowerCase() === "success"
                ? "connected"
                : latestSync.status?.toLowerCase() === "running"
                  ? "syncing"
                  : "error",
          latestSync,
          setupMessage: configured ? null : buildMetaSetupResponse().message,
          suggestion: configured ? null : buildMetaSetupResponse().suggestion,
        },
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
      if (!hasMetaCredentials()) {
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
      const { since, until } = req.query;
      const startDate = since ? new Date(since) : new Date("2026-05-01");
      const endDate = until ? new Date(until) : new Date();

      const latestSync = await prisma.metaSyncLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, status: true, message: true },
      });

      const media = await prisma.instagramMedia.findMany({
        include: { insights: true },
        orderBy: { postedAt: "desc" },
        take: 100,
      });

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

      const totalViews = sumMetric("views") || sumMetric("impressions") || sumMetric("plays");
      const totalReach = sumMetric("reach");
      const totalLikes = sumMetric("likes");
      const totalComments = sumMetric("comments");
      const totalShares = sumMetric("shares");
      const totalSaved = sumMetric("saved");
      const totalInteractions =
        sumMetric("total_interactions") || totalLikes + totalComments + totalShares + totalSaved;
      const engagementRate = totalReach > 0 ? Number(((totalInteractions / totalReach) * 100).toFixed(2)) : 0;
      const shareRate = totalReach > 0 ? Number(((totalShares / totalReach) * 100).toFixed(2)) : 0;

      const trendMap = {};

      allInsights.forEach((insight) => {
        const date = new Date(insight.insightDate).toISOString().slice(0, 10);
        const value = Number(insight.metricValue || 0);

        if (!trendMap[date]) {
          trendMap[date] = { date, reach: 0, views: 0, interactions: 0 };
        }

        if (insight.metricName === "reach") trendMap[date].reach += value;
        if (["views", "impressions", "plays"].includes(insight.metricName)) trendMap[date].views += value;
        if (["total_interactions", "likes", "comments", "shares", "saved"].includes(insight.metricName)) {
          trendMap[date].interactions += value;
        }
      });

      const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

      const topContent = media
        .map((item) => {
          const itemInsights = item.insights.filter((insight) => {
            const insightDate = new Date(insight.insightDate);
            return insightDate >= startDate && insightDate <= endDate;
          });

          const getMetric = (metricName) =>
            itemInsights
              .filter((insight) => insight.metricName === metricName)
              .reduce((sum, insight) => sum + Number(insight.metricValue || 0), 0);

          const views = getMetric("views") || getMetric("impressions") || getMetric("plays");
          const reach = getMetric("reach");
          const likes = getMetric("likes");
          const comments = getMetric("comments");
          const shares = getMetric("shares");
          const saved = getMetric("saved");
          const interactions = getMetric("total_interactions") || likes + comments + shares + saved;
          const localEngagementRate = reach > 0 ? Number(((interactions / reach) * 100).toFixed(2)) : 0;

          return {
            id: item.id,
            igMediaId: item.igMediaId,
            caption: item.caption,
            mediaType: item.mediaType,
            mediaProductType: item.mediaProductType,
            mediaUrl: item.mediaUrl,
            thumbnailUrl: item.thumbnailUrl,
            permalink: item.permalink,
            postedAt: item.postedAt,
            views,
            reach,
            interactions,
            shares,
            engagementRate: localEngagementRate,
          };
        })
        .sort((a, b) => b.views - a.views)
        .slice(0, 10);

      return res.json({
        success: true,
        data: {
          configured: hasMetaCredentials(),
          hasData: Boolean(media.length || allInsights.length),
          lastSyncedAt: latestSync?.startedAt || null,
          summary: {
            totalViews,
            totalReach,
            totalInteractions,
            totalShares,
            engagementRate,
            shareRate,
          },
          trend,
          topContent,
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
            in: ["gender", "age", "city", "age_gender", "gender_age"],
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
        if (["f", "female", "perempuan"].includes(raw) || raw.startsWith("f")) return "Perempuan";
        if (["m", "male", "laki-laki"].includes(raw) || raw.startsWith("m")) return "Laki-laki";
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
      const ageGenderRows = latestRows.filter((row) => {
        const age = getAgeFromValue(row.breakdownValue);
        const gender = getGenderFromValue(row.breakdownValue);
        return row.breakdownType === "age_gender" || row.breakdownType === "gender_age" || (age !== "-" && gender !== "-");
      });

      const genderTotal = genderRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);
      const cityTotal = cityRows.reduce((sum, row) => sum + toNumber(row.metricValue), 0);

      const genderDistribution = genderRows
        .map((row) => ({
          name: getGenderFromValue(row.breakdownValue),
          value: genderTotal > 0 ? formatPercent((toNumber(row.metricValue) / genderTotal) * 100) : 0,
        }))
        .filter((item) => item.name !== "-")
        .sort((a, b) => b.value - a.value);

      const ageDistribution = ageRows
        .map((row) => ({ age: row.breakdownValue, value: toNumber(row.metricValue) }))
        .filter((item) => item.age && item.value > 0)
        .sort((a, b) => ageOrder.indexOf(a.age) - ageOrder.indexOf(b.age));

      const ageGenderMap = new Map();
      ageOrder.forEach((age) => {
        ageGenderMap.set(age, { age, "Laki-laki": 0, Perempuan: 0 });
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

      const topCities = cityRows
        .map((row) => ({
          city: row.breakdownValue,
          value: cityTotal > 0 ? formatPercent((toNumber(row.metricValue) / cityTotal) * 100) : 0,
        }))
        .filter((item) => item.city && item.value > 0)
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
          ageGenderDistribution: Array.from(ageGenderMap.values()).filter((item) => item["Laki-laki"] > 0 || item.Perempuan > 0),
          topCities,
          personaInsight:
            dominantGender !== "-"
              ? `Instagram audience is currently led by ${dominantGender} followers, with ${dominantAgeGroup} as the strongest age band and ${topCity} as the top city.`
              : "Audience insight data is not available yet.",
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        errorCode: "META_AUDIENCE_FAILED",
        message: "Audience insight data could not be loaded.",
        suggestion: "Please sync InstaSight data again after the Meta API connection is available.",
        technicalMessage: error instanceof Error ? error.message : "Audience summary failed.",
      });
    }
  }
);
