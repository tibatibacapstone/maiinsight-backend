import { prisma } from "../config/prisma.js";
import { getIgUserId, metaGet, numberOrNull, startOfDay } from "./meta.service.js";

// Canonical account-level history and retry policy
export const HISTORICAL_ACCOUNT_MONTHS = 24;
export const RECENT_ACCOUNT_MONTHS_TO_REFRESH = 2;
export const FAILED_HISTORICAL_MONTH_RETRIES_PER_SYNC = 2;

const BASE_METRICS = [
  "views",
  "reach",
  "total_interactions",
  "profile_views",
];

const FOLLOW_UNFOLLOW_METRIC = "follows_and_unfollows";
const MAX_META_INSIGHT_RANGE_DAYS = 28;

const BREAKDOWN_METRICS = [
  ["views", "views_from_followers", "views_from_non_followers"],
  ["reach", "reach_from_followers", "reach_from_non_followers"],
];

export const HISTORICAL_ACCOUNT_METRICS = [
  ...BASE_METRICS,
  "follows",
  "unfollows",
  "views_from_followers",
  "views_from_non_followers",
  "reach_from_followers",
  "reach_from_non_followers",
];

const dateOnly = (value) => new Date(value).toISOString().slice(0, 10);

export function buildHistoricalInsightChunks(
  start,
  endInclusive,
  maxDays = MAX_META_INSIGHT_RANGE_DAYS
) {
  const chunks = [];
  let cursor = new Date(start);
  const end = new Date(endInclusive);

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      start: new Date(cursor),
      endInclusive: new Date(chunkEnd),
      since: dateOnly(cursor),
      until: dateOnly(chunkEnd),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return chunks;
}

function toMetaInclusiveRange(range, now) {
  const syncBoundary = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  const monthEndInclusive = new Date(range.endExclusive);
  monthEndInclusive.setUTCDate(monthEndInclusive.getUTCDate() - 1);
  const endInclusive = monthEndInclusive > syncBoundary ? syncBoundary : monthEndInclusive;
  return {
    ...range,
    endInclusive,
    until: dateOnly(endInclusive),
  };
}

export function buildHistoricalCalendarMonths(
  now = new Date(),
  count = HISTORICAL_ACCOUNT_MONTHS
) {
  const endMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const ranges = [];

  for (let offset = Math.max(0, count) - 1; offset >= 0; offset -= 1) {
    const start = new Date(
      Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - offset, 1)
    );
    const endExclusive = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
    );
    ranges.push({
      start,
      endExclusive,
      since: dateOnly(start),
      until: dateOnly(endExclusive),
    });
  }

  return ranges;
}

function parseMetricValue(response) {
  let available = false;
  let value = 0;

  for (const metric of response?.data || []) {
    if (metric?.total_value?.value !== undefined && metric.total_value.value !== null) {
      available = true;
      value += Number(metric.total_value.value);
    } else {
      for (const item of metric?.values || []) {
        if (item?.value !== undefined && item.value !== null) {
          available = true;
          value += Number(item.value);
        }
      }
    }
  }

  return { available, value: available ? value : null };
}

function parseFollowTypeBreakdown(response) {
  let followers = 0;
  let nonFollowers = 0;
  let available = false;

  for (const metric of response?.data || []) {
    for (const breakdown of metric?.total_value?.breakdowns || []) {
      for (const result of breakdown?.results || []) {
        const label = String(
          result?.dimension_values?.[0] ??
            result?.dimension_value ??
            result?.name ??
            ""
        ).toLowerCase();
        const rawValue =
          result?.value?.value ?? result?.value ?? result?.metric_value;
        if (rawValue === undefined || rawValue === null) continue;
        const numericValue = Number(rawValue);
        if (!Number.isFinite(numericValue)) continue;
        available = true;
        if (label.includes("non")) nonFollowers += numericValue;
        else if (label.includes("follower")) followers += numericValue;
      }
    }
  }

  return {
    available,
    followers: available ? followers : null,
    nonFollowers: available ? nonFollowers : null,
  };
}

