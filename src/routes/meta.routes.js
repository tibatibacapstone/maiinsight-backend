import express from "express";
import { prisma } from "../config/prisma.js";
import { syncMetaRawToAnalytics } from "../services/metaAnalytics.service.js";

const router = express.Router();

router.post("/sync", async (req, res) => {
  try {
    const { since, until } = req.query;

    const result = await syncMetaRawToAnalytics({
      since,
      until,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      message: "Failed to sync Meta API data",
      error: error.message,
    });
  }
});

router.get("/raw", async (req, res) => {
  try {
    const rawData = await prisma.metaRawResponse.findMany({
      orderBy: {
        fetchedAt: "desc",
      },
      take: 50,
    });

    res.json(rawData);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch raw data",
      error: error.message,
    });
  }
});
router.get("/test", (req, res) => {
  res.json({
    message: "Meta route is working",
  });
});
router.post("/sync", async (req, res) => {
  res.json({
    message: "Sync route is working",
    query: req.query,
  });
});

router.get("/analytics", async (req, res) => {
  try {
    const media = await prisma.instagramMedia.findMany({
      include: {
        insights: true,
      },
      orderBy: {
        postedAt: "desc",
      },
      take: 50,
    });

    const accountInsights = await prisma.instagramAccountInsight.findMany({
      orderBy: {
        insightDate: "asc",
      },
    });

    const audienceInsights = await prisma.instagramAudienceInsight.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    const snapshots = await prisma.instagramAccountSnapshot.findMany({
      orderBy: {
        snapshotDate: "asc",
      },
    });

    res.json({
      media,
      accountInsights,
      audienceInsights,
      snapshots,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch analytics data",
      error: error.message,
    });
  }
});

router.get("/top-content", async (req, res) => {
  try {
    const media = await prisma.instagramMedia.findMany({
      include: {
        insights: true,
      },
      orderBy: {
        postedAt: "desc",
      },
    });

    const result = media
      .map((item) => {
        const views =
          item.insights.find((insight) => insight.metricName === "views")
            ?.metricValue ?? 0;

        const reach =
          item.insights.find((insight) => insight.metricName === "reach")
            ?.metricValue ?? 0;

        const totalInteractions =
          item.insights.find(
            (insight) => insight.metricName === "total_interactions"
          )?.metricValue ?? 0;

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
          totalInteractions,
          engagementRate:
            reach > 0 ? Number(((totalInteractions / reach) * 100).toFixed(2)) : 0,
        };
      })
      .sort((a, b) => b.views - a.views);

    res.json(result);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch top content",
      error: error.message,
    });
  }
});

export default router;