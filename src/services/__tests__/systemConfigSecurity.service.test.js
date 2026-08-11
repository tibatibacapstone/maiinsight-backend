import test from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"

import { authorize, authenticate } from "../../middleware/auth.js"
import {
  SYSTEM_CONFIG_ROLES,
  SYSTEM_STATUS_ROLES,
  SAFE_USER_DIRECTORY_SELECT,
  USER_MANAGEMENT_ROLES,
  ALLOWED_SERVICE_TOKEN_SCOPES,
  createServiceToken,
} from "../../routes/system.routes.js"
import {
  buildIntegrationSettingsUpdate,
  buildSafeIntegrationConfig,
  buildSafeIntegrationStatus,
} from "../systemConfigSecurity.service.js"
import { APP_SETTING_KEYS } from "../appConfig.service.js"

const secretConfig = {
  geminiApiKey: "gemini-secret-value",
  geminiModel: "gemini-2.5-flash",
  geminiEnabled: true,
  metaIgUserId: "ig-public-id",
  metaAccessToken: "meta-secret-value",
  metaGraphVersion: "v25.0",
  metaEnabled: true,
}

const forbiddenKeys = new Set([
  "geminiapikey",
  "metaaccesstoken",
  "jwtsecret",
  "databaseurl",
  "clientsecret",
  "accesstoken",
  "apikey",
])

const findForbiddenKey = (value) => {
  if (Array.isArray(value)) return value.some(findForbiddenKey)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
    const safeConfiguredBoolean =
      normalized === "geminiapikeyconfigured" ||
      normalized === "metaaccesstokenconfigured"
    return (!safeConfiguredBoolean && forbiddenKeys.has(normalized)) || findForbiddenKey(nested)
  })
}

const runAuthorization = (middleware, role) => {
  let statusCode = 200
  let body = null
  let nextCalled = false
  middleware(
    { user: role ? { principalType: "user", role } : undefined },
    {
      status(code) {
        statusCode = code
        return this
      },
      json(payload) {
        body = payload
        return this
      },
    },
    () => {
      nextCalled = true
    }
  )
  return { statusCode, body, nextCalled }
}

test("safe Operational status never contains integration credentials or server secrets", () => {
  const status = buildSafeIntegrationStatus({
    config: secretConfig,
    aiProviderStatus: {
      configured: true,
      provider: "gemini",
      providerLabel: "Gemini",
      model: "gemini-2.5-flash",
    },
  })
  assert.equal(status.gemini.configured, true)
  assert.equal(status.meta.configured, true)
  assert.equal(findForbiddenKey(status), false)
  const serialized = JSON.stringify(status)
  assert.equal(serialized.includes(secretConfig.geminiApiKey), false)
  assert.equal(serialized.includes(secretConfig.metaAccessToken), false)
})

test("IT configuration response reports secret presence without returning secret values", () => {
  const response = buildSafeIntegrationConfig(secretConfig)
  assert.equal(response.geminiApiKeyConfigured, true)
  assert.equal(response.metaAccessTokenConfigured, true)
  assert.equal(findForbiddenKey(response), false)
  assert.equal(JSON.stringify(response).includes("gemini-secret-value"), false)
  assert.equal(JSON.stringify(response).includes("meta-secret-value"), false)
})

test("blank secret updates preserve stored values and new secrets replace them", () => {
  const blankUpdate = buildIntegrationSettingsUpdate(
    { geminiApiKey: " ", metaAccessToken: "" },
    secretConfig
  )
  assert.equal(APP_SETTING_KEYS.GEMINI_API_KEY in blankUpdate, false)
  assert.equal(APP_SETTING_KEYS.META_ACCESS_TOKEN in blankUpdate, false)

  const replacement = buildIntegrationSettingsUpdate(
    { geminiApiKey: " new-gemini ", metaAccessToken: " new-meta " },
    secretConfig
  )
  assert.equal(replacement[APP_SETTING_KEYS.GEMINI_API_KEY], "new-gemini")
  assert.equal(replacement[APP_SETTING_KEYS.META_ACCESS_TOKEN], "new-meta")
})

test("system endpoint role policy allows safe status to Operational/IT and config only to IT", () => {
  assert.deepEqual(SYSTEM_STATUS_ROLES, ["operational", "it_support"])
  assert.deepEqual(SYSTEM_CONFIG_ROLES, ["it_support"])
  assert.deepEqual(USER_MANAGEMENT_ROLES, ["it_support"])

  assert.equal(
    runAuthorization(authorize(...SYSTEM_STATUS_ROLES), "operational").nextCalled,
    true
  )
  assert.equal(
    runAuthorization(authorize(...SYSTEM_CONFIG_ROLES), "operational").statusCode,
    403
  )
  assert.equal(
    runAuthorization(authorize(...SYSTEM_CONFIG_ROLES), "it_support").nextCalled,
    true
  )
  assert.equal(
    runAuthorization(authorize(...SYSTEM_STATUS_ROLES), "management").statusCode,
    403
  )
})

test("user directory and every user-management operation are IT Support-only", () => {
  const userAuthorization = authorize(...USER_MANAGEMENT_ROLES)
  assert.equal(runAuthorization(userAuthorization, "it_support").nextCalled, true)
  assert.equal(runAuthorization(userAuthorization, "operational").statusCode, 403)
  assert.equal(runAuthorization(userAuthorization, "management").statusCode, 403)
  assert.deepEqual(Object.keys(SAFE_USER_DIRECTORY_SELECT).sort(), [
    "createdAt",
    "email",
    "id",
    "isActive",
    "name",
    "role",
    "updatedAt",
  ])
  for (const forbidden of [
    "password",
    "passwordResetVersion",
    "resetTokenVersion",
    "activationToken",
    "accessToken",
    "refreshToken",
  ]) {
    assert.equal(forbidden in SAFE_USER_DIRECTORY_SELECT, false)
  }
})

test("new service tokens use explicit identity and least-privilege scopes", () => {
  const secret = "explicit-service-token-test-secret"
  const token = createServiceToken({
    createdByUserId: 11,
    label: "Status monitor",
    scopes: ALLOWED_SERVICE_TOKEN_SCOPES,
    serviceId: "service-test-id",
    secret,
  })
  const payload = jwt.verify(token, secret)
  assert.equal(payload.tokenType, "service")
  assert.equal(payload.serviceId, "service-test-id")
  assert.equal(payload.createdByUserId, 11)
  assert.deepEqual(payload.scopes, ["system:read-status"])
  assert.equal(payload.role, undefined)
  assert.equal(payload.userId, undefined)

  const issueAuthorization = authorize("it_support")
  assert.equal(
    runAuthorization(issueAuthorization, "operational").statusCode,
    403
  )
  assert.equal(
    runAuthorization(issueAuthorization, "it_support").nextCalled,
    true
  )
})

test("unauthenticated system requests are rejected", () => {
  let statusCode = 200
  let payload = null
  authenticate(
    { headers: {} },
    {
      status(code) {
        statusCode = code
        return this
      },
      json(body) {
        payload = body
        return this
      },
    },
    () => assert.fail("authenticate must not call next without a token")
  )
  assert.equal(statusCode, 401)
  assert.equal(payload.error, "Authentication token required")
})
