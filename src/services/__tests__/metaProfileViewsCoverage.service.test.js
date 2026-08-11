import assert from "node:assert/strict";
import test from "node:test";

import { collectCompleteProfileViews } from "../metaHistorical.service.js";
import { buildHistoricalInsightChunks } from "../metaHistorical.service.js";

test("complete Profile Views coverage aggregates every required inclusive chunk", async () => {
  const chunks = buildHistoricalInsightChunks(
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-31T00:00:00Z")
  );
  const calls = [];
  const result = await collectCompleteProfileViews(chunks, async (since, until) => {
    calls.push({ since, until });
    return { available: true, profileViews: 5 };
  });
  assert.equal(result.available, true);
  assert.equal(result.value, 10);
  assert.deepEqual(calls, [
    { since: "2026-01-01", until: "2026-01-28" },
    { since: "2026-01-29", until: "2026-01-31" },
  ]);
});

test("partial Profile Views coverage is unavailable and cannot supply an overwrite value", async () => {
  const chunks = buildHistoricalInsightChunks(
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-31T00:00:00Z")
  );
  let call = 0;
  const result = await collectCompleteProfileViews(chunks, async () => ({
    available: call++ === 0,
    profileViews: 5,
  }));
  assert.equal(result.available, false);
  assert.equal(result.value, null);
});

test("current-month Profile Views chunks stop at the synchronization date", () => {
  const chunks = buildHistoricalInsightChunks(
    new Date("2026-08-01T00:00:00Z"),
    new Date("2026-08-10T00:00:00Z")
  );
  assert.deepEqual(chunks.map(({ since, until }) => ({ since, until })), [
    { since: "2026-08-01", until: "2026-08-10" },
  ]);
});
