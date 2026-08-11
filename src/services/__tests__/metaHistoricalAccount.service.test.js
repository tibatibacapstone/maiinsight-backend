import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistoricalCalendarMonths,
  buildHistoricalInsightChunks,
  classifyHistoricalAttempt,
  HISTORICAL_ACCOUNT_METRICS,
  resolveHistoricalRangesToSync,
  syncHistoricalAccountMetrics,
} from "../metaHistorical.service.js";

function createPrisma(existingRows = []) {
  const rows = new Map();
  const keyFor = ({ accountId, metricName, insightDate, period }) =>
    `${accountId}:${metricName}:${new Date(insightDate).toISOString()}:${period}`;
  for (const row of existingRows) rows.set(keyFor(row), row);

  return {
    rows,
    instagramAccountInsight: {
      findMany: async () => Array.from(rows.values()),
      findUnique: async ({ where }) =>
        rows.get(keyFor(where.accountId_metricName_insightDate_period)) || null,
      upsert: async ({ where, update, create }) => {
        const key = keyFor(where.accountId_metricName_insightDate_period);
        const value = rows.has(key) ? { ...rows.get(key), ...update } : create;
        rows.set(key, value);
        return value;
      },
    },
  };
}

test("calendar months use exact inclusive start and exclusive next-month end", () => {
  const [january, february] = buildHistoricalCalendarMonths(
    new Date("2026-02-15T00:00:00Z"),
    2
  );
  assert.deepEqual(
    { since: january.since, until: january.until },
    { since: "2026-01-01", until: "2026-02-01" }
  );
  assert.deepEqual(
    { since: february.since, until: february.until },
    { since: "2026-02-01", until: "2026-03-01" }
  );
});

test("historical attempt classification distinguishes empty, retention, unsupported, and API errors", () => {
  assert.deepEqual(classifyHistoricalAttempt({ available: false, empty: true }), {
    status: "unavailable", reason: "empty_meta_dataset",
  });
  assert.deepEqual(classifyHistoricalAttempt({ available: false, error: new Error("Data is outside the historical range") }), {
    status: "unavailable", reason: "historical_retention",
  });
  assert.deepEqual(classifyHistoricalAttempt({ available: false, error: new Error("Metric is not supported") }), {
    status: "unsupported", reason: "metric_or_request_unsupported",
  });
  assert.deepEqual(classifyHistoricalAttempt({ available: false, error: new Error("temporary outage") }), {
    status: "api_error", reason: "meta_request_failed",
  });
});

test("historical chunks cover calendar ranges without gaps, overlap, or requests over 28 days", () => {
  for (const month of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const start = new Date(Date.UTC(2026, month, 1));
    const end = new Date(Date.UTC(2026, month + 1, 0));
    const chunks = buildHistoricalInsightChunks(start, end);
    assert.equal(chunks[0].since, start.toISOString().slice(0, 10));
    assert.equal(chunks.at(-1).until, end.toISOString().slice(0, 10));
    const covered = [];
    chunks.forEach((chunk, index) => {
      assert.ok((chunk.endInclusive - chunk.start) / 86400000 <= 27);
      if (index) {
        const expectedStart = new Date(chunks[index - 1].endInclusive);
        expectedStart.setUTCDate(expectedStart.getUTCDate() + 1);
        assert.equal(chunk.since, expectedStart.toISOString().slice(0, 10));
      }
      for (let day = new Date(chunk.start); day <= chunk.endInclusive; day.setUTCDate(day.getUTCDate() + 1)) {
        covered.push(day.toISOString().slice(0, 10));
      }
    });
    assert.equal(new Set(covered).size, covered.length);
    assert.equal(covered.length, end.getUTCDate());
    assert.ok(covered.every((date) => date.startsWith(`2026-${String(month + 1).padStart(2, "0")}`)));
  }
});

test("February chunking covers leap and non-leap months exactly", () => {
  for (const year of [2026, 2028]) {
    const chunks = buildHistoricalInsightChunks(
      new Date(Date.UTC(year, 1, 1)),
      new Date(Date.UTC(year, 2, 0))
    );
    assert.equal(chunks[0].since, `${year}-02-01`);
    assert.equal(chunks.at(-1).until, `${year}-02-${year === 2028 ? "29" : "28"}`);
    assert.ok(chunks.every((chunk) => (chunk.endInclusive - chunk.start) / 86400000 <= 27));
  }
});

