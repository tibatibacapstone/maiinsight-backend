import test from "node:test"
import assert from "node:assert/strict"
import jwt from "jsonwebtoken"

import { env } from "../../config/env.js"
import { createToken } from "../../routes/auth.routes.js"
import {
  authenticateGoogleCredential,
  verifyGoogleIdToken,
} from "../googleAuth.service.js"

const CLIENT_ID = "maiinsight-client.apps.googleusercontent.com"
const validPayload = (overrides = {}) => ({
  aud: CLIENT_ID,
  iss: "https://accounts.google.com",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "registered@example.com",
  email_verified: true,
  ...overrides,
})

const verifierFor = (payload) => ({
  verifyIdToken: async ({ idToken, audience }) => {
    assert.equal(idToken, "signed-google-id-token")
    assert.equal(audience, CLIENT_ID)
    return { getPayload: () => payload }
  },
})

test("valid signed Google ID token for the configured audience is accepted", async () => {
  const identity = await verifyGoogleIdToken({
    idToken: "signed-google-id-token",
    clientId: CLIENT_ID,
    oauthClient: verifierFor(validPayload()),
  })
  assert.deepEqual(identity, { email: "registered@example.com" })
})

test("wrong audience, expiration, invalid signature, missing email, and unverified email are rejected", async () => {
  const cases = [
    [validPayload({ aud: "attacker-client.apps.googleusercontent.com" }), "GOOGLE_TOKEN_AUDIENCE_MISMATCH"],
    [validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }), "GOOGLE_TOKEN_INVALID"],
    [validPayload({ email: undefined }), "GOOGLE_TOKEN_INVALID"],
    [validPayload({ email_verified: false }), "GOOGLE_EMAIL_NOT_VERIFIED"],
  ]
  for (const [payload, errorCode] of cases) {
    await assert.rejects(
      () => verifyGoogleIdToken({
        idToken: "signed-google-id-token",
        clientId: CLIENT_ID,
        oauthClient: verifierFor(payload),
      }),
      (error) => error.errorCode === errorCode
    )
  }
  await assert.rejects(
    () => verifyGoogleIdToken({
      idToken: "signed-google-id-token",
      clientId: CLIENT_ID,
      oauthClient: {
        verifyIdToken: async () => {
          throw new Error("invalid signature")
        },
      },
    }),
    (error) => error.errorCode === "GOOGLE_TOKEN_INVALID"
  )
})

test("unregistered Google identity is rejected without trusting its role", async () => {
  await assert.rejects(
    () => authenticateGoogleCredential({
      idToken: "raw-google-token",
      db: { user: { findUnique: async () => null } },
      verify: async () => ({
        email: "unknown@example.com",
        role: "it_support",
      }),
    }),
    (error) => error.errorCode === "ACCOUNT_NOT_REGISTERED"
  )
})

test("registered but inactive Google user is rejected", async () => {
  await assert.rejects(
    () => authenticateGoogleCredential({
      idToken: "raw-google-token",
      db: {
        user: {
          findUnique: async () => ({
            id: 8,
            email: "inactive@example.com",
            role: "it_support",
            isActive: false,
          }),
        },
      },
      verify: async () => ({ email: "inactive@example.com" }),
    }),
    (error) => error.errorCode === "ACCOUNT_INACTIVE"
  )
})

test("registered user receives a MaiinSight JWT with the database role", async () => {
  const databaseUser = {
    id: 42,
    email: "registered@example.com",
    name: "Registered User",
    role: "operational",
  }
  const rawGoogleToken = "raw-google-token-must-not-leak"
  const user = await authenticateGoogleCredential({
    idToken: rawGoogleToken,
    db: {
      user: {
        findUnique: async ({ where }) => {
          assert.deepEqual(where, { email: databaseUser.email })
          return databaseUser
        },
      },
    },
    verify: async ({ idToken }) => {
      assert.equal(idToken, rawGoogleToken)
      return { email: databaseUser.email, role: "it_support" }
    },
  })

  const previousSecret = env.jwtSecret
  env.jwtSecret = "explicit-google-auth-test-secret"
  try {
    const token = createToken(user)
    const payload = jwt.verify(token, env.jwtSecret)
    assert.equal(payload.tokenType, "access")
    assert.equal(payload.role, "operational")
    assert.equal(payload.userId, 42)
    const response = { token, user }
    assert.equal(JSON.stringify(response).includes(rawGoogleToken), false)
  } finally {
    env.jwtSecret = previousSecret
  }
})
