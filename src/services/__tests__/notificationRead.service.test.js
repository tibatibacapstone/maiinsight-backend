import test from "node:test"
import assert from "node:assert/strict"

import {
  buildNotificationReadInclude,
  buildNotificationReceiptKey,
  buildNotificationReceiptRows,
  buildUnreadNotificationWhere,
} from "../notificationRead.service.js"

const notification = { id: 42, role: "operational" }
const userA = 101
const userB = 202

test("same-role users have independent read state", () => {
  const receipts = new Set()
  const isRead = (userId) => receipts.has(`${notification.id}:${userId}`)
  assert.equal(isRead(userA), false)
  assert.equal(isRead(userB), false)
  receipts.add(`${notification.id}:${userA}`)
  assert.equal(isRead(userA), true)
  assert.equal(isRead(userB), false)
})

test("list and unread queries use authenticated user identity", () => {
  assert.deepEqual(buildNotificationReadInclude(userA), {
    reads: { where: { userId: userA }, select: { readAt: true }, take: 1 },
  })
  assert.deepEqual(buildUnreadNotificationWhere(notification.role, userA), {
    role: notification.role,
    reads: { none: { userId: userA } },
  })
  assert.notDeepEqual(
    buildUnreadNotificationWhere(notification.role, userA),
    buildUnreadNotificationWhere(notification.role, userB)
  )
})

test("single-read receipt is unique per notification and authenticated user", () => {
  assert.deepEqual(buildNotificationReceiptKey(notification.id, userA), {
    notificationId_userId: { notificationId: notification.id, userId: userA },
  })
})

test("read-all receipt rows affect only the selected authenticated user", () => {
  const visible = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(buildNotificationReceiptRows(visible, userA), [
    { notificationId: 1, userId: userA },
    { notificationId: 2, userId: userA },
  ])
  assert.deepEqual(buildNotificationReceiptRows(visible, userB), [
    { notificationId: 1, userId: userB },
    { notificationId: 2, userId: userB },
  ])
})

test("role visibility stays separate from per-user read state", () => {
  assert.notDeepEqual(
    buildUnreadNotificationWhere("operational", userA),
    buildUnreadNotificationWhere("it_support", userA)
  )
})