test("historical sync requests a bounded set of real account metrics and stores period rows", async () => {
  const prisma = createPrisma();
  const calls = [];
  const fetchMetric = async (path, params) => {
    calls.push({ path, params });
    if (params.breakdown) {
      return {
        data: [{ total_value: { breakdowns: [{ results: [
          { dimension_values: ["FOLLOWER"], value: 4 },
          { dimension_values: ["NON_FOLLOWER"], value: 6 },
        ] }] } }],
      };
    }
    if (params.metric === "profile_views") return { data: [] };
    return { data: [{ name: params.metric, total_value: { value: params.metric === "views" ? 0 : 10 } }] };
  };

  const result = await syncHistoricalAccountMetrics({
    prisma,
    accountId: "account-1",
    igUserId: "ig-user",
    now: new Date("2026-01-15T00:00:00Z"),
    historyMonths: 1,
    fetchMetric,
  });

  assert.equal(result.monthsAttempted, 1);
  assert.equal(result.requestCount, 7);
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.path === "/ig-user/insights"));
  assert.ok(calls.every((call) => call.params.since === "2026-01-01"));
  assert.ok(calls.every((call) => call.params.until === "2026-01-15"));
  assert.ok(calls.some((call) => call.params.metric === "follows_and_unfollows"));
  assert.ok(calls.every((call) => !["follows", "unfollows"].includes(call.params.metric)));

  const stored = Array.from(prisma.rows.values());
  assert.equal(stored.length, HISTORICAL_ACCOUNT_METRICS.length);
  assert.equal(stored.find((row) => row.metricName === "views").metricValue, 0);
  assert.equal(stored.find((row) => row.metricName === "profile_views").metricValue, null);
  assert.equal(stored.find((row) => row.metricName === "views_from_followers").metricValue, 4);
  assert.ok(stored.every((row) => row.period === "month"));
  assert.ok(stored.every((row) => row.rawJson.source === "historical_account_period"));
});

test("completed August requests every account metric independently for the exact full month", async () => {
  const prisma = createPrisma();
  const calls = [];
  await syncHistoricalAccountMetrics({
    prisma,
    accountId: "account-1",
    igUserId: "ig-user",
    now: new Date("2026-09-10T00:00:00Z"),
    historyMonths: 2,
    fetchMetric: async (_path, params) => {
      calls.push(params);
      if (params.breakdown) return { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: [params.metric === "follows_and_unfollows" ? "FOLLOWS" : "FOLLOWER"], value: 1 },
        { dimension_values: [params.metric === "follows_and_unfollows" ? "UNFOLLOWS" : "NON_FOLLOWER"], value: 2 },
      ] }] } }] };
      return { data: [{ total_value: { value: 5 } }] };
    },
  });
  const august = calls.filter((call) => call.since.startsWith("2026-08"));
  assert.ok(august.length > 0);
  assert.ok(august.every((call) => call.until === "2026-08-31"));
  assert.equal(august.filter((call) => call.metric === "views" && !call.breakdown).length, 1);
  assert.equal(august.filter((call) => call.metric === "total_interactions" && !call.breakdown).length, 1);
  const reachCalls = august.filter((call) => call.metric === "reach" && !call.breakdown);
  assert.deepEqual(reachCalls.map(({ since, until }) => ({ since, until })), [
    { since: "2026-08-01", until: "2026-08-31" },
  ]);
  assert.equal(august.some((call) => call.metric === "total_interactions"), true);
  const stored = Array.from(prisma.rows.values());
  assert.equal(stored.find((row) => row.metricName === "views" && row.insightDate.toISOString().startsWith("2026-08")).metricValue, 5);
  assert.equal(stored.find((row) => row.metricName === "total_interactions" && row.insightDate.toISOString().startsWith("2026-08")).metricValue, 5);
  assert.equal(stored.find((row) => row.metricName === "reach" && row.insightDate.toISOString().startsWith("2026-08")).metricValue, 5);
});

