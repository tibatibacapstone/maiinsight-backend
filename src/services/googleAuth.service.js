import { OAuth2Client } from "google-auth-library"

import { env } from "../config/env.js"

const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
])

const googleAuthError = (errorCode, message, statusCode = 401) =>
  Object.assign(new Error(message), { errorCode, statusCode })

export const verifyGoogleIdToken = async ({
  idToken,
  clientId = env.googleClientId,
  oauthClient,
  now = Date.now(),
}) => {
  const expectedAudience = String(clientId || "").trim()
  if (!expectedAudience) {
    throw googleAuthError(
      "GOOGLE_TOKEN_INVALID",
      "Google login is not configured.",
      503
    )
  }
  if (!String(idToken || "").trim()) {
    throw googleAuthError("GOOGLE_TOKEN_INVALID", "Google credential is invalid.")
  }

  const verifier = oauthClient || new OAuth2Client(expectedAudience)
  let ticket
  try {
    ticket = await verifier.verifyIdToken({
      idToken,
      audience: expectedAudience,
    })
  } catch (error) {
    const verificationMessage = String(error?.message || "")
    const audienceMismatch = /audience|recipient|client.?id/i.test(verificationMessage)
    throw googleAuthError(
      audienceMismatch ? "GOOGLE_TOKEN_AUDIENCE_MISMATCH" : "GOOGLE_TOKEN_INVALID",
      "Google credential is invalid."
    )
  }

  const payload = ticket?.getPayload?.()
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]
  if (!audiences.includes(expectedAudience)) {
    throw googleAuthError(
      "GOOGLE_TOKEN_AUDIENCE_MISMATCH",
      "Google credential is invalid."
    )
  }
  if (!GOOGLE_ISSUERS.has(payload?.iss)) {
    throw googleAuthError("GOOGLE_TOKEN_INVALID", "Google credential is invalid.")
  }
  if (!Number.isFinite(Number(payload?.exp)) || Number(payload.exp) * 1000 <= now) {
    throw googleAuthError("GOOGLE_TOKEN_INVALID", "Google credential is invalid.")
  }
  if (!payload?.email) {
    throw googleAuthError("GOOGLE_TOKEN_INVALID", "Google credential is invalid.")
  }
  if (payload.email_verified !== true) {
    throw googleAuthError(
      "GOOGLE_EMAIL_NOT_VERIFIED",
      "Google email is not verified."
    )
  }

  return {
    email: String(payload.email).trim().toLowerCase(),
  }
}

export const authenticateGoogleCredential = async ({
  idToken,
  db,
  verify = verifyGoogleIdToken,
}) => {
  const identity = await verify({ idToken })
  const user = await db.user.findUnique({ where: { email: identity.email } })
  if (!user) {
    throw googleAuthError(
      "ACCOUNT_NOT_REGISTERED",
      "Account is not registered. Please contact IT Support."
    )
  }
  if (user.isActive === false) {
    throw googleAuthError("ACCOUNT_INACTIVE", "Account is inactive.")
  }
  return user
}
