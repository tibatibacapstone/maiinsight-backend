import test from "node:test";
import assert from "node:assert/strict";

import { getLatestTransactionDate } from "../dataCenterTransactionStatus.service.js";

const createDatabase = (rows = []) => ({
  facilityTransaction: {
    aggregate: async (query) => {
      assert.deepEqual(query._max, { transactionDate: true });
      assert.deepEqual(query.where.transactionDate, { not: null });
      assert.ok(query.where.batch.fileName.notIn.includes("tmp-upload-sample.csv"));
      const dates = rows.map((row) => row.transactionDate).filter(Boolean);
      return {
        _max: {
          transactionDate: dates.length
            ? new Date(Math.max(...dates.map((value) => value.getTime())))
            : null,
        },
      };
    },
  },
});

test("multiple canonical transaction dates return the latest date", async () => {
  const rows = [
    { batchId: 1, transactionDate: new Date("2025-12-20T00:00:00.000Z") },
    { batchId: 2, transactionDate: new Date("2026-05-15T00:00:00.000Z") },
    { batchId: 3, transactionDate: new Date("2026-07-30T00:00:00.000Z") },
  ];
  assert.equal((await getLatestTransactionDate(createDatabase(rows))).toISOString(), "2026-07-30T00:00:00.000Z");
});

test("a newer import advances the maximum and an older import cannot regress it", async () => {
  const rows = [{ batchId: 1, transactionDate: new Date("2026-07-30T00:00:00.000Z") }];
  const database = createDatabase(rows);
  rows.push({ batchId: 2, transactionDate: new Date("2026-06-15T00:00:00.000Z") });
  assert.equal((await getLatestTransactionDate(database)).toISOString(), "2026-07-30T00:00:00.000Z");
  rows.push({ batchId: 3, transactionDate: new Date("2026-08-05T00:00:00.000Z") });
  assert.equal((await getLatestTransactionDate(database)).toISOString(), "2026-08-05T00:00:00.000Z");
});

test("deleting the newest batch exposes the next latest remaining date", async () => {
  const rows = [
    { batchId: 1, transactionDate: new Date("2026-07-30T00:00:00.000Z") },
    { batchId: 2, transactionDate: new Date("2026-08-05T00:00:00.000Z") },
  ];
  const database = createDatabase(rows);
  rows.splice(rows.findIndex((row) => row.batchId === 2), 1);
  assert.equal((await getLatestTransactionDate(database)).toISOString(), "2026-07-30T00:00:00.000Z");
});

test("an empty canonical transaction table returns null", async () => {
  assert.equal(await getLatestTransactionDate(createDatabase()), null);
});
