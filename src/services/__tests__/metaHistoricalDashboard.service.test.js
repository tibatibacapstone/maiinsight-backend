import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateHistoricalAccountMetrics,
  buildHistoricalAccountTrend,
  buildHistoricalCoverage,
} from "../metaHistorical.service.js";

const row = (metricName, metricValue, month = "2026-01-01") => ({
  metricName,
  metricValue,
  insightDate: new Date(`${month}T00:00:00Z`),
  period: "month",
  rawJson: { source: "historical_account_period", available: metricValue != null },
});

test("missing historical metrics remain unavailable and never use media values", () => {
  const metrics = aggregateHistoricalAccountMetrics([
    row("reach", 200),
    row("total_interactions", 20),
  ]);
  assert.equal(metrics.totalViews, null);
  assert.equal(metrics.totalReach, 200);
  assert.equal(metrics.engagementRate, 10);
});

test("explicit zero remains available zero", () => {
  const metrics = aggregateHistoricalAccountMetrics([
    row("views", 0), row("reach", 0), row("total_interactions", 0),
  ]);
  assert.equal(metrics.totalViews, 0);
  assert.equal(metrics.totalReach, 0);
  assert.equal(metrics.engagementRate, 0);
});

test("derived rates are unavailable when a required historical input is unavailable", () => {
  const metrics = aggregateHistoricalAccountMetrics([row("profile_views", 10)]);
  assert.equal(metrics.engagementRate, null);
  assert.equal(metrics.profileVisitRate, null);
});

test("all-month values sum only available historical month records", () => {
  const metrics = aggregateHistoricalAccountMetrics([
    row("views", 100, "2026-01-01"),
    row("views", 200, "2026-02-01"),
    row("views", 300, "2026-03-01"),
    row("views", null, "2026-04-01"),
  ]);
  assert.equal(metrics.totalViews, 600);
});

test("partial year coverage uses selected calendar months rather than only attempted rows", () => {
  const coverage = buildHistoricalCoverage([
    row("views", 100, "2026-01-01"),
    row("views", null, "2026-02-01"),
  ], 12).views;
  assert.deepEqual({
    availableMonths: coverage.availableMonths,
    attemptedMonths: coverage.attemptedMonths,
    totalMonths: coverage.totalMonths,
    complete: coverage.complete,
    availability: coverage.availability,
  }, {
    availableMonths: 1, attemptedMonths: 2, totalMonths: 12,
    complete: false, availability: "partial",
  });
});

test("partial all-month Reach sums available monthly period values and recomputes engagement", () => {
  const metrics = aggregateHistoricalAccountMetrics([
    row("reach", 100, "2026-01-01"),
    row("reach", 200, "2026-02-01"),
    row("total_interactions", 30, "2026-01-01"),
    row("total_interactions", 40, "2026-02-01"),
  ]);
  assert.equal(metrics.totalReach, 300);
  assert.equal(metrics.totalInteractions, 70);
  assert.equal(metrics.engagementRate, 23.33);
});

test("rates use only months where their numerator and Reach are both available", () => {
  const metrics = aggregateHistoricalAccountMetrics([
    row("reach", 100, "2026-01-01"),
    row("total_interactions", 10, "2026-01-01"),
    row("profile_views", 5, "2026-01-01"),
    row("total_interactions", 900, "2026-02-01"),
    row("profile_views", 800, "2026-03-01"),
    row("reach", 300, "2026-04-01"),
  ]);
  assert.equal(metrics.totalReach, 400);
  assert.equal(metrics.totalInteractions, 910);
  assert.equal(metrics.totalProfileViews, 805);
  assert.equal(metrics.engagementRate, 10);
  assert.equal(metrics.profileVisitRate, 5);
});

test("metric and derived-rate coverage are independent", () => {
  const coverage = buildHistoricalCoverage([
    row("views", 10, "2026-01-01"),
    row("views", 20, "2026-02-01"),
    row("reach", 100, "2026-01-01"),
    row("total_interactions", 10, "2026-01-01"),
    row("total_interactions", 20, "2026-02-01"),
    row("profile_views", 5, "2026-02-01"),
  ], 12);

  assert.equal(coverage.views.availableMonths, 2);
  assert.equal(coverage.reach.availableMonths, 1);
  assert.equal(coverage.total_interactions.availableMonths, 2);
  assert.equal(coverage.engagement_rate.availableMonths, 1);
  assert.equal(coverage.profile_visit_rate.availableMonths, 0);
});

test("a complete year aggregates all months without partial coverage", () => {
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const date = `2026-${String(month).padStart(2, "0")}-01`;
    rows.push(row("reach", 100, date), row("views", 200, date));
  }
  const metrics = aggregateHistoricalAccountMetrics(rows);
  const coverage = buildHistoricalCoverage(rows, 12);

  assert.equal(metrics.totalReach, 1200);
  assert.equal(metrics.totalViews, 2400);
  assert.equal(coverage.reach.complete, true);
  assert.equal(coverage.reach.availability, "available");
});

test("trend retains null historical metrics instead of substituting media snapshots", () => {
  const trend = buildHistoricalAccountTrend([
    row("views", null),
    row("reach", 50),
    row("views", 20, "2026-02-01"),
  ]);
  assert.deepEqual(trend, [
    { month: "2026-01", views: null, reach: 50, interactions: null, profileViews: null },
    { month: "2026-02", views: 20, reach: null, interactions: null, profileViews: null },
  ]);
});
