import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const authRoutes = await readFile(new URL("../auth.routes.js", import.meta.url), "utf8")
const appSource = await readFile(new URL("../../app.js", import.meta.url), "utf8")

test("all public credential endpoints have endpoint-specific limiters", () => {
  assert.match(authRoutes, /router\.post\("\/login", loginRateLimit,/)
  assert.match(authRoutes, /router\.post\("\/google", googleAuthRateLimit,/)
  assert.match(authRoutes, /router\.post\("\/register", registrationRateLimit,/)
  assert.match(authRoutes, /"\/forgot-password",[\s\S]*?passwordResetIpRateLimit,[\s\S]*?passwordResetAccountRateLimit,/)
  assert.match(authRoutes, /router\.post\("\/reset-password", passwordResetConfirmationRateLimit,/)
})

test("rate limiting is not installed globally on authenticated APIs", () => {
  assert.doesNotMatch(appSource, /authRateLimit|loginRateLimit|passwordReset.*RateLimit/)
})

test("application does not blindly trust forwarded client IP headers", () => {
  assert.doesNotMatch(appSource, /set\(["']trust proxy["'],\s*true\)/)
})
