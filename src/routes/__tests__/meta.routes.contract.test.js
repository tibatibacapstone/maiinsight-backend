import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../meta.routes.js", import.meta.url), "utf8");
const syncRoute = source.match(/metaRouter\.post\(\s*"\/sync"[\s\S]*/)?.[0] || "";
const dashboardRoute = source.match(/metaRouter\.get\(\s*\["\/dashboard", "\/overview"\][\s\S]*?metaRouter\.get\(/)?.[0] || "";

test("Meta sync RBAC remains restricted to operational and IT support", () => {
  assert.match(syncRoute, /authorize\("operational", "it_support"\)/);
});

test("Meta sync failure remains a retryable response and does not expose credentials", () => {
  assert.match(syncRoute, /errorCode: "META_SYNC_FAILED"/);
  assert.match(syncRoute, /suggestion: "Please check the Meta connection and try again\."/);
  assert.doesNotMatch(syncRoute, /metaAccessToken|META_ACCESS_TOKEN/);
});

test("explicit Meta sync owns its synchronization window instead of accepting UI filters", () => {
  assert.match(
    syncRoute,
    /syncMetaRawToAnalytics\(\{\s*performedByUserId:\s*req\.user\.userId\s*\}\)/
  );
  assert.doesNotMatch(syncRoute, /req\.body\?\.since|req\.body\?\.until/);
});

test("dashboard period filtering reads persisted data and never starts Meta sync", () => {
  assert.match(dashboardRoute, /postedAt:/);
  assert.doesNotMatch(dashboardRoute, /syncMetaRawToAnalytics|metaGet\(/);
});

test("dashboard selects the latest follower snapshot in the exact selected period with latest fallback", () => {
  assert.match(dashboardRoute, /snapshotDate: \{ gte: startDate, lte: endDate \}/);
  assert.match(dashboardRoute, /orderBy: \{ snapshotDate: "desc" \}/);
  assert.match(dashboardRoute, /resolveFollowerSnapshot/);
});

test("historical KPI response is sourced only from monthly account insights", () => {
  assert.match(dashboardRoute, /period: "month"/);
  assert.match(dashboardRoute, /aggregateHistoricalAccountMetrics\(historicalAccountRows\)/);
  assert.match(dashboardRoute, /totalViews: historicalMetrics\.totalViews/);
  assert.match(dashboardRoute, /totalReach: historicalMetrics\.totalReach/);
  assert.match(dashboardRoute, /totalInteractions: historicalMetrics\.totalInteractions/);
  assert.doesNotMatch(dashboardRoute, /totalViews:.*filteredContentTotals\.views/);
  assert.doesNotMatch(dashboardRoute, /totalReach:.*filteredContentTotals\.reach/);
});

test("historical trend never falls back to content performance", () => {
  assert.match(dashboardRoute, /monthlyViewsTrend: historicalMonthlyTrend/);
  assert.doesNotMatch(dashboardRoute, /monthlyViewsTrend: isContentLabelFiltered/);
});

test("media performance remains posting-period plus latest snapshot", () => {
  assert.match(dashboardRoute, /postedAt: \{[\s\S]*gte: startDate,[\s\S]*lte: endDate/);
  assert.match(
    dashboardRoute,
    /const contentPerformance = computeContentPerformance\(media\)/,
    "dashboard must reuse the shared per-post metric extraction instead of a local copy"
  );
  assert.match(dashboardRoute, /const topContent = \[\.\.\.contentPerformance\]/);
  assert.match(dashboardRoute, /contentPerformance\.forEach/);
  assert.doesNotMatch(
    dashboardRoute,
    /total_views|facebook_views|crossposted_views/,
    "dashboard consumers must remain on the canonical media views contract"
  );
});

test("shared content-performance helper is imported from its own service", () => {
  assert.match(
    source,
    /import \{ computeContentPerformance \} from "\.\.\/services\/instagramContentPerformance\.service\.js";/
  );
});
