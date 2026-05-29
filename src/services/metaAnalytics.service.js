import { prisma } from "../config/prisma.js";
import { metaGet } from "./metaRaw.service.js";

const IG_USER_ID = process.env.META_IG_USER_ID;

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
  const accountData = await metaGet(`/${IG_USER_ID}`, {
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

  const today = startOfDay();

  await prisma.instagramAccountSnapshot.upsert({
    where: {
      accountId_snapshotDate: {
        accountId: account.id,
        snapshotDate: today,
      },
    },
    update: {
      followersCount: accountData.followers_count ?? null,
      followsCount: accountData.follows_count ?? null,
      mediaCount: accountData.media_count ?? null,
      rawJson: accountData,
    },
    create: {
      accountId: account.id,
      snapshotDate: today,
      followersCount: accountData.followers_count ?? null,
      followsCount: accountData.follows_count ?? null,
      mediaCount: accountData.media_count ?? null,
      rawJson: accountData,
    },
  });

  return account;
}

async function fetchAllMedia() {
  const mediaItems = [];
  let after = null;
  let hasNext = true;

  while (hasNext) {
    const data = await metaGet(`/${IG_USER_ID}/media`, {
      fields:
        "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp",
      limit: 100,
      after,
    });

    mediaItems.push(...(data.data || []));

    after = data.paging?.cursors?.after || null;
    hasNext = Boolean(data.paging?.next && after);
  }

  return mediaItems;
}

async function saveMediaItems(accountId, mediaItems) {
  const saved = [];

  for (const item of mediaItems) {
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
      },
    });

    saved.push(media);
  }

  return saved;
}

async function fetchOneMediaMetric(igMediaId, metricName) {
  try {
    return await metaGet(`/${igMediaId}/insights`, {
      metric: metricName,
    });
  } catch (error) {
    console.warn(`Metric ${metricName} failed for media ${igMediaId}: ${error.message}`);
    return null;
  }
}

async function saveMediaInsights(media) {
  const metrics = [
    "views",
    "reach",
    "likes",
    "comments",
    "shares",
    "saved",
    "total_interactions",
  ];

  const today = startOfDay();
  let savedCount = 0;

  for (const metricName of metrics) {
    const insightResponse = await fetchOneMediaMetric(media.igMediaId, metricName);

    if (!insightResponse?.data?.length) {
      continue;
    }

    for (const metric of insightResponse.data) {
      const valueItem = metric.values?.[0];
      const metricValue = valueItem?.value ?? metric.total_value?.value ?? null;

      await prisma.instagramMediaInsight.upsert({
        where: {
          mediaId_metricName_insightDate_period: {
            mediaId: media.id,
            metricName: metric.name,
            insightDate: today,
            period: metric.period || "lifetime",
          },
        },
        update: {
          metricValue: numberOrNull(metricValue),
          rawJson: metric,
        },
        create: {
          mediaId: media.id,
          metricName: metric.name,
          metricValue: numberOrNull(metricValue),
          period: metric.period || "lifetime",
          insightDate: today,
          rawJson: metric,
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
  let savedCount = 0;

  const reach = await metaGet(`/${IG_USER_ID}/insights`, {
    metric: "reach",
    period: "day",
    since,
    until,
  });

  savedCount += await saveAccountInsightValues(accountId, reach);

  const profileViews = await metaGet(`/${IG_USER_ID}/insights`, {
    metric: "profile_views",
    period: "day",
    metric_type: "total_value",
    since,
    until,
  });

  savedCount += await saveAccountInsightValues(accountId, profileViews);

  return savedCount;
}

async function syncAudienceInsights(accountId) {
  const today = startOfDay();

  const metrics = [
    "follower_demographics",
    "reached_audience_demographics",
    "engaged_audience_demographics",
  ];

  let savedCount = 0;

  for (const metricName of metrics) {
    try {
      const data = await metaGet(`/${IG_USER_ID}/insights`, {
        metric: metricName,
        period: "lifetime",
        metric_type: "total_value",
        breakdowns: "age,gender,city,country",
      });

      for (const metric of data.data || []) {
        const breakdowns = metric.total_value?.breakdowns || [];

        for (const breakdown of breakdowns) {
          const keys = breakdown.dimension_keys || [];
          const results = breakdown.results || [];

          for (const result of results) {
            const values = result.dimension_values || [];
            const metricValue = result.value?.value ?? result.value ?? null;

            for (let index = 0; index < keys.length; index++) {
              const breakdownType = keys[index];
              const breakdownValue = values[index];

              if (!breakdownType || !breakdownValue) continue;

              await prisma.instagramAudienceInsight.upsert({
                where: {
                  accountId_metricName_breakdownType_breakdownValue_insightDate_period: {
                    accountId,
                    metricName: metric.name,
                    breakdownType,
                    breakdownValue,
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
                  metricName: metric.name,
                  breakdownType,
                  breakdownValue,
                  metricValue: numberOrNull(metricValue),
                  period: metric.period || "lifetime",
                  insightDate: today,
                  rawJson: result,
                },
              });

              savedCount++;
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Audience metric ${metricName} failed: ${error.message}`);
    }
  }

  return savedCount;
}

export async function syncMetaRawToAnalytics({ since, until } = {}) {
  const startDate = since || dateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const endDate = until || dateString(new Date());

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

    for (const media of savedMedia) {
      mediaInsightCount += await saveMediaInsights(media);
    }

    const accountInsightCount = await syncAccountInsights(
      account.id,
      startDate,
      endDate
    );

    const audienceInsightCount = await syncAudienceInsights(account.id);

    await prisma.metaSyncLog.update({
      where: { id: log.id },
      data: {
        status: "SUCCESS",
        message: `Synced ${savedMedia.length} media, ${mediaInsightCount} media insights, ${accountInsightCount} account insights, ${audienceInsightCount} audience insights.`,
        finishedAt: new Date(),
      },
    });

    return {
      success: true,
      since: startDate,
      until: endDate,
      mediaCount: savedMedia.length,
      mediaInsightCount,
      accountInsightCount,
      audienceInsightCount,
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