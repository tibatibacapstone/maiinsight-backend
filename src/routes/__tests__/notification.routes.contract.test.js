import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const source = await readFile(new URL("../operations.routes.js", import.meta.url), "utf8")
const notificationRoutes = source.match(/router\.get\(\s*"\/notifications"[\s\S]*?router\.get\(/)?.[0] || ""
const unreadRoute = source.match(/"\/notifications\/unread-count"[\s\S]*?router\.patch\(/)?.[0] || ""
const singleReadRoute = source.match(/"\/notifications\/:id\/read"[\s\S]*?router\.post\(/)?.[0] || ""
const readAllRoute = source.match(/"\/notifications\/read-all"[\s\S]*?router\.get\(/)?.[0] || ""

test("notification list and unread count are scoped by role and authenticated user", () => {
  assert.match(notificationRoutes, /where: \{ role: req\.user\.role \}/)
  assert.match(notificationRoutes, /buildNotificationReadInclude\(req\.user\.userId\)/)
  assert.match(unreadRoute, /buildUnreadNotificationWhere\(req\.user\.role, req\.user\.userId\)/)
})

test("single read verifies role visibility then writes only the authenticated user's receipt", () => {
  assert.match(singleReadRoute, /id,[\s\S]*?role: req\.user\.role/)
  assert.match(singleReadRoute, /buildNotificationReceiptKey\(id, req\.user\.userId\)/)
  assert.match(singleReadRoute, /userId: req\.user\.userId/)
  assert.doesNotMatch(singleReadRoute, /req\.body.*userId|notification\.update\(/)
})

test("read all creates per-user receipts without mutating shared notifications", () => {
  assert.match(readAllRoute, /buildUnreadNotificationWhere\(req\.user\.role, req\.user\.userId\)/)
  assert.match(readAllRoute, /notificationRead\.createMany/)
  assert.match(readAllRoute, /buildNotificationReceiptRows\(visibleNotifications, req\.user\.userId\)/)
  assert.doesNotMatch(readAllRoute, /notification\.updateMany/)
})
