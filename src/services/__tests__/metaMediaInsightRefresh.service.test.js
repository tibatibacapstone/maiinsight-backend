import assert from "node:assert/strict";
import test from "node:test";

import {
  composeStoredMediaRefreshBatch,
  mediaInsightGroupsFor,
  saveMediaInsights,
  saveMediaItems,
} from "../metaMedia.service.js";

const METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
];

const keyFor = ({ mediaId, metricName, insightDate, period }) =>
  `${mediaId}:${metricName}:${new Date(insightDate).toISOString()}:${period}`;

function createDatabase(seed = []) {
  const rows = new Map(seed.map((row) => [keyFor(row), { ...row }]));
  return {
    rows,
    instagramMediaInsight: {
      upsert: async ({ where, update, create }) => {
        const key = keyFor(where.mediaId_metricName_insightDate_period);
        const existing = rows.get(key);
        rows.set(key, existing ? { ...existing, ...update } : { ...create });
        return rows.get(key);
      },
    },
  };
}

function combinedResponse(overrides = {}) {
  return {
    data: METRICS.map((name) => ({
      name,
      period: "lifetime",
      values: [{ value: overrides[name] ?? 1 }],
    })),
  };
}

const media = {
  id: "database-media-id",
  igMediaId: "meta-media-id",
  mediaProductType: "FEED",
};
const reel = {
  id: "database-reel-id",
  igMediaId: "meta-reel-id",
  mediaType: "VIDEO",
  mediaProductType: "REELS",
};
const august10 = new Date("2026-08-10T18:00:00.000Z");

test("media product type selects a strict source metric for canonical Views", () => {
  const reelViews = mediaInsightGroupsFor(reel).find(
    (group) => group.normalizedName === "views"
  );
  const feedViews = mediaInsightGroupsFor(media).find(
    (group) => group.normalizedName === "views"
  );

  assert.deepEqual(reelViews.candidates, ["total_views"]);
  assert.deepEqual(feedViews.candidates, ["views", "impressions", "plays", "video_views"]);
})

test("Reels normalize likes and comments to the total_* source metrics shown in the app", () => {
  const reelGroups = mediaInsightGroupsFor(reel);
  const reelLikes = reelGroups.find((group) => group.normalizedName === "likes");
  const reelComments = reelGroups.find((group) => group.normalizedName === "comments");
  const feedLikes = mediaInsightGroupsFor(media).find(
    (group) => group.normalizedName === "likes"
  );
  const feedComments = mediaInsightGroupsFor(media).find(
    (group) => group.normalizedName === "comments"
  );

  assert.deepEqual(reelLikes.candidates, ["total_likes"]);
  assert.deepEqual(reelComments.candidates, ["total_comments"]);
  assert.deepEqual(feedLikes.candidates, ["likes"]);
  assert.deepEqual(feedComments.candidates, ["comments"]);
})

test("Reels normalize Meta total_views rather than generic views", async () => {
  const database = createDatabase();
  const calls = [];

  await saveMediaInsights(reel, {
    database,
    now: august10,
    fetchMetric: async (_path, params) => {
      calls.push(params.metric);
      return params.metric.includes(",") ? {
        data: [
          { name: "total_views", period: "lifetime", values: [{ value: 1310 }] },
          { name: "views", period: "lifetime", values: [{ value: 344 }] },
          { name: "reach", period: "lifetime", values: [{ value: 293 }] },
        ],
      } : { data: [] };
    },
  });

  const storedViews = [...database.rows.values()].find(
    (row) => row.metricName === "views"
  );
  assert.match(calls[0], /total_views/);
  assert.doesNotMatch(calls[0], /(^|,)views(,|$)/);
  assert.equal(storedViews.metricValue, 1310);
  assert.equal(storedViews.rawJson.sourceMetricName, "total_views");
})

