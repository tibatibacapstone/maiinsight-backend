import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAvailableMetric,
  metricValueOrNull,
} from "../metaHistorical.service.js";

test("missing views and reach remain unavailable", () => {
  assert.equal(hasAvailableMetric([], ["views"]), false);
  assert.equal(hasAvailableMetric([{ metricName: "views", metricValue: null }], ["views"]), false);
  assert.equal(hasAvailableMetric([{ metricName: "reach", metricValue: null }], ["reach"]), false);
  assert.equal(metricValueOrNull(undefined), null);
});

test("explicit zero views and reach remain available zeroes", () => {
  assert.equal(hasAvailableMetric([{ metricName: "views", metricValue: 0 }], ["views"]), true);
  assert.equal(hasAvailableMetric([{ metricName: "reach", metricValue: 0 }], ["reach"]), true);
  assert.equal(metricValueOrNull(0), 0);
});

