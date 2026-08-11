import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTH_RATE_LIMIT_MESSAGE,
  createAuthRateLimit,
  passwordResetAccountKey,
} from "../auth-rate-limit.js"

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code
    return this
  },
  json(body) {
    this.body = body
    return this
  },
})

const request = ({ ip = "203.0.113.10", email, headers = {} } = {}) => ({
  ip,
  headers,
  socket: { remoteAddress: ip },
  body: email === undefined ? {} : { email },
})

test("normal authentication attempts below the limit continue", () => {
  const limiter = createAuthRateLimit({ windowMs: 60_000, max: 3 })
  let allowed = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    limiter(request(), responseRecorder(), () => { allowed += 1 })
  }
  assert.equal(allowed, 3)
})

test("excessive authentication attempts receive a generic 429", () => {
  const limiter = createAuthRateLimit({ windowMs: 60_000, max: 2 })
  limiter(request(), responseRecorder(), () => {})
  limiter(request(), responseRecorder(), () => {})
  const response = responseRecorder()
  let called = false
  limiter(request(), response, () => { called = true })
  assert.equal(called, false)
  assert.equal(response.statusCode, 429)
  assert.deepEqual(response.body, { error: AUTH_RATE_LIMIT_MESSAGE })
  assert.doesNotMatch(JSON.stringify(response.body), /count|window|email|account/i)
})

test("limits reset after their configured window", () => {
  let timestamp = 1_000
  const limiter = createAuthRateLimit({ windowMs: 100, max: 1, now: () => timestamp })
  limiter(request(), responseRecorder(), () => {})
  assert.equal(responseAfter(limiter).statusCode, 429)
  timestamp += 101
  assert.equal(responseAfter(limiter).statusCode, 200)
})

test("spoofed forwarded headers do not change the default client key", () => {
  const limiter = createAuthRateLimit({ windowMs: 60_000, max: 1 })
  limiter(request({ headers: { "x-forwarded-for": "1.1.1.1" } }), responseRecorder(), () => {})
  const response = responseRecorder()
  limiter(request({ headers: { "x-forwarded-for": "2.2.2.2" } }), response, () => {})
  assert.equal(response.statusCode, 429)
})

test("password reset account keys normalize and hash email across client IPs", () => {
  const first = passwordResetAccountKey(request({ ip: "203.0.113.1", email: " User@Example.com " }))
  const second = passwordResetAccountKey(request({ ip: "203.0.113.2", email: "user@example.com" }))
  assert.equal(first, second)
  assert.equal(first.includes("user@example.com"), false)
})

function responseAfter(limiter) {
  const response = responseRecorder()
  limiter(request(), response, () => {})
  return response
}