test("current-month Reach uses one request capped at the synchronization date", async () => {
  const calls = [];
  await syncHistoricalAccountMetrics({
    prisma: createPrisma(), accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-08-10T18:00:00Z"), historyMonths: 1,
    fetchMetric: async (_path, params) => {
      calls.push(params);
      if (params.breakdown) return { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: ["FOLLOWER"], value: 0 },
        { dimension_values: ["NON_FOLLOWER"], value: 0 },
      ] }] } }] };
      return { data: [{ total_value: { value: 0 } }] };
    },
  });
  assert.deepEqual(
    calls.filter((call) => call.metric === "reach" && !call.breakdown)
      .map(({ since, until }) => ({ since, until })),
    [{ since: "2026-08-01", until: "2026-08-10" }]
  );
});

test("follow and unfollow availability is independent and explicit zero remains zero", async () => {
  const prisma = createPrisma();
  await syncHistoricalAccountMetrics({
    prisma, accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-02-20T00:00:00Z"), historyMonths: 1,
    fetchMetric: async (_path, params) => params.metric === "follows_and_unfollows"
      ? { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: ["FOLLOWS"], value: 0 },
      ] }] } }] }
      : params.breakdown
        ? { data: [{ total_value: { breakdowns: [{ results: [
          { dimension_values: ["FOLLOWER"], value: 1 },
        ] }] } }] }
        : { data: [{ total_value: { value: 1 } }] },
  });
  const rows = Array.from(prisma.rows.values());
  assert.equal(rows.find((row) => row.metricName === "follows").metricValue, 0);
  const unfollows = rows.find((row) => row.metricName === "unfollows");
  assert.equal(unfollows.metricValue, null);
  assert.equal(unfollows.rawJson.status, "unavailable");
  assert.equal(unfollows.rawJson.reason, "empty_meta_dataset");
});

test("actual FOLLOWER and NON_FOLLOWER buckets map to follow and unfollow", async () => {
  const prisma = createPrisma();
  await syncHistoricalAccountMetrics({
    prisma, accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-08-10T00:00:00Z"), historyMonths: 1,
    fetchMetric: async (_path, params) => params.metric === "follows_and_unfollows"
      ? { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: ["FOLLOWER"], value: 22 },
        { dimension_values: ["NON_FOLLOWER"], value: 8 },
      ] }] } }] }
      : params.breakdown
        ? { data: [{ total_value: { breakdowns: [{ results: [
          { dimension_values: ["FOLLOWER"], value: 1 },
          { dimension_values: ["NON_FOLLOWER"], value: 1 },
        ] }] } }] }
        : { data: [{ total_value: { value: 1 } }] },
  });
  const rows = Array.from(prisma.rows.values());
  assert.equal(rows.find((row) => row.metricName === "follows").metricValue, 22);
  assert.equal(rows.find((row) => row.metricName === "unfollows").metricValue, 8);
});

test("a corrected retry updates the existing failed monthly row without duplication", async () => {
  const prisma = createPrisma([{
    accountId: "account-1", metricName: "views", metricValue: null,
    insightDate: new Date("2026-08-01T00:00:00Z"), period: "month",
    rawJson: { source: "historical_account_period", available: false,
      lastAttemptAvailable: false, error: { message: "request exceeded 30 days" } },
  }]);
  await syncHistoricalAccountMetrics({
    prisma, accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-08-10T00:00:00Z"), historyMonths: 1,
    fetchMetric: async (_path, params) => params.breakdown
      ? { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: [params.metric === "follows_and_unfollows" ? "FOLLOWS" : "FOLLOWER"], value: 1 },
        { dimension_values: [params.metric === "follows_and_unfollows" ? "UNFOLLOWS" : "NON_FOLLOWER"], value: 1 },
      ] }] } }] }
      : { data: [{ total_value: { value: params.metric === "views" ? 42 : 1 } }] },
  });
  const views = Array.from(prisma.rows.values()).filter((row) => row.metricName === "views");
  assert.equal(views.length, 1);
  assert.equal(views[0].metricValue, 42);
  assert.equal(views[0].rawJson.lastAttemptAvailable, true);
});

