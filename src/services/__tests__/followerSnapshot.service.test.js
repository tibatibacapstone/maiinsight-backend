import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateAvailableChangePct,
  resolveFollowerSnapshot,
} from "../followerSnapshot.service.js"

test("selected-period follower snapshot is preferred", () => {
  const selected = { followersCount: 2650, snapshotDate: new Date("2026-08-25T09:00:00Z") }
  const result = resolveFollowerSnapshot({
    selectedPeriodSnapshot: selected,
    latestSnapshot: { followersCount: 2700, snapshotDate: new Date("2026-09-01T09:00:00Z") },
  })

  assert.equal(result.followerCount, 2650)
  assert.equal(result.snapshotDate, selected.snapshotDate)
  assert.equal(result.snapshotSource, "selected_period")
  assert.equal(result.hasSelectedPeriodSnapshot, true)
})

test("latest overall snapshot is an explicit fallback", () => {
  const latest = { followersCount: 2633, snapshotDate: new Date("2026-08-09T09:00:00Z") }
  const result = resolveFollowerSnapshot({ selectedPeriodSnapshot: null, latestSnapshot: latest })

  assert.equal(result.followerCount, 2633)
  assert.equal(result.snapshotSource, "latest_fallback")
  assert.equal(result.hasSelectedPeriodSnapshot, false)
})

test("no follower snapshot remains unavailable", () => {
  assert.deepEqual(resolveFollowerSnapshot({}), {
    followerCount: null,
    snapshotDate: null,
    snapshotSource: "unavailable",
    hasSelectedPeriodSnapshot: false,
  })
})

test("comparison is unavailable when either period is missing or previous is zero", () => {
  assert.equal(calculateAvailableChangePct(null, 10), null)
  assert.equal(calculateAvailableChangePct(10, null), null)
  assert.equal(calculateAvailableChangePct(10, 0), null)
  assert.equal(calculateAvailableChangePct(70, 50), 40)
  assert.equal(calculateAvailableChangePct(0, 50), -100)
})