function parseFollowUnfollowBreakdown(response) {
  const result = {
    follows: 0,
    unfollows: 0,
    followsAvailable: false,
    unfollowsAvailable: false,
  };
  for (const metric of response?.data || []) {
    for (const breakdown of metric?.total_value?.breakdowns || []) {
      for (const item of breakdown?.results || []) {
        const label = String(
          item?.dimension_values?.[0] ?? item?.dimension_value ?? item?.name ?? ""
        ).toLowerCase();
        const rawValue = item?.value?.value ?? item?.value ?? item?.metric_value;
        if (rawValue === undefined || rawValue === null) continue;
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        // Meta returns FOLLOWER/NON_FOLLOWER for the follow_type breakdown of
        // follows_and_unfollows. In this metric-specific response those are the
        // follow and unfollow result buckets respectively.
        if (label.includes("unfollow") || label === "non_follower") {
          result.unfollows += value;
          result.unfollowsAvailable = true;
        } else if (label === "follow" || label === "follower" || label.includes("follows")) {
          result.follows += value;
          result.followsAvailable = true;
        }
      }
    }
  }
  return result;
}

function sanitizedError(error) {
  return {
    name: error instanceof Error ? error.name : "MetaRequestError",
    message: error instanceof Error ? error.message : String(error),
  };
}

const RETENTION_ERROR_PATTERNS = [
  /retention/i,
  /outside (?:the )?(?:available|supported|historical) (?:range|window)/i,
  /older than/i,
  /cannot request data before/i,
  /only available for the (?:last|past)/i,
];

const UNSUPPORTED_ERROR_PATTERNS = [
  /not supported/i,
  /unsupported/i,
  /invalid metric/i,
  /does not support/i,
];

export function classifyHistoricalAttempt({ available, empty = false, error = null }) {
  if (available) return { status: "available", reason: null };
  const message = error instanceof Error ? error.message : String(error || "");
  if (RETENTION_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return { status: "unavailable", reason: "historical_retention" };
  }
  if (UNSUPPORTED_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return { status: "unsupported", reason: "metric_or_request_unsupported" };
  }
  if (empty) return { status: "unavailable", reason: "empty_meta_dataset" };
  return { status: "api_error", reason: "meta_request_failed" };
}

function logHistoricalAttempt({ metricName, range, status, reason, value }) {
  if (process.env.NODE_ENV === "test") return;
  const suffix = status === "available"
    ? `value=${value}`
    : `reason=${reason}`;
  console.info(`[Meta Historical] metric=${metricName} month=${range.since.slice(0, 7)} status=${status} ${suffix}`);
}

async function persistHistoricalMetric({
  prisma,
  accountId,
  metricName,
  range,
  value,
  available,
  request,
  error = null,
  empty = false,
}) {
  const key = {
    accountId,
    metricName,
    insightDate: range.start,
    period: "month",
  };
  const existing = await prisma.instagramAccountInsight.findUnique({
    where: { accountId_metricName_insightDate_period: key },
  });
  const attempt = classifyHistoricalAttempt({ available, empty, error });
  const preserved = !available && existing?.metricValue != null;
  const metricValue = available ? value : existing?.metricValue ?? null;
  const status = metricValue != null
    ? (Number(metricValue) === 0 ? "zero" : "available")
    : attempt.status;
  const rawJson = {
    source: "historical_account_period",
    status,
    reason: preserved ? existing?.rawJson?.reason ?? null : attempt.reason,
    available: metricValue != null,
    lastAttemptAvailable: available,
    lastAttemptStatus: available && Number(value) === 0 ? "zero" : attempt.status,
    lastAttemptReason: attempt.reason,
    preservedStoredValue: preserved,
    periodStart: range.since,
    periodEndInclusive: range.until,
    periodEndExclusive: dateOnly(range.endExclusive),
    lastAttemptAt: new Date().toISOString(),
    request,
    ...(error ? { error: sanitizedError(error) } : {}),
  };

  // An empty, unsupported, retention-limited, or failed response must never
  // erase a previously captured numeric value (including an explicit zero).
  await prisma.instagramAccountInsight.upsert({
    where: { accountId_metricName_insightDate_period: key },
    update: { metricValue, rawJson },
    create: { ...key, metricValue, rawJson },
  });
  logHistoricalAttempt({
    metricName,
    range,
    status: available && Number(value) === 0 ? "zero" : attempt.status,
    reason: attempt.reason,
    value,
  });
}

