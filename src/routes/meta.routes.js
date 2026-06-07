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
router.get("/dashboard", async (req, res) => {
  try {
    const { since, until } = req.query;

    const startDate = since ? new Date(since) : new Date("2026-05-01");
    const endDate = until ? new Date(until) : new Date();

    /**
     * 1. Ambil data media + insights
     */
    const media = await prisma.instagramMedia.findMany({
      include: {
        insights: true,
      },
      orderBy: {
        postedAt: "desc",
      },
      take: 100,
    });

    /**
     * 2. Filter insights berdasarkan tanggal
     */
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

    const sumMetric = (metricName) => {
      return allInsights
        .filter((insight) => insight.metricName === metricName)
        .reduce((sum, insight) => sum + Number(insight.metricValue || 0), 0);
    };

    /**
     * 3. Summary KPI
     */
    const totalViews =
      sumMetric("views") || sumMetric("impressions") || sumMetric("plays");

    const totalReach = sumMetric("reach");

    const totalLikes = sumMetric("likes");
    const totalComments = sumMetric("comments");
    const totalShares = sumMetric("shares");
    const totalSaved = sumMetric("saved");

    const totalInteractions =
      sumMetric("total_interactions") ||
      totalLikes + totalComments + totalShares + totalSaved;

    const engagementRate =
      totalReach > 0
        ? Number(((totalInteractions / totalReach) * 100).toFixed(2))
        : 0;

    const shareRate =
      totalReach > 0
        ? Number(((totalShares / totalReach) * 100).toFixed(2))
        : 0;

    /**
     * 4. Trend chart per tanggal
     */
    const trendMap = {};

    allInsights.forEach((insight) => {
      const date = new Date(insight.insightDate).toISOString().slice(0, 10);
      const value = Number(insight.metricValue || 0);

      if (!trendMap[date]) {
        trendMap[date] = {
          date,
          reach: 0,
          views: 0,
          interactions: 0,
        };
      }

      if (insight.metricName === "reach") {
        trendMap[date].reach += value;
      }

      if (
        insight.metricName === "views" ||
        insight.metricName === "impressions" ||
        insight.metricName === "plays"
      ) {
        trendMap[date].views += value;
      }

      if (
        insight.metricName === "total_interactions" ||
        insight.metricName === "likes" ||
        insight.metricName === "comments" ||
        insight.metricName === "shares" ||
        insight.metricName === "saved"
      ) {
        trendMap[date].interactions += value;
      }
    });

    const trend = Object.values(trendMap).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    /**
     * 5. Top content berdasarkan views
     */
    const topContent = media
      .map((item) => {
        const itemInsights = item.insights.filter((insight) => {
          const insightDate = new Date(insight.insightDate);
          return insightDate >= startDate && insightDate <= endDate;
        });

        const getMediaMetric = (metricName) => {
          return itemInsights
            .filter((insight) => insight.metricName === metricName)
            .reduce(
              (sum, insight) => sum + Number(insight.metricValue || 0),
              0
            );
        };

        const views =
          getMediaMetric("views") ||
          getMediaMetric("impressions") ||
          getMediaMetric("plays");

        const reach = getMediaMetric("reach");

        const likes = getMediaMetric("likes");
        const comments = getMediaMetric("comments");
        const shares = getMediaMetric("shares");
        const saved = getMediaMetric("saved");

        const interactions =
          getMediaMetric("total_interactions") ||
          likes + comments + shares + saved;

        const engagementRate =
          reach > 0
            ? Number(((interactions / reach) * 100).toFixed(2))
            : 0;

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
          engagementRate,
        };
      })
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);

    res.json({
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
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch Meta dashboard data",
      error: error.message,
    });
  }
});
router.get("/audience-summary", async (req, res) => {
  try {
    const rows = await prisma.instagramAudienceInsight.findMany({
      where: {
        breakdownType: {
          in: ["gender", "age", "city", "age_gender", "gender_age"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const toNumber = (value) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : 0;
    };

    const formatPercent = (value) => Number(value.toFixed(1));

    const ageOrder = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

    const getAgeFromValue = (value) => {
      const raw = String(value || "").toLowerCase();

      return ageOrder.find((age) => raw.includes(age)) || "-";
    };

    const getGenderFromValue = (value) => {
  const raw = String(value || "").toLowerCase().trim();

  if (
    raw === "f" ||
    raw.includes("female") ||
    raw.includes("perempuan") ||
    raw.startsWith("f.") ||
    raw.startsWith("f_") ||
    raw.startsWith("f-")
  ) {
    return "Perempuan";
  }

  if (
    raw === "m" ||
    raw.includes("male") ||
    raw.includes("laki") ||
    raw.startsWith("m.") ||
    raw.startsWith("m_") ||
    raw.startsWith("m-")
  ) {
    return "Laki-laki";
  }

  return "-";
};
    const genderLabel = (value) => {
  const normalized = String(value || "").toLowerCase().trim();

  if (
    normalized === "m" ||
    normalized === "male" ||
    normalized === "laki-laki"
  ) {
    return "Laki-laki";
  }

  if (
    normalized === "f" ||
    normalized === "female" ||
    normalized === "perempuan"
  ) {
    return "Perempuan";
  }

  if (
    normalized === "u" ||
    normalized === "unknown" ||
    normalized === "unspecified"
  ) {
    return "Tidak diketahui";
  }

  return "Tidak diketahui";
};

    /**
     * Ambil data terbaru agar tidak double count ketika sync berkali-kali.
     */
    const latestMap = new Map();

    rows.forEach((row) => {
      const key = `${row.breakdownType}-${row.breakdownValue}`;

      if (!latestMap.has(key)) {
        latestMap.set(key, row);
      }
    });

    const latestRows = Array.from(latestMap.values());

    const genderRows = latestRows.filter((row) => row.breakdownType === "gender");
    const ageRows = latestRows.filter((row) => row.breakdownType === "age");
    const cityRows = latestRows.filter((row) => row.breakdownType === "city");

    const ageGenderRows = latestRows.filter((row) => {
      const value = String(row.breakdownValue || "");
      const age = getAgeFromValue(value);
      const gender = getGenderFromValue(value);

      return (
        row.breakdownType === "age_gender" ||
        row.breakdownType === "gender_age" ||
        (age !== "-" && gender !== "-")
      );
    });

    const genderTotal = genderRows.reduce(
      (sum, row) => sum + toNumber(row.metricValue),
      0
    );

    const cityTotal = cityRows.reduce(
      (sum, row) => sum + toNumber(row.metricValue),
      0
    );

    const genderDistribution = genderRows
      .map((row) => {
        const rawValue = toNumber(row.metricValue);

        return {
          name: genderLabel(row.breakdownValue),
          value: genderTotal > 0 ? formatPercent((rawValue / genderTotal) * 100) : 0,
          rawValue,
        };
      })
      .sort((a, b) => b.value - a.value);

    /**
     * Age distribution biasa untuk dominant age.
     */
    const ageDistribution = ageRows
      .map((row) => ({
        age: row.breakdownValue,
        value: toNumber(row.metricValue),
      }))
      .filter((item) => item.age && item.value > 0)
      .sort((a, b) => ageOrder.indexOf(a.age) - ageOrder.indexOf(b.age));

    /**
     * Age + Gender distribution untuk chart Usia & Jenis Kelamin.
     */
    const ageGenderMap = new Map();

    ageOrder.forEach((age) => {
      ageGenderMap.set(age, {
        age,
        "Laki-laki": 0,
        Perempuan: 0,
      });
    });

    ageGenderRows.forEach((row) => {
      const age = getAgeFromValue(row.breakdownValue);
      const gender = getGenderFromValue(row.breakdownValue);
      const value = toNumber(row.metricValue);

      if (age === "-" || gender === "-") return;

      const existing = ageGenderMap.get(age) || {
        age,
        "Laki-laki": 0,
        Perempuan: 0,
      };

      existing[gender] += value;
      ageGenderMap.set(age, existing);
    });

    const rawAgeGenderDistribution = Array.from(ageGenderMap.values());

    const ageGenderTotal = rawAgeGenderDistribution.reduce(
      (sum, item) => sum + item["Laki-laki"] + item.Perempuan,
      0
    );

    let ageGenderDistribution =
  ageGenderTotal > 0
    ? rawAgeGenderDistribution
        .map((item) => ({
          age: item.age,
          "Laki-laki": formatPercent((item["Laki-laki"] / ageGenderTotal) * 100),
          Perempuan: formatPercent((item.Perempuan / ageGenderTotal) * 100),
        }))
        .filter((item) => item["Laki-laki"] > 0 || item.Perempuan > 0)
    : [];

/**
 * Fallback:
 * Kalau data age_gender asli tidak tersedia,
 * buat estimasi dari ageDistribution + genderDistribution.
 */
if (ageGenderDistribution.length === 0 && ageDistribution.length > 0) {
  const ageTotal = ageDistribution.reduce(
    (sum, item) => sum + toNumber(item.value),
    0
  );

  const malePct =
    genderDistribution.find((item) => item.name === "Laki-laki")?.value || 0;

  const femalePct =
    genderDistribution.find((item) => item.name === "Perempuan")?.value || 0;

  ageGenderDistribution = ageDistribution
    .map((item) => {
      const agePct =
        ageTotal > 0 ? (toNumber(item.value) / ageTotal) * 100 : 0;

      return {
        age: item.age,
        "Laki-laki": formatPercent((agePct * malePct) / 100),
        Perempuan: formatPercent((agePct * femalePct) / 100),
        isEstimated: true,
      };
    })
    .filter((item) => item["Laki-laki"] > 0 || item.Perempuan > 0);
}

    const topCities = cityRows
      .map((row) => {
        const rawValue = toNumber(row.metricValue);

        return {
          city: row.breakdownValue,
          value: cityTotal > 0 ? formatPercent((rawValue / cityTotal) * 100) : 0,
          rawValue,
        };
      })
      .filter((item) => item.city && item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const dominantGender = genderDistribution[0]?.name || "-";
    const dominantGenderPct = genderDistribution[0]?.value || 0;

    const dominantAgeGroup =
      [...ageDistribution].sort((a, b) => b.value - a.value)[0]?.age || "-";

    const topCity = topCities[0]?.city || "-";
    const topCityPct = topCities[0]?.value || 0;

    res.json({
      summary: {
        dominantGender,
        dominantGenderPct,
        dominantAgeGroup,
        topCity,
        topCityPct,
      },
      genderDistribution,
      ageGenderDistribution,
      topCities,
      personaInsight: `Audiens Instagram didominasi oleh ${dominantGender} dengan kelompok usia utama ${dominantAgeGroup}. Kota dengan kontribusi audiens terbesar adalah ${topCity}.`,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch audience summary",
      error: error.message,
    });
  }
});export default router;
