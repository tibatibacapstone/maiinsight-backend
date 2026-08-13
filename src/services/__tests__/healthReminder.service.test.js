import assert from "node:assert/strict"
import test from "node:test"

import { shouldSend, toIssue } from "../healthReminder.service.js"

const DAY_MS = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 7, 13, 2, 0, 0) // 2026-08-13 02:00 UTC

test("meta token maps to issue levels by remaining days", () => {
  assert.equal(toIssue({ status: "valid", daysRemaining: 45 }, "meta"), null)
  assert.equal(toIssue({ status: "not_configured" }, "meta"), null)

  const warning = toIssue({ status: "warning", daysRemaining: 15, expiresAt: "2026-08-28T00:00:00.000Z" }, "meta")
  assert.equal(warning.level, "warning")
  assert.equal(warning.days, 15)

  const critical = toIssue({ status: "critical", daysRemaining: 5, expiresAt: "2026-08-18T00:00:00.000Z" }, "meta")
  assert.equal(critical.level, "critical")
  assert.equal(critical.days, 5)

  const expired = toIssue({ status: "expired" }, "meta")
  assert.equal(expired.level, "expired")

  const error = toIssue({ status: "error", error: "Meta API down" }, "meta")
  assert.equal(error.level, "error")
  assert.equal(error.detail, "Meta API down")
})

test("gemini only alerts on reachability errors", () => {
  assert.equal(toIssue({ status: "valid" }, "gemini"), null)
  assert.equal(toIssue({ status: "not_configured" }, "gemini"), null)
  const error = toIssue({ status: "error", error: "Gemini 500" }, "gemini")
  assert.equal(error.level, "error")
  assert.equal(error.name, "Gemini AI")
  assert.equal(error.detail, "Gemini 500")
})

test("shouldSend deduplicates identical levels within 24 hours", () => {
  const issue = { level: "critical", days: 5 }
  const recentState = { level: "critical", sentAt: new Date(now - 60 * 1000).toISOString() }
  const oldState = { level: "critical", sentAt: new Date(now - DAY_MS).toISOString() }

  assert.equal(shouldSend(issue, null, now), true)
  assert.equal(shouldSend(issue, recentState, now), false)
  assert.equal(shouldSend(issue, oldState, now), true)
})

test("shouldSend always escalates on level change", () => {
  const issue = { level: "critical", days: 5 }
  const previous = { level: "warning", sentAt: new Date(now - 60 * 1000).toISOString() }
  assert.equal(shouldSend(issue, previous, now), true)

  const resolved = { level: "ok", sentAt: new Date(now - 60 * 1000).toISOString() }
  assert.equal(shouldSend(issue, resolved, now), true)
})

test("shouldSend returns false when there is no active issue", () => {
  assert.equal(shouldSend(null, { level: "critical", sentAt: new Date(now).toISOString() }, now), false)
})
