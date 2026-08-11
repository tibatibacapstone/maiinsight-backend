import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canonical monthly history is not followed by legacy two-year account collectors", async () => {
  const source = await readFile(
    new URL("../meta.service.js", import.meta.url),
    "utf8"
  );
  const orchestration = source.slice(
    source.indexOf("export async function syncMetaRawToAnalytics"),
    source.indexOf("export async function syncMetaRawToAnalytics") + 9000
  );
  assert.match(orchestration, /syncHistoricalAccountMetrics\(\{/);
  assert.doesNotMatch(orchestration, /await syncAccountInsightsInChunks\(/);
  assert.doesNotMatch(orchestration, /await syncFollowUnfollowInsights\(/);
  assert.doesNotMatch(orchestration, /await syncViewsBreakdownInsights\(/);
});
