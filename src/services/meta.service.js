import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { buildConfigSnapshot } from "./appConfig.service.js";

export const checkMetaTokenHealth = async () => {
  const config = await buildConfigSnapshot();
  if (!config.metaEnabled || !config.metaAccessToken || !config.metaIgUserId) {
    return { status: "not_configured", expiresAt: null, daysRemaining: null };
  }
  const accessToken = config.metaAccessToken;
  const igUserId = config.metaIgUserId;
  const graphVersion = config.metaGraphVersion;
  const baseUrl = (process.env.META_API_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");

  try {
    const accountUrl = `${baseUrl}/${graphVersion}/${igUserId}?fields=username,followers_count`;
    const accountResponse = await fetch(accountUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const accountData = await accountResponse.json();

    if (!accountResponse.ok || accountData.error) {
      const errorSubcode = accountData.error?.error_subcode;
      const isTokenExpired =
        accountData.error?.code === 190 &&
        (errorSubcode === 463 || errorSubcode === 467);
      if (isTokenExpired) {
        return { status: "expired", expiresAt: null, daysRemaining: null };
      }
      return {
        status: "error",
        expiresAt: null,
        daysRemaining: null,
        error:
          accountData.error?.message ||
          `Meta API returned status ${accountResponse.status}`,
      };
    }

    let daysRemaining = null;
    let expiresAt = null;
    try {
      const debugUrl = `${baseUrl}/${graphVersion}/debug_token?input_token=${encodeURIComponent(
        accessToken
      )}&access_token=${encodeURIComponent(accessToken)}`;
      const debugResponse = await fetch(debugUrl);
      const debugData = await debugResponse.json();
      const tokenExpiresAtSec = Number(debugData?.data?.expires_at);
      const expirySec =
        tokenExpiresAtSec > 0
          ? tokenExpiresAtSec
          : Number(debugData?.data?.data_access_expires_at);
      if (expirySec > 0) {
        const expiresMs = expirySec * 1000;
        expiresAt = new Date(expiresMs).toISOString();
        const days = Math.ceil((expiresMs - Date.now()) / 86400000);
        if (days <= 0) {
          return { status: "expired", expiresAt, daysRemaining: 0 };
        }
        daysRemaining = days;
        if (days <= 7) {
          return { status: "critical", expiresAt, daysRemaining };
        }
        if (days <= 30) {
          return { status: "warning", expiresAt, daysRemaining };
        }
      }
    } catch {
      // debug_token lookup is optional; fall back to a generic valid status
    }

    return { status: "valid", expiresAt, daysRemaining };
  } catch (err) {
    return {
      status: "error",
      expiresAt: null,
      daysRemaining: null,
      error: err instanceof Error ? err.message : "Failed to reach Meta API.",
    };
  }
};

// Low-level Meta Graph API access
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 2000;

function sanitizeParams(params) {
  const cleanParams = { ...params };
  delete cleanParams.access_token;
  return cleanParams;
}

export function sanitizeMetaResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetaResponsePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeMetaResponsePayload(nested)])
    );
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/([?&]access_token=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
}

function isRateLimited(data) {
  return (
    data?.error?.code === 4 ||
    data?.error?.error_subcode === 4 ||
    data?.error?.message?.includes("rate limit") ||
    data?.error?.message?.includes("Rate limit")
  );
}

function isTokenExpired(data) {
  return (
    data?.error?.code === 190 ||
    data?.error?.error_subcode === 463 ||
    data?.error?.error_subcode === 467 ||
    data?.error?.message?.includes("OAuthException") ||
    data?.error?.message?.includes("expired") ||
    data?.error?.message?.includes("Session has expired")
  );
}