test("Feed retains Meta views as canonical Views", async () => {
  const database = createDatabase();

  await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async () => combinedResponse({ views: 250 }),
  });

  const storedViews = [...database.rows.values()].find(
    (row) => row.metricName === "views"
  );
  assert.equal(storedViews.metricValue, 250);
  assert.equal(storedViews.rawJson.sourceMetricName, "views");
})

test("new and existing media retain one stable Meta-media identity", async () => {
  const rows = new Map();
  const database = {
    instagramMedia: {
      findMany: async ({ where }) =>
        [...rows.values()]
          .filter((row) => where.igMediaId.in.includes(row.igMediaId))
          .map(({ igMediaId }) => ({ igMediaId })),
      upsert: async ({ where, update, create }) => {
        const existing = rows.get(where.igMediaId);
        const next = existing
          ? { ...existing, ...update }
          : { id: `db-${where.igMediaId}`, ...create };
        rows.set(where.igMediaId, next);
        return next;
      },
    },
  };
  const item = {
    id: "stable-meta-id",
    caption: "First caption",
    media_type: "VIDEO",
    media_product_type: "REELS",
    timestamp: "2026-08-10T08:00:00Z",
  };

  await saveMediaItems("account", [item], { database });
  await saveMediaItems("account", [{ ...item, caption: "Updated caption" }], {
    database,
  });

  assert.equal(rows.size, 1);
  assert.equal(rows.get(item.id).caption, "Updated caption");
})

test("same-day refresh updates the canonical row without duplication", async () => {
  const database = createDatabase([
    {
      mediaId: media.id,
      metricName: "views",
      metricValue: 401,
      insightDate: new Date("2026-08-10T00:00:00.000Z"),
      period: "lifetime",
    },
  ]);
  const calls = [];

  await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async (_path, params) => {
      calls.push(params.metric);
      return combinedResponse({ views: 409 });
    },
  });

  const viewRows = [...database.rows.values()].filter(
    (row) => row.metricName === "views"
  );
  assert.equal(calls.length, 1, "compatible metrics use one media insight request");
  assert.equal(viewRows.length, 1);
  assert.equal(viewRows[0].metricValue, 409);
})

test("same-day Reel refresh replaces old generic views with total_views", async () => {
  const existing = {
    mediaId: reel.id,
    metricName: "views",
    metricValue: 344,
    insightDate: new Date("2026-08-10T00:00:00.000Z"),
    period: "lifetime",
  };
  const database = createDatabase([existing]);

  await saveMediaInsights(reel, {
    database,
    now: august10,
    fetchMetric: async (_path, params) =>
      params.metric.includes(",")
        ? {
            data: [
              { name: "total_views", period: "lifetime", values: [{ value: 1310 }] },
            ],
          }
        : { data: [] },
  });

  assert.equal(database.rows.get(keyFor(existing)).metricValue, 1310);
  assert.equal(database.rows.get(keyFor(existing)).rawJson.sourceMetricName, "total_views");
  assert.equal(
    [...database.rows.values()].filter((row) => row.metricName === "views").length,
    1
  );
})

test("Reel total_views explicit zero remains a valid canonical zero", async () => {
  const database = createDatabase();

  await saveMediaInsights(reel, {
    database,
    now: august10,
    fetchMetric: async (_path, params) =>
      params.metric.includes(",")
        ? {
            data: [
              { name: "total_views", period: "lifetime", values: [{ value: 0 }] },
            ],
          }
        : { data: [] },
  });

  const storedViews = [...database.rows.values()].find(
    (row) => row.metricName === "views"
  );
  assert.equal(storedViews.metricValue, 0);
})

