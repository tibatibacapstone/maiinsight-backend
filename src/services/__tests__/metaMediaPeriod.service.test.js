import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchMediaForPeriod,
  mediaMatchesContentType,
} from "../metaMedia.service.js";

function item(id, timestamp, mediaType = "IMAGE", productType = "FEED") {
  return {
    id,
    timestamp,
    media_type: mediaType,
    media_product_type: productType,
  };
}

function pagedFetcher(pages, calls) {
  return async (after) => {
    calls.push(after);
    return pages[calls.length - 1];
  };
}

test("January selection retains January media and excludes newer and older media", async () => {
  const calls = [];
  const result = await fetchMediaForPeriod({
    since: "2026-01-01",
    until: "2026-01-31",
    fetchPage: pagedFetcher(
      [
        {
          data: [item("feb", "2026-02-02T00:00:00Z"), item("jan", "2026-01-15T00:00:00Z")],
          paging: { next: "next", cursors: { after: "one" } },
        },
        {
          data: [item("old", "2025-12-31T23:59:59Z")],
          paging: { next: "next", cursors: { after: "two" } },
        },
      ],
      calls
    ),
  });

  assert.deepEqual(result.mediaItems.map(({ id }) => id), ["jan"]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(calls.length, 2, "pagination stops once a page is older than the period");
});

test("explicit zero-valued media remains selected because selection is timestamp-based", async () => {
  const zeroViewsMedia = {
    ...item("zero", "2026-01-10T00:00:00Z"),
    views: 0,
  };
  const result = await fetchMediaForPeriod({
    since: "2026-01-01",
    until: "2026-01-31",
    fetchPage: async () => ({ data: [zeroViewsMedia] }),
  });
  assert.equal(result.mediaItems[0].views, 0);
});

test("content-type filtering is preserved", async () => {
  const page = {
    data: [
      item("feed", "2026-01-10T00:00:00Z"),
      item("reel", "2026-01-11T00:00:00Z", "VIDEO", "REELS"),
    ],
  };
  const reels = await fetchMediaForPeriod({
    since: "2026-01-01",
    until: "2026-01-31",
    contentType: "reels",
    fetchPage: async () => page,
  });
  assert.deepEqual(reels.mediaItems.map(({ id }) => id), ["reel"]);
  assert.equal(mediaMatchesContentType(page.data[0], "feed"), true);
});

test("page safety limit bounds pagination", async () => {
  let calls = 0;
  const result = await fetchMediaForPeriod({
    since: "2020-01-01",
    until: "2026-01-31",
    maxPages: 2,
    fetchPage: async () => {
      calls += 1;
      return {
        data: [item(String(calls), "2026-01-10T00:00:00Z")],
        paging: { next: "next", cursors: { after: String(calls) } },
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.truncated, true);
});

test("historical discovery crosses newer pages and stops after the 24-month boundary", async () => {
  const calls = [];
  const result = await fetchMediaForPeriod({
    since: "2024-08-09",
    until: "2026-08-09",
    fetchPage: pagedFetcher(
      [
        {
          data: [item("recent", "2026-08-01T00:00:00Z")],
          paging: { next: "next", cursors: { after: "one" } },
        },
        {
          data: [item("historical", "2024-08-10T00:00:00Z")],
          paging: { next: "next", cursors: { after: "two" } },
        },
        {
          data: [item("too-old", "2024-08-08T23:59:59Z")],
          paging: { next: "next", cursors: { after: "three" } },
        },
      ],
      calls
    ),
  });

  assert.deepEqual(result.mediaItems.map(({ id }) => id), ["recent", "historical"]);
  assert.equal(calls.length, 3);
});