async function syncBaseMetric({ prisma, accountId, igUserId, metricName, range, fetchMetric }) {
  const requests = [{
    metric: metricName, period: "day", metric_type: "total_value",
    since: range.since, until: range.until,
  }];
  try {
    const parsed = parseMetricValue(
      await fetchMetric(`/${igUserId}/insights`, requests[0])
    );
    if (!parsed.available) {
      await persistHistoricalMetric({
        prisma, accountId, metricName, range, value: null,
        available: false, request: requests, empty: true,
      });
      return { available: false, requestCount: requests.length };
    }
    await persistHistoricalMetric({
      prisma, accountId, metricName, range, value: parsed.value,
      available: true, request: requests,
    });
    return { available: true, requestCount: requests.length };
  } catch (error) {
    await persistHistoricalMetric({
      prisma, accountId, metricName, range, value: null, available: false,
      request: requests, error,
    });
    return { available: false, requestCount: requests.length };
  }
}

async function syncBreakdownMetric({
  prisma,
  accountId,
  igUserId,
  sourceMetric,
  followersMetric,
  nonFollowersMetric,
  range,
  fetchMetric,
}) {
  const requests = [{
    metric: sourceMetric, period: "day", metric_type: "total_value",
    breakdown: "follow_type", since: range.since, until: range.until,
  }];
  try {
    const parsed = parseFollowTypeBreakdown(
      await fetchMetric(`/${igUserId}/insights`, requests[0])
    );
    if (!parsed.available) {
      for (const metricName of [followersMetric, nonFollowersMetric]) {
        await persistHistoricalMetric({
          prisma, accountId, metricName, range, value: null,
          available: false, request: requests, empty: true,
        });
      }
      return { available: false, requestCount: requests.length };
    }
    await persistHistoricalMetric({
      prisma, accountId, metricName: followersMetric, range,
      value: parsed.followers, available: true, request: requests,
    });
    await persistHistoricalMetric({
      prisma, accountId, metricName: nonFollowersMetric, range,
      value: parsed.nonFollowers, available: true, request: requests,
    });
    return { available: true, requestCount: requests.length };
  } catch (error) {
    for (const metricName of [followersMetric, nonFollowersMetric]) {
      await persistHistoricalMetric({
        prisma, accountId, metricName, range, value: null,
        available: false, request: requests, error,
      });
    }
    return { available: false, requestCount: requests.length };
  }
}

async function syncFollowUnfollowMetric({ prisma, accountId, igUserId, range, fetchMetric }) {
  const requests = [{
    metric: FOLLOW_UNFOLLOW_METRIC, period: "day", metric_type: "total_value",
    breakdown: "follow_type", since: range.since, until: range.until,
  }];
  const totals = { follows: 0, unfollows: 0 };
  const availability = { follows: true, unfollows: true };
  let error = null;
  try {
    const parsed = parseFollowUnfollowBreakdown(
      await fetchMetric(`/${igUserId}/insights`, requests[0])
    );
    for (const metricName of ["follows", "unfollows"]) {
      const key = `${metricName}Available`;
      if (!parsed[key]) availability[metricName] = false;
      else totals[metricName] = parsed[metricName];
    }
  } catch (caught) {
    error = caught;
    availability.follows = false;
    availability.unfollows = false;
  }
  for (const metricName of ["follows", "unfollows"]) {
    const metricError = error || null;
    await persistHistoricalMetric({
      prisma, accountId, metricName, range,
      value: availability[metricName] ? totals[metricName] : null,
      available: availability[metricName], request: requests, error: metricError,
      empty: !error && !availability[metricName],
    });
  }
  return {
    availableCount: Number(availability.follows) + Number(availability.unfollows),
    requestCount: requests.length,
  };
}

