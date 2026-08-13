import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../operations.routes.js", import.meta.url),
  "utf8"
);

const sharedSegmentSource = fs.readFileSync(
  new URL("../../services/rfmSegmentation.service.js", import.meta.url),
  "utf8"
);

const CANONICAL_SEGMENT_NAMES = [
  "Prime Players",
  "Routine Players",
  "Growth Players",
  "Re-Engagement Players",
];

test("Management report imports the shared segmentation summary service", () => {
  assert.match(
    source,
    /getSegmentationSummary[\s\S]*from[\s\S]*rfmSegmentation\.service\.js/
  );
});

test("Management report builds segment rows from the shared segmentation snapshot", () => {
  assert.match(
    source,
    /const\s+clusterBySegmentName\s*=\s*new\s+Map\(\s*\(segmentationSnapshot\.clusters/
  );
  assert.match(
    source,
    /customerCount:\s*clusterBySegmentName\.get\(segmentName\)\?\.customerCount\s*\?\?\s*0/
  );
});

test("Management report no longer re-derives segment counts from reporting-period transactions", () => {
  assert.doesNotMatch(source, /customerCount:\s*item\.customerKeys\.size/);
  assert.doesNotMatch(source, /observedBySegmentName/);
  assert.doesNotMatch(source, /canonicalEmptyRow/);
});

test("Management report derives the canonical 4 segments from the shared segment definitions", () => {
  assert.match(
    source,
    /const\s+CANONICAL_SEGMENT_NAMES\s*=\s*SEGMENT_DEFINITIONS\s*\.map\([\s\S]*?baseName[\s\S]*?\)/
  );

  for (const segmentName of CANONICAL_SEGMENT_NAMES) {
    const escaped = segmentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inDefinitions = new RegExp(
      `baseName:\\s*["']${escaped}["']`
    );
    assert.match(
      sharedSegmentSource,
      inDefinitions,
      `${segmentName} must be defined in the shared segment source`
    );
  }
});

test("Management report keeps canonical order for segment rows", () => {
  assert.match(
    source,
    /CANONICAL_SEGMENT_NAMES\.map\(\(segmentName\)\s*=>\s*\(\{\s*segmentName,/
  );
  assert.match(source, /CANONICAL_SEGMENT_ORDER/);
});