test("Reels never substitute facebook, crossposted, reach, or generic views", async () => {
  const existing = {
    mediaId: reel.id,
    metricName: "views",
    metricValue: 344,
    insightDate: new Date("2026-08-10T00:00:00.000Z"),
    period: "lifetime",
  };
  const database = createDatabase([existing]);

  await saveMediaInsights(reel, {
    database,
    now: august10,
    fetchMetric: async (_path, params) =>
      params.metric.includes(",")
        ? {
            data: [
              { name: "views", period: "lifetime", values: [{ value: 500 }] },
              { name: "facebook_views", period: "lifetime", values: [{ value: 260 }] },
              { name: "crossposted_views", period: "lifetime", values: [{ value: 621 }] },
              { name: "reach", period: "lifetime", values: [{ value: 293 }] },
            ],
          }
        : { data: [] },
  });

  assert.equal(database.rows.get(keyFor(existing)).metricValue, 344);
})

test("a new day creates one new snapshot and preserves prior daily history", async () => {
  const database = createDatabase([
    {
      mediaId: media.id,
      metricName: "views",
      metricValue: 380,
      insightDate: new Date("2026-08-09T00:00:00.000Z"),
      period: "lifetime",
    },
  ]);

  await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async () => combinedResponse({ views: 409 }),
  });

  const viewRows = [...database.rows.values()]
    .filter((row) => row.metricName === "views")
    .sort((left, right) => new Date(left.insightDate) - new Date(right.insightDate));
  assert.deepEqual(viewRows.map(({ metricValue }) => metricValue), [380, 409]);
})

test("transient Meta failures preserve the last valid media value", async () => {
  const existing = {
    mediaId: media.id,
    metricName: "views",
    metricValue: 409,
    insightDate: new Date("2026-08-10T00:00:00.000Z"),
    period: "lifetime",
  };
  const database = createDatabase([existing]);

  const saved = await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async () => {
      throw new Error("temporary Meta failure");
    },
  });

  assert.equal(saved, 0);
  assert.equal(database.rows.get(keyFor(existing)).metricValue, 409);
  assert.equal(database.rows.size, 1);
})

test("an explicit Meta zero replaces a previous nonzero same-day value", async () => {
  const existing = {
    mediaId: media.id,
    metricName: "shares",
    metricValue: 5,
    insightDate: new Date("2026-08-10T00:00:00.000Z"),
    period: "lifetime",
  };
  const database = createDatabase([existing]);

  await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async () => combinedResponse({ shares: 0 }),
  });

  assert.equal(database.rows.get(keyFor(existing)).metricValue, 0);
})

test("missing metric values do not overwrite a valid same-day value", async () => {
  const existing = {
    mediaId: media.id,
    metricName: "views",
    metricValue: 409,
    insightDate: new Date("2026-08-10T00:00:00.000Z"),
    period: "lifetime",
  };
  const database = createDatabase([existing]);

  await saveMediaInsights(media, {
    database,
    now: august10,
    fetchMetric: async (_path, params) =>
      params.metric.includes(",")
        ? { data: [{ name: "views", period: "lifetime", values: [] }] }
        : { data: [] },
  });

  assert.equal(database.rows.get(keyFor(existing)).metricValue, 409);
})

test("incremental refresh picks stale media before freshly refreshed ones", () => {
  const staleMedia = {
    id: "stale-media",
    igMediaId: "stale-ig-id",
    postedAt: new Date("2026-08-05T00:00:00.000Z"),
    insights: [{ insightDate: new Date("2026-08-13T00:00:00.000Z") }],
  };
  const freshMedia = {
    id: "fresh-media",
    igMediaId: "fresh-ig-id",
    postedAt: new Date("2026-08-14T00:00:00.000Z"),
    insights: [{ insightDate: new Date("2026-08-16T00:00:00.000Z") }],
  };

  const batch = composeStoredMediaRefreshBatch({
    eligibleMedia: [freshMedia, staleMedia],
    mode: "incremental",
    discoveredMediaIds: [],
    newMediaIds: [],
    syncAttemptCount: 7,
  });

  assert.deepEqual(batch.map(({ id }) => id), [staleMedia.id, freshMedia.id]);
})
