import test from "node:test";
import assert from "node:assert/strict";

import {
  getPersistedMetaConnectionState,
  resolveMetaConnectionStatus,
} from "../meta.service.js";

test("failed connection validation produces error status", async () => {
  const result = await resolveMetaConnectionStatus({
    configured: true,
    latestSync: { status: "SUCCESS" },
    testConnection: async () => ({ ok: false, error: "sanitized Meta error" }),
  });

  assert.deepEqual(result, {
    connectionState: "error",
    connectionError: "sanitized Meta error",
  });
});

test("successful validation recovers a stale failed-sync connection state", async () => {
  const latestSync = { status: "FAILED", message: "previous sync failed" };
  const result = await resolveMetaConnectionStatus({
    configured: true,
    latestSync,
    testConnection: async () => ({ ok: true, username: "account" }),
  });

  assert.deepEqual(result, { connectionState: "connected", connectionError: null });
  assert.equal(latestSync.status, "FAILED");
  assert.equal(latestSync.message, "previous sync failed");
});

test("successful connection validation does not mark a failed full sync as completed", async () => {
  const latestSync = { status: "FAILED" };
  assert.equal(getPersistedMetaConnectionState({ configured: true, latestSync }), "error");

  await resolveMetaConnectionStatus({
    configured: true,
    latestSync,
    testConnection: async () => ({ ok: true }),
  });

  assert.deepEqual(latestSync, { status: "FAILED" });
});

test("running sync remains syncing without issuing another connection request", async () => {
  let testCalls = 0;
  const result = await resolveMetaConnectionStatus({
    configured: true,
    latestSync: { status: "RUNNING" },
    testConnection: async () => {
      testCalls += 1;
      return { ok: true };
    },
  });

  assert.deepEqual(result, { connectionState: "syncing", connectionError: null });
  assert.equal(testCalls, 0);
});

test("missing configuration remains not configured", async () => {
  const result = await resolveMetaConnectionStatus({
    configured: false,
    latestSync: { status: "FAILED" },
    testConnection: async () => ({ ok: true }),
  });

  assert.deepEqual(result, { connectionState: "not_configured", connectionError: null });
});
