import assert from "node:assert/strict";
import test from "node:test";

import { computeContentPerformance } from "../instagramContentPerformance.service.js";

const insight = (metricName, metricValue, insightDate, updatedAt = insightDate) => ({
  metricName,
  metricValue,
  insightDate,
  updatedAt,
});

test("picks the most recent insight per metric and derives engagement/share/save rate from reach", () => {
  const [result] = computeContentPerformance([
    {
      id: "media-1",
      igMediaId: "ig-1",
      caption: "Match highlight",
      contentLabel: "content_promotion",
      mediaType: "VIDEO",
      mediaProductType: "REELS",
      postedAt: "2026-04-01T00:00:00Z",
      rawJson: {},
      insights: [
        insight("views", 100, "2026-04-02T00:00:00Z"),
        insight("views", 250, "2026-04-05T00:00:00Z"),
        insight("reach", 200, "2026-04-05T00:00:00Z"),
        insight("likes", 20, "2026-04-05T00:00:00Z"),
        insight("comments", 5, "2026-04-05T00:00:00Z"),
        insight("shares", 10, "2026-04-05T00:00:00Z"),
        insight("saved", 4, "2026-04-05T00:00:00Z"),
      ],
    },
  ]);

  assert.equal(result.views, 250);
  assert.equal(result.reach, 200);
  assert.equal(result.likes, 20);
  assert.equal(result.comments, 5);
  assert.equal(result.shares, 10);
  assert.equal(result.saved, 4);
  assert.equal(result.interactions, 39);
  assert.equal(result.engagementRate, 19.5);
  assert.equal(result.shareRate, 5);
  assert.equal(result.saveRate, 2);
});

test("breaks ties on the same insightDate using the latest updatedAt", () => {
  const [result] = computeContentPerformance([
    {
      id: "media-2",
      igMediaId: "ig-2",
      insights: [
        insight("views", 10, "2026-04-05T00:00:00Z", "2026-04-05T08:00:00Z"),
        insight("views", 40, "2026-04-05T00:00:00Z", "2026-04-05T09:00:00Z"),
      ],
    },
  ]);

  assert.equal(result.views, 40);
});

test("falls back to rawJson like/comment counts when no insight row exists", () => {
  const [result] = computeContentPerformance([
    {
      id: "media-3",
      igMediaId: "ig-3",
      insights: [],
      rawJson: { like_count: 12, comments_count: 3 },
    },
  ]);

  assert.equal(result.likes, 12);
  assert.equal(result.comments, 3);
  assert.equal(result.interactions, 15);
});

test("uses total_interactions directly when supplied instead of summing components", () => {
  const [result] = computeContentPerformance([
    {
      id: "media-4",
      igMediaId: "ig-4",
      insights: [
        insight("total_interactions", 999, "2026-04-05T00:00:00Z"),
        insight("likes", 5, "2026-04-05T00:00:00Z"),
      ],
    },
  ]);

  assert.equal(result.interactions, 999);
});

test("engagement/share/save rate stay null without reach, and defaults contentLabel", () => {
  const [result] = computeContentPerformance([
    { id: "media-5", igMediaId: "ig-5", contentLabel: null, insights: [] },
  ]);

  assert.equal(result.engagementRate, null);
  assert.equal(result.shareRate, null);
  assert.equal(result.saveRate, null);
  assert.equal(result.contentLabel, "content_advertisement");
});

test("results are sorted by views descending, with missing views ranked lowest", () => {
  const results = computeContentPerformance([
    { id: "low", igMediaId: "ig-low", insights: [insight("views", 5, "2026-04-05T00:00:00Z")] },
    { id: "high", igMediaId: "ig-high", insights: [insight("views", 500, "2026-04-05T00:00:00Z")] },
    { id: "unknown", igMediaId: "ig-unknown", insights: [] },
  ]);

  assert.deepEqual(
    results.map((item) => item.id),
    ["high", "low", "unknown"]
  );
});
