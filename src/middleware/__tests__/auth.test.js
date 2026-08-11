import test from "node:test"
import assert from "node:assert/strict"

import {
  authorize,
  authorizeServiceScopes,
  createAuthenticate,
  SERVICE_SCOPES,
} from "../auth.js"

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code
    return this
  },
  json(payload) {
    this.body = payload
    return this
  },
})

const authenticateWith = async ({ payload, user, verificationError }) => {
  const req = { headers: { authorization: "Bearer signed-access-token" } }
  const res = responseRecorder()
  let nextCalled = false
  let nextError = null
  const middleware = createAuthenticate({
    db: {
      user: {
        findUnique: async ({ where, select }) => {
          assert.deepEqual(where, {
            id: payload?.userId ?? payload?.createdByUserId ?? payload?.createdBy,
          })
          assert.deepEqual(Object.keys(select).sort(), ["email", "id", "isActive", "role"])
          return user
        },
      },
    },
    verifyToken: () => {
      if (verificationError) throw verificationError
      return payload
    },
  })
  await middleware(req, res, (error) => {
    nextCalled = !error
    nextError = error || null
  })
  return { req, res, nextCalled, nextError }
}

const currentUser = (overrides = {}) => ({
  id: 7,
  email: "user@example.com",
  role: "operational",
  isActive: true,
  ...overrides,
})

test("active existing user is accepted using current database identity and role", async () => {
  const result = await authenticateWith({
    payload: { userId: 7, email: "old@example.com", role: "it_support" },
    user: currentUser(),
  })
  assert.equal(result.nextCalled, true)
  assert.deepEqual(result.req.user, {
    principalType: "user",
    userId: 7,
    id: 7,
    email: "user@example.com",
    role: "operational",
  })
})

test("explicit service token authenticates as a scoped service principal without userId", async () => {
  const result = await authenticateWith({
    payload: {
      tokenType: "service",
      serviceId: "service-123",
      createdByUserId: 7,
      scopes: [SERVICE_SCOPES.SYSTEM_READ_STATUS],
    },
    user: currentUser({ role: "it_support" }),
  })
  assert.equal(result.nextCalled, true)
  assert.deepEqual(result.req.user, {
    principalType: "service",
    serviceId: "service-123",
    createdByUserId: 7,
    scopes: [SERVICE_SCOPES.SYSTEM_READ_STATUS],
  })

  let scopedAccess = false
  authorizeServiceScopes(SERVICE_SCOPES.SYSTEM_READ_STATUS)(
    result.req,
    responseRecorder(),
    () => {
      scopedAccess = true
    }
  )
  assert.equal(scopedAccess, true)
  const userOnlyResponse = responseRecorder()
  authorize("it_support")(
    result.req,
    userOnlyResponse,
    () => assert.fail("service principal must not inherit IT Support role")
  )
  assert.equal(userOnlyResponse.statusCode, 403)
})

test("legacy service token has narrow status-only compatibility", async () => {
  const result = await authenticateWith({
    payload: {
      type: "service_token",
      createdBy: 7,
      role: "it_support",
    },
    user: currentUser({ role: "it_support" }),
  })
  assert.equal(result.nextCalled, true)
  assert.deepEqual(result.req.user.scopes, [SERVICE_SCOPES.SYSTEM_READ_STATUS])
  assert.equal(result.req.user.principalType, "service")
})

test("service token scopes and creator state are enforced", async () => {
  const unknownScope = await authenticateWith({
    payload: {
      tokenType: "service",
      serviceId: "service-123",
      createdByUserId: 7,
      scopes: ["system:unknown"],
    },
    user: currentUser({ role: "it_support" }),
  })
  assert.equal(unknownScope.res.body.errorCode, "AUTH_TOKEN_INVALID")

  for (const user of [null, currentUser({ isActive: false }), currentUser({ role: "operational" })]) {
    const result = await authenticateWith({
      payload: {
        tokenType: "service",
        serviceId: "service-123",
        createdByUserId: 7,
        scopes: [SERVICE_SCOPES.SYSTEM_READ_STATUS],
      },
      user,
    })
    assert.equal(result.res.statusCode, 401)
  }
})

test("missing, unknown, reset, and activation token types cannot authenticate", async () => {
  for (const payload of [
    { createdByUserId: 7, serviceId: "ambiguous", scopes: [SERVICE_SCOPES.SYSTEM_READ_STATUS] },
    { tokenType: "unknown", userId: 7 },
    { purpose: "password_reset", userId: 7 },
    { purpose: "user_invite", userId: 7 },
    { tokenType: "access", role: "operational" },
  ]) {
    const result = await authenticateWith({ payload, user: currentUser() })
    assert.equal(result.res.body.errorCode, "AUTH_TOKEN_INVALID")
    assert.equal(result.nextCalled, false)
  }
})

test("deleted and inactive users with previously valid tokens are rejected", async () => {
  const deleted = await authenticateWith({
    payload: { userId: 7, role: "it_support" },
    user: null,
  })
  assert.equal(deleted.res.statusCode, 401)
  assert.equal(deleted.res.body.errorCode, "ACCOUNT_NOT_FOUND")

  const inactive = await authenticateWith({
    payload: { userId: 7, role: "it_support" },
    user: currentUser({ isActive: false }),
  })
  assert.equal(inactive.res.statusCode, 401)
  assert.equal(inactive.res.body.errorCode, "ACCOUNT_INACTIVE")
})

test("database role wins immediately for demotion and promotion", async () => {
  const demoted = await authenticateWith({
    payload: { userId: 7, role: "it_support" },
    user: currentUser({ role: "operational" }),
  })
  const denied = responseRecorder()
  authorize("it_support")(demoted.req, denied, () => assert.fail("demoted user must not pass"))
  assert.equal(denied.statusCode, 403)

  const promoted = await authenticateWith({
    payload: { userId: 7, role: "operational" },
    user: currentUser({ role: "it_support" }),
  })
  let authorized = false
  authorize("it_support")(promoted.req, responseRecorder(), () => {
    authorized = true
  })
  assert.equal(authorized, true)
})

test("invalid and expired access tokens retain controlled authentication errors", async () => {
  const invalid = await authenticateWith({
    payload: { userId: 7 },
    verificationError: new Error("invalid signature"),
  })
  assert.equal(invalid.res.body.errorCode, "AUTH_TOKEN_INVALID")

  const expiredError = new Error("expired")
  expiredError.name = "TokenExpiredError"
  const expired = await authenticateWith({
    payload: { userId: 7 },
    verificationError: expiredError,
  })
  assert.equal(expired.res.body.errorCode, "AUTH_TOKEN_EXPIRED")
})

test("authenticated request state exposes no password or version metadata", async () => {
  const result = await authenticateWith({
    payload: { userId: 7, role: "operational" },
    user: currentUser(),
  })
  const serialized = JSON.stringify(result.req.user)
  for (const forbidden of [
    "password",
    "passwordResetVersion",
    "tokenVersion",
    "jwtSecret",
    "googleToken",
  ]) {
    assert.equal(serialized.includes(forbidden), false)
  }
})