test("one failed independent metric does not erase successful account metrics", async () => {
  const prisma = createPrisma();
  await syncHistoricalAccountMetrics({
    prisma, accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-09-10T00:00:00Z"), historyMonths: 2,
    fetchMetric: async (_path, params) => {
      if (params.metric === "views" && params.since === "2026-08-01") throw new Error("temporary");
      if (params.breakdown) return { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: [params.metric === "follows_and_unfollows" ? "FOLLOWS" : "FOLLOWER"], value: 1 },
        { dimension_values: [params.metric === "follows_and_unfollows" ? "UNFOLLOWS" : "NON_FOLLOWER"], value: 1 },
      ] }] } }] };
      return { data: [{ total_value: { value: 5 } }] };
    },
  });
  const augustViews = Array.from(prisma.rows.values()).find((row) =>
    row.metricName === "views" && row.insightDate.toISOString().startsWith("2026-08")
  );
  assert.equal(augustViews.metricValue, null);
  assert.equal(augustViews.rawJson.lastAttemptAvailable, false);
  const augustReach = Array.from(prisma.rows.values()).find((row) =>
    row.metricName === "reach" && row.insightDate.toISOString().startsWith("2026-08")
  );
  const augustInteractions = Array.from(prisma.rows.values()).find((row) =>
    row.metricName === "total_interactions" && row.insightDate.toISOString().startsWith("2026-08")
  );
  assert.equal(augustReach.metricValue, 5);
  assert.equal(augustInteractions.metricValue, 5);
});

test("older completed months use one inclusive whole-period request per metric", async () => {
  const calls = [];
  await syncHistoricalAccountMetrics({
    prisma: createPrisma(), accountId: "account-1", igUserId: "ig-user",
    now: new Date("2026-01-15T00:00:00Z"), historyMonths: 13,
    fetchMetric: async (_path, params) => {
      calls.push(params);
      if (params.breakdown) return { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: ["FOLLOWER"], value: 0 },
        { dimension_values: ["NON_FOLLOWER"], value: 0 },
      ] }] } }] };
      return { data: [{ total_value: { value: 0 } }] };
    },
  });
  const january2025 = calls.filter((call) => call.since === "2025-01-01");
  assert.equal(january2025.length, 7);
  assert.ok(january2025.every((call) => call.until === "2025-01-31"));
});

test("completed old months are skipped while the two most recent months refresh", async () => {
  const ranges = buildHistoricalCalendarMonths(new Date("2026-08-10T00:00:00Z"), 3);
  const existingRows = ranges.flatMap((range) =>
    HISTORICAL_ACCOUNT_METRICS.map((metricName) => ({
      accountId: "account-1",
      metricName,
      metricValue: null,
      insightDate: range.start,
      period: "month",
      rawJson: { source: "historical_account_period", available: false },
    }))
  );
  const prisma = createPrisma(existingRows);
  const selected = await resolveHistoricalRangesToSync({
    prisma,
    accountId: "account-1",
    now: new Date("2026-08-10T00:00:00Z"),
    historyMonths: 3,
    recentMonths: 2,
  });
  assert.deepEqual(selected.map((range) => range.since), ["2026-07-01", "2026-08-01"]);
});

test("old transient failures are retried with a strict monthly cap", async () => {
  const ranges = buildHistoricalCalendarMonths(new Date("2026-08-10T00:00:00Z"), 5);
  const existingRows = ranges.flatMap((range) =>
    HISTORICAL_ACCOUNT_METRICS.map((metricName) => ({
      accountId: "account-1",
      metricName,
      metricValue: null,
      insightDate: range.start,
      period: "month",
      rawJson: {
        source: "historical_account_period",
        available: false,
        lastAttemptAvailable: false,
        error: { name: "Error", message: "temporary" },
      },
    }))
  );
  const selected = await resolveHistoricalRangesToSync({
    prisma: createPrisma(existingRows),
    accountId: "account-1",
    now: new Date("2026-08-10T00:00:00Z"),
    historyMonths: 5,
    recentMonths: 2,
    failedMonthRetryLimit: 2,
  });
  assert.deepEqual(selected.map((range) => range.since), [
    "2026-04-01", "2026-05-01", "2026-07-01", "2026-08-01",
  ]);
});