function isTransientError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("network")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function metaGet(endpoint, params = {}) {
  const config = await buildConfigSnapshot();
  const graphVersion = config.metaGraphVersion || env.metaApiVersion;
  const accessToken = config.metaAccessToken || env.metaAccessToken;

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN is not configured.");
  }

  const cleanEndpoint = endpoint.replace(/^\//, "");
  const baseUrl = env.metaApiBaseUrl || "https://graph.facebook.com";
  const fullUrl = `${baseUrl.replace(/\/$/, "")}/${graphVersion}/${cleanEndpoint}`;

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const url = new URL(fullUrl);

    Object.entries(params).forEach(([key, value]) => {
      if (key === "after" && (value === undefined || value === null || value === "")) return;
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    url.searchParams.set("access_token", accessToken);

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (response.ok && !data.error) {
        await prisma.metaRawResponse.create({
          data: {
            source: "META_INSTAGRAM_API",
            endpoint: `/${cleanEndpoint}`,
            method: "GET",
            params: sanitizeParams(params),
            responseJson: sanitizeMetaResponsePayload(data),
            status: "SUCCESS",
            errorMessage: null,
          },
        }).catch(() => null);

        return data;
      }

      if (isTokenExpired(data)) {
        const msg = data.error?.message || "Meta access token has expired. Please update the token in Settings.";
        await logFailedResponse(cleanEndpoint, params, msg);
        throw new Error(msg);
      }

      if (isRateLimited(data) && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[metaGet] Rate limited on /${cleanEndpoint}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      const msg = data.error?.message || "Meta API request failed";
      await logFailedResponse(cleanEndpoint, params, msg);
      throw new Error(msg);
    } catch (error) {
      if (error.message?.includes("access token") || error.message?.includes("expired")) {
        throw error;
      }

      if (isTransientError(error.message) && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[metaGet] Transient error on /${cleanEndpoint}: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        lastError = error;
        continue;
      }

      if (attempt === MAX_RETRIES) {
        const msg = isTransientError(error.message)
          ? `Meta API unreachable after ${MAX_RETRIES + 1} attempts: ${error.message}`
          : error.message || "Meta API request failed";
        await logFailedResponse(cleanEndpoint, params, msg);
        throw new Error(msg);
      }

      lastError = error;
    }
  }

  const msg = lastError?.message || "Meta API request failed after retries";
  await logFailedResponse(cleanEndpoint, params, msg);
  throw new Error(msg);
}

async function logFailedResponse(endpoint, params, errorMessage) {
  await prisma.metaRawResponse.create({
    data: {
      source: "META_INSTAGRAM_API",
      endpoint: `/${endpoint}`,
      method: "GET",
      params: sanitizeParams(params),
      responseJson: null,
      status: "FAILED",
      errorMessage,
    },
  }).catch(() => null);
}

// Connection/configuration status
export const getPersistedMetaConnectionState = ({ configured, latestSync }) => {
  if (!configured) return "not_configured";
  if (!latestSync) return "ready";

  const latestStatus = latestSync.status?.toLowerCase();
  if (latestStatus === "success") return "connected";
  if (latestStatus === "running") return "syncing";
  return "error";
};

export const resolveMetaConnectionStatus = async ({
  configured,
  latestSync,
  testConnection,
}) => {
  const persistedState = getPersistedMetaConnectionState({ configured, latestSync });

  if (!configured || persistedState === "syncing") {
    return { connectionState: persistedState, connectionError: null };
  }

  const testResult = await testConnection();
  if (!testResult.ok) {
    return {
      connectionState: "error",
      connectionError: testResult.error || "Failed to reach Meta API.",
    };
  }

  return {
    connectionState: persistedState === "ready" ? "ready" : "connected",
    connectionError: null,
  };
};

// Synchronization windows and bounded selection
export const META_HISTORY_MONTHS = 24
export const META_INCREMENTAL_OVERLAP_DAYS = 7
export const META_INITIAL_MEDIA_INSIGHT_LIMIT = 250
export const META_INCREMENTAL_MEDIA_INSIGHT_LIMIT = 60

const toDateString = (value) => new Date(value).toISOString().slice(0, 10)

export function resolveMetaSyncWindow({
  now = new Date(),
  historicalBaselineCompleted = false,
  latestMediaPostedAt = null,
  historyMonths = META_HISTORY_MONTHS,
  overlapDays = META_INCREMENTAL_OVERLAP_DAYS,
} = {}) {
  const end = new Date(now)
  end.setUTCHours(0, 0, 0, 0)

  const historyStart = new Date(end)
  historyStart.setUTCMonth(historyStart.getUTCMonth() - historyMonths)

  if (!historicalBaselineCompleted) {
    return {
      mode: "initial",
      since: toDateString(historyStart),
      until: toDateString(end),
    }
  }

  const latest = latestMediaPostedAt ? new Date(latestMediaPostedAt) : null
  const incrementalStart = latest && !Number.isNaN(latest.getTime())
    ? new Date(latest)
    : new Date(end)
  incrementalStart.setUTCDate(incrementalStart.getUTCDate() - overlapDays)
  if (incrementalStart < historyStart) incrementalStart.setTime(historyStart.getTime())

  return {
    mode: "incremental",
    since: toDateString(incrementalStart),
    until: toDateString(end),
  }
}

export function selectMediaForInsightSync(
  mediaItems,
  mode,
  {
    initialLimit = META_INITIAL_MEDIA_INSIGHT_LIMIT,
    incrementalLimit = META_INCREMENTAL_MEDIA_INSIGHT_LIMIT,
  } = {}
) {
  const limit = mode === "initial" ? initialLimit : incrementalLimit
  return (Array.isArray(mediaItems) ? mediaItems : []).slice(0, Math.max(0, limit))
}

const timestamp = (value, fallback = 0) => {
  const parsed = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export function selectStoredMediaForInsightRefresh(
  mediaItems,
  mode,
  {
    initialLimit = META_INITIAL_MEDIA_INSIGHT_LIMIT,
    incrementalLimit = META_INCREMENTAL_MEDIA_INSIGHT_LIMIT,
    rotation = 0,
  } = {}
) {
  const limit = mode === "initial" ? initialLimit : incrementalLimit

  const ranked = [...(Array.isArray(mediaItems) ? mediaItems : [])]
    .sort((left, right) => {
      const leftInsights = Array.isArray(left?.insights) ? left.insights : []
      const rightInsights = Array.isArray(right?.insights) ? right.insights : []
      const leftLastRefresh = leftInsights.reduce(
        (latest, insight) => Math.max(latest, timestamp(insight?.updatedAt ?? insight?.insightDate)),
        0
      )
      const rightLastRefresh = rightInsights.reduce(
        (latest, insight) => Math.max(latest, timestamp(insight?.updatedAt ?? insight?.insightDate)),
        0
      )

      // Never-synchronized and least-recently synchronized media move to the
      // front. Updating a selected media's daily rows advances its updatedAt,
      // naturally rotating older stored media into later explicit syncs.
      if (leftLastRefresh !== rightLastRefresh) return leftLastRefresh - rightLastRefresh

      // Newer posts win only when refresh age is equal (notably for newly
      // discovered media with no insight rows yet).
      const postedDifference = timestamp(right?.postedAt) - timestamp(left?.postedAt)
      if (postedDifference !== 0) return postedDifference
      return String(left?.id ?? left?.igMediaId ?? "").localeCompare(
        String(right?.id ?? right?.igMediaId ?? "")
      )
    })

  if (!ranked.length || limit <= 0) return []
  const offset = (Math.max(0, Number(rotation) || 0) * limit) % ranked.length
  return [...ranked.slice(offset), ...ranked.slice(0, offset)].slice(0, limit)
}

// General account and follower-snapshot orchestration helpers
const STALE_SYNC_MINUTES = Number(process.env.META_STALE_SYNC_MINUTES || 15);
export function startOfDay(dateInput = new Date()) {
  const date = new Date(dateInput);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function getIgUserId() {
  const config = await buildConfigSnapshot();
  return config.metaIgUserId || process.env.META_IG_USER_ID || "";
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

 

  return account;
}

async function saveFollowerSnapshot(account, snapshotDate = new Date()) {
  if (account?.followersCount == null) return null;

  return prisma.instagramAccountSnapshot.upsert({
  where: {
    accountId_snapshotDate: {
      accountId: account.id,
      snapshotDate,
    },
  },
  update: {
    followersCount: Number(account.followersCount),
    followsCount: numberOrNull(account.followsCount),
    mediaCount: numberOrNull(account.mediaCount),
    rawJson: {
      ...(account.rawJson || {}),
      snapshotType: "sync",
      source: "meta_current_followers_count",
    },
  },
  create: {
    accountId: account.id,
    followersCount: Number(account.followersCount),
    followsCount: numberOrNull(account.followsCount),
    mediaCount: numberOrNull(account.mediaCount),
    snapshotDate,
    rawJson: {
      ...(account.rawJson || {}),
      snapshotType: "sync",
      source: "meta_current_followers_count",
    },
  },
  });
}

// Top-level Meta synchronization orchestration
export async function syncMetaRawToAnalytics({
  now = new Date(),
  performedByUserId = null,
} = {}) {
  const [historicalService, mediaService] = await Promise.all([
    import("./metaHistorical.service.js"),
    import("./metaMedia.service.js"),
  ]);
  const { syncHistoricalAccountMetrics, syncAudienceInsights } = historicalService;
  const {
    fetchAllMedia,
    saveMediaItems,
    saveMediaInsights,
    selectStoredMediaRefreshBatch,
    rebuildMonthlyMediaPerformance,
  } = mediaService;

  const [historicalBaseline, latestStoredMedia] = await Promise.all([
    prisma.metaSyncLog.findFirst({
      where: { syncType: "META_INITIAL_24_MONTH", status: "SUCCESS" },
      select: { id: true },
    }),
    prisma.instagramMedia.findFirst({
      where: { postedAt: { not: null } },
      orderBy: { postedAt: "desc" },
      select: { postedAt: true },
    }),
  ]);
  const syncWindow = resolveMetaSyncWindow({
    now,
    historicalBaselineCompleted: Boolean(historicalBaseline),
    latestMediaPostedAt: latestStoredMedia?.postedAt || null,
  });
  const startDate = syncWindow.since;
  const endDate = syncWindow.until;
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
      syncType:
        syncWindow.mode === "initial"
          ? "META_INITIAL_24_MONTH"
          : "META_INCREMENTAL",
      status: "RUNNING",
      performedByUserId,
    },
  });

  try {
    const account = await saveAccountProfile();
    const historicalAccountSync = await syncHistoricalAccountMetrics({
      prisma,
      accountId: account.id,
      igUserId: account.igUserId,
      now,
    });

    const mediaItems = await fetchAllMedia({
      since: startDate,
      until: endDate,
      contentType: "all",
    });
    const savedMedia = await saveMediaItems(account.id, mediaItems);

    let mediaInsightCount = 0;
    // Discovery stays incremental, while insight refresh rotates independently
    // across the bounded two-year stored-media warehouse.
    const mediaForInsightSync = await selectStoredMediaRefreshBatch({
      now,
      mode: syncWindow.mode,
      discoveredMediaIds: savedMedia.map((media) => media.id),
      newMediaIds: savedMedia
        .filter((media) => media.newlyCreated)
        .map((media) => media.id),
    });

    for (const media of mediaForInsightSync) {
      mediaInsightCount += await saveMediaInsights(media, { now });
    }

const monthlyMediaPerformanceCount = await rebuildMonthlyMediaPerformance(account.id);

// Canonical account-period history is owned by syncHistoricalAccountMetrics.
// The legacy 28-day collectors wrote differently scoped day/total_value rows,
// were not consumed by the dashboard, and repeatedly requested the entire
// media window even when Meta had already established old data was unavailable.
const accountInsightCount = 0;

// Profile Views is collected by syncHistoricalAccountMetrics using the same
// exact account-period request as the other canonical historical KPIs. Do not
// run the legacy chunked collector afterward: it can overwrite that value with
// a differently scoped aggregate.
const monthlyProfileViewsInsightCount = 0;

const followUnfollowInsightCount = 0;
const viewsBreakdownInsightCount = 0;

    const audienceInsightCount = await syncAudienceInsights(account.id);
    await saveFollowerSnapshot(account);

    await prisma.metaSyncLog.update({
      where: { id: log.id },
      data: {
        status: "SUCCESS",
        message: `Synced ${savedMedia.length} media, refreshed insights for ${mediaForInsightSync.length} media item(s), ${mediaInsightCount} media insights, ${monthlyMediaPerformanceCount} monthly media performance rows, attempted ${historicalAccountSync.monthsAttempted} historical account month(s), ${accountInsightCount} account insights, ${audienceInsightCount} audience insights.`,
        finishedAt: new Date(),
      },
    });

    return {
      success: true,
      mode: syncWindow.mode,
      since: startDate,
      until: endDate,
      mediaCount: savedMedia.length,
      mediaInsightCount,
      mediaInsightLimit: mediaForInsightSync.length,
      monthlyMediaPerformanceCount,
      historicalAccountSync,
      accountInsightCount,
      audienceInsightCount,
      viewsBreakdownInsightCount,
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