export async function resolveHistoricalRangesToSync({
  prisma,
  accountId,
  now = new Date(),
  historyMonths = HISTORICAL_ACCOUNT_MONTHS,
  recentMonths = RECENT_ACCOUNT_MONTHS_TO_REFRESH,
  failedMonthRetryLimit = FAILED_HISTORICAL_MONTH_RETRIES_PER_SYNC,
}) {
  const ranges = buildHistoricalCalendarMonths(now, historyMonths);
  if (!ranges.length) return [];
  const existing = await prisma.instagramAccountInsight.findMany({
    where: {
      accountId,
      period: "month",
      metricName: { in: HISTORICAL_ACCOUNT_METRICS },
      insightDate: { gte: ranges[0].start, lt: ranges.at(-1).endExclusive },
    },
    select: {
      metricName: true,
      metricValue: true,
      insightDate: true,
      rawJson: true,
      updatedAt: true,
    },
  });
  const attempted = new Set(
    existing.map((row) => `${dateOnly(row.insightDate)}:${row.metricName}`)
  );
  const recentStart = Math.max(0, ranges.length - Math.max(1, recentMonths));
  const failedMonths = new Map();
  for (const row of existing) {
    if (row.metricValue != null) continue;
    const legacyApiError = row.rawJson?.lastAttemptStatus == null && row.rawJson?.error;
    if (row.rawJson?.lastAttemptStatus !== "api_error" && !legacyApiError) continue;
    const month = dateOnly(row.insightDate);
    const attemptedAt = new Date(row.rawJson?.lastAttemptAt || row.updatedAt || 0).getTime();
    const previous = failedMonths.get(month);
    if (previous == null || attemptedAt > previous) failedMonths.set(month, attemptedAt);
  }
  const missing = ranges.filter((range, index) =>
    index < recentStart && HISTORICAL_ACCOUNT_METRICS.some(
      (metric) => !attempted.has(`${range.since}:${metric}`)
    )
  );
  const missingKeys = new Set(missing.map((range) => range.since));
  const retryFailed = ranges
    .filter((range, index) =>
      index < recentStart &&
      !missingKeys.has(range.since) &&
      failedMonths.has(range.since)
    )
    .sort((left, right) =>
      failedMonths.get(left.since) - failedMonths.get(right.since)
    )
    .slice(0, Math.max(0, failedMonthRetryLimit));
  const recent = ranges.slice(recentStart);
  const selectedKeys = new Set(
    [...missing, ...retryFailed, ...recent].map((range) => range.since)
  );
  return ranges.filter((range) => selectedKeys.has(range.since));
}

export async function syncHistoricalAccountMetrics({
  prisma,
  accountId,
  igUserId,
  now = new Date(),
  historyMonths = HISTORICAL_ACCOUNT_MONTHS,
  fetchMetric = metaGet,
}) {
  const ranges = await resolveHistoricalRangesToSync({
    prisma, accountId, now, historyMonths,
  });
  let availableMetricCount = 0;
  let requestCount = 0;

  // Sequential by design: bounded chunk requests are never concurrent.
  for (const originalRange of ranges) {
    const range = toMetaInclusiveRange(originalRange, now);
    if (range.start > range.endInclusive) continue;
    for (const metricName of BASE_METRICS) {
      const result = await syncBaseMetric({
        prisma, accountId, igUserId, metricName, range, fetchMetric,
      });
      availableMetricCount += Number(result.available);
      requestCount += result.requestCount;
    }
    for (const [sourceMetric, followersMetric, nonFollowersMetric] of BREAKDOWN_METRICS) {
      const result = await syncBreakdownMetric({
        prisma, accountId, igUserId, sourceMetric, followersMetric,
        nonFollowersMetric, range, fetchMetric,
      });
      availableMetricCount += Number(result.available);
      requestCount += result.requestCount;
    }
    const followResult = await syncFollowUnfollowMetric({
      prisma, accountId, igUserId, range, fetchMetric,
    });
    availableMetricCount += followResult.availableCount;
    requestCount += followResult.requestCount;
  }

  return {
    monthsAttempted: ranges.length,
    requestCount,
    availableMetricCount,
    ranges: ranges.map(({ since, until }) => ({ since, until })),
  };
}

// Metric availability
export function metricValueOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function hasAvailableMetric(insights, metricNames) {
  const acceptedNames = new Set(metricNames);
  return insights.some(
    (insight) =>
      acceptedNames.has(insight.metricName) &&
      metricValueOrNull(insight.metricValue) !== null
  );
}

// Historical dashboard aggregation
export const HISTORICAL_DASHBOARD_METRICS = [
  "views",
  "reach",
  "total_interactions",
  "profile_views",
  "follows",
  "unfollows",
  "views_from_followers",
  "views_from_non_followers",
  "reach_from_followers",
  "reach_from_non_followers",
];

const monthKey = (value) => new Date(value).toISOString().slice(0, 7);

