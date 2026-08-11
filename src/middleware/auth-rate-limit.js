import { createHash } from "node:crypto"

export const AUTH_RATE_LIMIT_MESSAGE = "Too many requests. Please try again later."

export const authClientIp = (req) => String(req.ip || req.socket?.remoteAddress || "unknown")
const normalizedEmail = (req) => String(req.body?.email || "").trim().toLowerCase()
const fingerprint = (value) => createHash("sha256").update(value).digest("hex")
const tokenFingerprint = (req) => {
  const token = String(req.body?.token || req.body?.inviteToken || "")
  return token ? fingerprint(token) : "missing"
}

export const passwordResetAccountKey = (req) => {
  const email = normalizedEmail(req)
  return email ? fingerprint(email) : `missing:${authClientIp(req)}`
}

export const createAuthRateLimit = ({
  windowMs,
  max,
  keyGenerator = authClientIp,
  now = () => Date.now(),
}) => {
  const attempts = new Map()

  return (req, res, next) => {
    const timestamp = now()
    const key = String(keyGenerator(req))
    const existing = attempts.get(key)
    const entry = !existing || existing.expiresAt <= timestamp
      ? { count: 0, expiresAt: timestamp + windowMs }
      : existing

    if (entry.count >= max) {
      return res.status(429).json({ error: AUTH_RATE_LIMIT_MESSAGE })
    }

    entry.count += 1
    attempts.set(key, entry)

    // Bound stale-key retention without a background timer that could keep the
    // process or tests alive. This does not change any active limit window.
    if (attempts.size > 10_000) {
      for (const [storedKey, storedEntry] of attempts) {
        if (storedEntry.expiresAt <= timestamp) attempts.delete(storedKey)
      }
    }

    return next()
  }
}

const FIFTEEN_MINUTES = 15 * 60 * 1000
const ONE_HOUR = 60 * 60 * 1000

export const loginRateLimit = createAuthRateLimit({ windowMs: FIFTEEN_MINUTES, max: 10 })
export const googleAuthRateLimit = createAuthRateLimit({ windowMs: FIFTEEN_MINUTES, max: 20 })
export const registrationRateLimit = createAuthRateLimit({ windowMs: ONE_HOUR, max: 10 })
export const passwordResetIpRateLimit = createAuthRateLimit({ windowMs: ONE_HOUR, max: 20 })
export const passwordResetAccountRateLimit = createAuthRateLimit({
  windowMs: ONE_HOUR,
  max: 5,
  keyGenerator: passwordResetAccountKey,
})
export const passwordResetConfirmationRateLimit = createAuthRateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  keyGenerator: (req) => `${authClientIp(req)}:${tokenFingerprint(req)}`,
})
