import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const migration = await readFile(
  new URL(
    "../../../prisma/migrations/20260810100000_backfill_legacy_notification_reads/migration.sql",
    import.meta.url
  ),
  "utf8"
)

const users = [
  { id: 101, role: "operational" },
  { id: 202, role: "operational" },
  { id: 303, role: "it_support" },
  { id: 404, role: "management" },
]
const notifications = [
  { id: 1, role: "operational", read: true },
  { id: 2, role: "operational", read: false },
  { id: 3, role: "it_support", read: true },
  { id: 4, role: "management", read: true },
  { id: 5, role: "management", read: false },
]

const receiptKey = (notificationId, userId) => `${notificationId}:${userId}`

const applyLegacyBackfill = (receipts) => {
  for (const notification of notifications) {
    if (!notification.read) continue
    for (const user of users) {
      if (user.role === notification.role) {
        receipts.add(receiptKey(notification.id, user.id))
      }
    }
  }
  return receipts
}

test("follow-up migration is role-scoped, read-only-source, and duplicate-safe", () => {
  assert.match(migration, /INSERT IGNORE INTO `notification_reads`/i)
  assert.match(migration, /`user`\.`role`\s*=\s*`notification`\.`role`/i)
  assert.match(migration, /`notification`\.`read`\s*=\s*true/i)
  assert.doesNotMatch(migration, /`user`\.`role`\s+IN\s*\(/i)
  assert.doesNotMatch(migration, /DELETE|TRUNCATE|UPDATE\s+`Notification`/i)
})

test("legacy reads are preserved for operational, management, and IT Support users", () => {
  const receipts = applyLegacyBackfill(new Set())
  assert.equal(receipts.has(receiptKey(1, 101)), true)
  assert.equal(receipts.has(receiptKey(1, 202)), true)
  assert.equal(receipts.has(receiptKey(3, 303)), true)
  assert.equal(receipts.has(receiptKey(4, 404)), true)
})

test("legacy unread notifications remain unread", () => {
  const receipts = applyLegacyBackfill(new Set())
  assert.equal(receipts.has(receiptKey(2, 101)), false)
  assert.equal(receipts.has(receiptKey(2, 202)), false)
  assert.equal(receipts.has(receiptKey(5, 404)), false)
})

test("users outside a notification target role receive no migrated receipt", () => {
  const receipts = applyLegacyBackfill(new Set())
  assert.equal(receipts.has(receiptKey(1, 303)), false)
  assert.equal(receipts.has(receiptKey(1, 404)), false)
  assert.equal(receipts.has(receiptKey(3, 101)), false)
  assert.equal(receipts.has(receiptKey(4, 101)), false)
})

test("existing per-user receipts survive and backfill is idempotent", () => {
  const existing = receiptKey(2, 101)
  const receipts = new Set([existing])
  applyLegacyBackfill(receipts)
  const afterFirstRun = [...receipts].sort()
  applyLegacyBackfill(receipts)
  assert.deepEqual([...receipts].sort(), afterFirstRun)
  assert.equal(receipts.has(existing), true)
  assert.equal(receipts.size, 5)
})

test("migrated unread counts preserve old reads while future reads remain per-user", () => {
  const receipts = applyLegacyBackfill(new Set())
  const unreadFor = (user) => notifications.filter(
    (notification) =>
      notification.role === user.role &&
      !receipts.has(receiptKey(notification.id, user.id))
  ).length

  assert.equal(unreadFor(users[0]), 1)
  assert.equal(unreadFor(users[1]), 1)
  assert.equal(unreadFor(users[2]), 0)
  assert.equal(unreadFor(users[3]), 1)
  receipts.add(receiptKey(2, users[0].id))
  assert.equal(unreadFor(users[0]), 0)
  assert.equal(unreadFor(users[1]), 1)
})