function availableRows(rows, metricName) {
  return rows.filter(
    (row) =>
      row.metricName === metricName &&
      row.metricValue !== null &&
      row.metricValue !== undefined &&
      row.rawJson?.available !== false
  );
}

function totalFor(rows, metricName) {
  const matched = availableRows(rows, metricName);
  if (!matched.length) return null;
  return matched.reduce((sum, row) => sum + Number(row.metricValue), 0);
}

function rate(numerator, denominator) {
  if (numerator == null || denominator == null) return null;
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function rateForCompatibleMonths(rows, numeratorMetric, denominatorMetric) {
  const numeratorByMonth = new Map();
  const denominatorByMonth = new Map();

  for (const row of availableRows(rows, numeratorMetric)) {
    const month = monthKey(row.insightDate);
    numeratorByMonth.set(month, (numeratorByMonth.get(month) || 0) + Number(row.metricValue));
  }
  for (const row of availableRows(rows, denominatorMetric)) {
    const month = monthKey(row.insightDate);
    denominatorByMonth.set(month, (denominatorByMonth.get(month) || 0) + Number(row.metricValue));
  }

  const compatibleMonths = [...numeratorByMonth.keys()].filter((month) =>
    denominatorByMonth.has(month)
  );
  if (!compatibleMonths.length) return null;

  const numerator = compatibleMonths.reduce((sum, month) => sum + numeratorByMonth.get(month), 0);
  const denominator = compatibleMonths.reduce((sum, month) => sum + denominatorByMonth.get(month), 0);
  return rate(numerator, denominator);
}

export function aggregateHistoricalAccountMetrics(rows = []) {
  const totalViews = totalFor(rows, "views");
  const totalReach = totalFor(rows, "reach");
  const totalInteractions = totalFor(rows, "total_interactions");
  const totalProfileViews = totalFor(rows, "profile_views");
  const viewsFromFollowers = totalFor(rows, "views_from_followers");
  const viewsFromNonFollowers = totalFor(rows, "views_from_non_followers");
  const reachFromFollowers = totalFor(rows, "reach_from_followers");
  const reachFromNonFollowers = totalFor(rows, "reach_from_non_followers");
  const newFollowsCount = totalFor(rows, "follows");
  const unfollowsCount = totalFor(rows, "unfollows");

  return {
    totalViews,
    totalReach,
    totalInteractions,
    totalProfileViews,
    viewsFromFollowers,
    viewsFromNonFollowers,
    reachFromFollowers,
    reachFromNonFollowers,
    newFollowsCount,
    unfollowsCount,
    engagementRate: rateForCompatibleMonths(rows, "total_interactions", "reach"),
    profileVisitRate: rateForCompatibleMonths(rows, "profile_views", "reach"),
  };
}

export function buildHistoricalAccountTrend(rows = []) {
  const months = new Map();
  for (const row of rows) {
    const key = monthKey(row.insightDate);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(row);
  }

  return Array.from(months.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, monthRows]) => {
      const metrics = aggregateHistoricalAccountMetrics(monthRows);
      return {
        month,
        views: metrics.totalViews,
        reach: metrics.totalReach,
        interactions: metrics.totalInteractions,
        profileViews: metrics.totalProfileViews,
      };
    });
}

