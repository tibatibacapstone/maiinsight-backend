import assert from "node:assert/strict"
import test from "node:test"

import {
  META_HISTORY_MONTHS,
  META_INCREMENTAL_OVERLAP_DAYS,
  resolveMetaSyncWindow,
  selectMediaForInsightSync,
  selectStoredMediaForInsightRefresh,
} from "../meta.service.js"

test("first sync uses a bounded rolling 24-month media window", () => {
  const window = resolveMetaSyncWindow({
    now: new Date("2026-08-09T12:00:00.000Z"),
    historicalBaselineCompleted: false,
  })

  assert.equal(META_HISTORY_MONTHS, 24)
  assert.deepEqual(window, {
    mode: "initial",
    since: "2024-08-09",
    until: "2026-08-09",
  })
})

test("later sync starts from latest media with a seven-day overlap", () => {
  const window = resolveMetaSyncWindow({
    now: new Date("2026-08-09T12:00:00.000Z"),
    historicalBaselineCompleted: true,
    latestMediaPostedAt: new Date("2026-08-05T08:00:00.000Z"),
  })

  assert.equal(META_INCREMENTAL_OVERLAP_DAYS, 7)
  assert.deepEqual(window, {
    mode: "incremental",
    since: "2026-07-29",
    until: "2026-08-09",
  })
})

test("incremental overlap never escapes the supported history boundary", () => {
  const window = resolveMetaSyncWindow({
    now: new Date("2026-08-09T12:00:00.000Z"),
    historicalBaselineCompleted: true,
    latestMediaPostedAt: new Date("2020-01-01T00:00:00.000Z"),
  })

  assert.equal(window.since, "2024-08-09")
  assert.equal(window.until, "2026-08-09")
})

test("per-media insight selection is bounded separately for initial and incremental syncs", () => {
  const media = Array.from({ length: 400 }, (_, index) => ({ id: index + 1 }))

  assert.equal(selectMediaForInsightSync(media, "initial").length, 250)
  assert.equal(selectMediaForInsightSync(media, "incremental").length, 60)
})

test("stored-media refresh is independent of the seven-day discovery overlap", () => {
  const media = [
    {
      id: "old",
      postedAt: new Date("2026-06-01T00:00:00Z"),
      insights: [{ updatedAt: new Date("2026-07-01T00:00:00Z") }],
    },
    {
      id: "recent",
      postedAt: new Date("2026-08-08T00:00:00Z"),
      insights: [{ updatedAt: new Date("2026-08-09T00:00:00Z") }],
    },
  ]

  const selected = selectStoredMediaForInsightRefresh(media, "incremental", {
    incrementalLimit: 1,
  })

  assert.equal(selected[0].id, "old")
})

test("refresh ordering rotates unsynchronized and oldest-successful media fairly", () => {
  const media = [
    {
      id: "newer-old-refresh",
      postedAt: new Date("2026-08-01T00:00:00Z"),
      insights: [{ updatedAt: new Date("2026-07-01T00:00:00Z") }],
    },
    {
      id: "older-old-refresh",
      postedAt: new Date("2026-06-01T00:00:00Z"),
      insights: [{ updatedAt: new Date("2026-07-01T00:00:00Z") }],
    },
    {
      id: "newly-discovered",
      postedAt: new Date("2026-08-09T00:00:00Z"),
      insights: [],
    },
    {
      id: "recently-refreshed",
      postedAt: new Date("2026-05-01T00:00:00Z"),
      insights: [{ updatedAt: new Date("2026-08-09T00:00:00Z") }],
    },
  ]

  assert.deepEqual(
    selectStoredMediaForInsightRefresh(media, "incremental", {
      incrementalLimit: 3,
    }).map(({ id }) => id),
    ["newly-discovered", "newer-old-refresh", "older-old-refresh"]
  )
})

test("stored-media refresh batch remains bounded", () => {
  const media = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    postedAt: new Date("2026-01-01T00:00:00Z"),
    insights: [],
  }))

  assert.equal(selectStoredMediaForInsightRefresh(media, "incremental").length, 60)
  assert.equal(selectStoredMediaForInsightRefresh(media, "initial").length, 100)
})

test("rotation prevents failed or unsupported media from starving the queue", () => {
  const media = Array.from({ length: 6 }, (_, index) => ({
    id: `media-${index}`,
    postedAt: new Date(`2026-08-0${6 - index}T00:00:00Z`),
    insights: [],
  }))

  const first = selectStoredMediaForInsightRefresh(media, "incremental", {
    incrementalLimit: 2,
    rotation: 0,
  })
  const second = selectStoredMediaForInsightRefresh(media, "incremental", {
    incrementalLimit: 2,
    rotation: 1,
  })

  assert.deepEqual(first.map(({ id }) => id), ["media-0", "media-1"])
  assert.deepEqual(second.map(({ id }) => id), ["media-2", "media-3"])
})