test("failed-month retries rotate by oldest last attempt so persistent Reach cannot starve others", async () => {
  const ranges = buildHistoricalCalendarMonths(new Date("2026-08-10T00:00:00Z"), 7);
  const failed = ranges.slice(0, 5).flatMap((range, monthIndex) =>
    HISTORICAL_ACCOUNT_METRICS.map((metricName) => ({
      accountId: "account-1", metricName, metricValue: null,
      insightDate: range.start, period: "month",
      updatedAt: new Date(Date.UTC(2026, 7, monthIndex + 1)),
      rawJson: { source: "historical_account_period", available: false,
        lastAttemptAvailable: false, lastAttemptAt: new Date(Date.UTC(2026, 7, monthIndex + 1)).toISOString(),
        error: { message: metricName === "reach" ? "persistent Reach failure" : "temporary" } },
    }))
  );
  const prisma = createPrisma(failed);
  let selected = await resolveHistoricalRangesToSync({
    prisma, accountId: "account-1", now: new Date("2026-08-10T00:00:00Z"),
    historyMonths: 7, recentMonths: 2, failedMonthRetryLimit: 2,
  });
  assert.deepEqual(selected.slice(0, 2).map((range) => range.since), ["2026-02-01", "2026-03-01"]);
  for (const row of prisma.rows.values()) {
    if (["2026-02", "2026-03"].includes(row.insightDate.toISOString().slice(0, 7))) {
      row.rawJson.lastAttemptAt = "2026-08-20T00:00:00.000Z";
      row.updatedAt = new Date("2026-08-20T00:00:00Z");
    }
  }
  selected = await resolveHistoricalRangesToSync({
    prisma, accountId: "account-1", now: new Date("2026-08-10T00:00:00Z"),
    historyMonths: 7, recentMonths: 2, failedMonthRetryLimit: 2,
  });
  assert.deepEqual(selected.slice(0, 2).map((range) => range.since), ["2026-04-01", "2026-05-01"]);
});

test("transient failure does not erase a previously stored historical value", async () => {
  const prisma = createPrisma([{
    accountId: "account-1",
    metricName: "views",
    metricValue: 123,
    insightDate: new Date("2026-01-01T00:00:00Z"),
    period: "month",
    rawJson: { source: "historical_account_period", available: true },
  }]);
  await syncHistoricalAccountMetrics({
    prisma,
    accountId: "account-1",
    igUserId: "ig-user",
    now: new Date("2026-01-15T00:00:00Z"),
    historyMonths: 1,
    fetchMetric: async () => { throw new Error("temporary Meta outage"); },
  });
  const views = Array.from(prisma.rows.values()).find((row) => row.metricName === "views");
  assert.equal(views.metricValue, 123);
  assert.equal(views.rawJson.available, true);
  assert.equal(views.rawJson.lastAttemptAvailable, false);
  assert.equal(views.rawJson.status, "available");
  assert.equal(views.rawJson.lastAttemptStatus, "api_error");
  assert.equal(views.rawJson.preservedStoredValue, true);
});

test("retention-limited old months are terminal and do not consume retry slots", async () => {
  const ranges = buildHistoricalCalendarMonths(new Date("2026-08-10T00:00:00Z"), 3);
  const existingRows = ranges.flatMap((range) => HISTORICAL_ACCOUNT_METRICS.map((metricName) => ({
    accountId: "account-1", metricName, metricValue: null,
    insightDate: range.start, period: "month",
    rawJson: { source: "historical_account_period", status: "unavailable",
      reason: "historical_retention", lastAttemptStatus: "unavailable" },
  })));
  const selected = await resolveHistoricalRangesToSync({
    prisma: createPrisma(existingRows), accountId: "account-1",
    now: new Date("2026-08-10T00:00:00Z"), historyMonths: 3,
    recentMonths: 1, failedMonthRetryLimit: 2,
  });
  assert.deepEqual(selected.map((range) => range.since), ["2026-08-01"]);
});