export function buildHistoricalCoverage(rows = [], totalMonths = null) {
  const metricCoverage = Object.fromEntries(
    HISTORICAL_DASHBOARD_METRICS.map((metricName) => {
      const attemptedMonths = new Set(
        rows.filter((row) => row.metricName === metricName).map((row) => monthKey(row.insightDate))
      );
      const availableMonths = new Set(
        availableRows(rows, metricName).map((row) => monthKey(row.insightDate))
      );
      const expectedMonths = totalMonths ?? attemptedMonths.size;
      return [metricName, {
        source: "historical_account",
        attemptedMonths: attemptedMonths.size,
        availableMonths: availableMonths.size,
        totalMonths: expectedMonths,
        complete: availableMonths.size === expectedMonths,
        availability:
          availableMonths.size === 0
            ? "unavailable"
            : availableMonths.size < expectedMonths
              ? "partial"
              : "available",
        aggregation: "sum_of_monthly_period_values",
      }];
    })
  );

  const rateCoverage = (numeratorMetric, denominatorMetric) => {
    const numeratorAttempted = new Set(
      rows.filter((row) => row.metricName === numeratorMetric).map((row) => monthKey(row.insightDate))
    );
    const denominatorAttempted = new Set(
      rows.filter((row) => row.metricName === denominatorMetric).map((row) => monthKey(row.insightDate))
    );
    const numeratorAvailable = new Set(
      availableRows(rows, numeratorMetric).map((row) => monthKey(row.insightDate))
    );
    const denominatorAvailable = new Set(
      availableRows(rows, denominatorMetric).map((row) => monthKey(row.insightDate))
    );
    const attemptedMonths = new Set([...numeratorAttempted, ...denominatorAttempted]);
    const availableMonths = new Set(
      [...numeratorAvailable].filter((month) => denominatorAvailable.has(month))
    );
    const expectedMonths = totalMonths ?? attemptedMonths.size;

    return {
      source: "historical_account",
      attemptedMonths: attemptedMonths.size,
      availableMonths: availableMonths.size,
      totalMonths: expectedMonths,
      complete: availableMonths.size === expectedMonths,
      availability:
        availableMonths.size === 0
          ? "unavailable"
          : availableMonths.size < expectedMonths
            ? "partial"
            : "available",
      aggregation: `ratio_of_compatible_monthly_${numeratorMetric}_to_${denominatorMetric}`,
    };
  };

  return {
    ...metricCoverage,
    engagement_rate: rateCoverage("total_interactions", "reach"),
    profile_visit_rate: rateCoverage("profile_views", "reach"),
  };
}

// Legacy historical collectors retained unchanged for compatibility
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

export async function syncAccountInsightsInChunks(accountId, since, until) {
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

export async function syncAudienceInsights(accountId) {
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

export async function rebuildMonthlyViewsBreakdown(accountId, since, until) {
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
    const hasBreakdownData = breakdown.available;

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

export async function rebuildMonthlyReachBreakdown(accountId, since, until) {
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
    const hasBreakdownData = breakdown.available;

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

export async function rebuildMonthlyInteractionsBreakdown(accountId, since, until) {
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

export async function syncViewsBreakdownInsights(accountId, since, until) {
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
  let available = false;

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
          available = true;
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
    available,
    rawJson: rawResponses,
  };
}
async function fetchReachBreakdownForMonth(since, until) {
  const igUserId = await getIgUserId();
  const chunks = buildDateChunks(since, until, 28);

  let reachFromFollowers = 0;
  let reachFromNonFollowers = 0;
  const rawResponses = [];
  let available = false;

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
          available = true;
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
    available,
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
    let currentEnd = addDays(currentStart, maxDays - 1);

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
  let followsAvailable = false;
  let unfollowsAvailable = false;

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

        // Meta's follows_and_unfollows follow_type response uses
        // FOLLOWER/NON_FOLLOWER as its two result buckets.
        if (normalized.includes("unfollow") || normalized === "non_follower") {
          unfollows += value;
          unfollowsAvailable = true;
        } else if (
          normalized === "follow" ||
          normalized === "follower" ||
          normalized.includes("follows")
        ) {
          follows += value;
          followsAvailable = true;
        }
      }
    }
  }

  return {
    follows,
    unfollows,
    followsAvailable,
    unfollowsAvailable,
    hasBreakdown: followsAvailable || unfollowsAvailable,
  };
}

export async function syncFollowUnfollowInsights(accountId, since, until) {
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
    let followsAvailable = false;
    let unfollowsAvailable = false;

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
      followsAvailable = parsed.followsAvailable;
      unfollowsAvailable = parsed.unfollowsAvailable;

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

    if (followsAvailable) await saveAccountInsightMetric({
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

    if (unfollowsAvailable) await saveAccountInsightMetric({
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

    savedCount += Number(followsAvailable) + Number(unfollowsAvailable);
  }

  return savedCount;
}

export async function collectCompleteProfileViews(chunks, fetchRange) {
  let value = 0;
  const results = [];
  for (const chunk of chunks) {
    const result = await fetchRange(chunk.since, chunk.until);
    results.push({ chunk, result });
    if (!result.available) return { available: false, value: null, results };
    value += Number(result.profileViews);
  }
  return { available: chunks.length > 0, value: chunks.length ? value : null, results };
}
