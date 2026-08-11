import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../dashboard.routes.js", import.meta.url), "utf8");

test("Data Center summary returns the canonical latest transaction date", () => {
  const route = source.match(
    /dashboardRouter\.get\(\s*"\/data-center"[\s\S]*?\n\s*\)\s*;?/
  )?.[0] || source;

  assert.match(route, /getLatestTransactionDate\(prisma\)/);
  assert.match(route, /data:\s*\{[\s\S]*?latestTransactionDate/);
  assert.doesNotMatch(route, /_max:\s*\{\s*playDate/);
});
