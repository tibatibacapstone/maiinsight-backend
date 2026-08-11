import jwt from "jsonwebtoken"

import { getRequiredJwtSecret } from "../config/env.js"
import { prisma } from "../config/prisma.js"

const validRoles = new Set(["operational", "management", "it_support"])
export const SERVICE_SCOPES = Object.freeze({
  SYSTEM_READ_STATUS: "system:read-status",
})
const validServiceScopes = new Set(Object.values(SERVICE_SCOPES))

const rejectAuthentication = (res, errorCode, error) =>
  res.status(401).json({ errorCode, error })

export const createAuthenticate = ({
  db = prisma,
  verifyToken = (token) => jwt.verify(token, getRequiredJwtSecret()),
} = {}) => async (req, res, next) => {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null

  if (!token) {
    return rejectAuthentication(
      res,
      "AUTH_TOKEN_INVALID",
      "Authentication token required"
    )
  }

  let payload
  try {
    payload = verifyToken(token)
  } catch (error) {
    return rejectAuthentication(
      res,
      error?.name === "TokenExpiredError" ? "AUTH_TOKEN_EXPIRED" : "AUTH_TOKEN_INVALID",
      "Invalid or expired token"
    )
  }

  const isAccessToken =
    payload?.tokenType === "access" ||
    (
      !payload?.tokenType &&
      !payload?.type &&
      (!payload?.purpose || payload.purpose === "access") &&
      Number.isInteger(payload?.userId)
    )
  const isServiceToken = payload?.tokenType === "service"
  const isLegacyServiceToken =
    !payload?.tokenType &&
    payload?.type === "service_token" &&
    Number.isInteger(payload?.createdBy)

  if (!isAccessToken && !isServiceToken && !isLegacyServiceToken) {
    return rejectAuthentication(res, "AUTH_TOKEN_INVALID", "Unsupported token type")
  }

  if (isAccessToken && !Number.isInteger(payload?.userId)) {
    return rejectAuthentication(res, "AUTH_TOKEN_INVALID", "Invalid or expired token")
  }

  const principalUserId = isAccessToken
    ? payload.userId
    : isLegacyServiceToken
      ? payload.createdBy
      : payload.createdByUserId
  if (!Number.isInteger(principalUserId)) {
    return rejectAuthentication(res, "AUTH_TOKEN_INVALID", "Invalid service token")
  }

  let user
  try {
    user = await db.user.findUnique({
      where: { id: principalUserId },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
      },
    })
  } catch (error) {
    return next(error)
  }

  if (!user) {
    return rejectAuthentication(
      res,
      "ACCOUNT_NOT_FOUND",
      "Account is no longer available"
    )
  }
  if (user.isActive !== true) {
    return rejectAuthentication(
      res,
      "ACCOUNT_INACTIVE",
      "Account is inactive"
    )
  }
  if (!validRoles.has(user.role)) {
    return rejectAuthentication(res, "AUTH_TOKEN_INVALID", "Invalid account role")
  }

  if (isAccessToken) {
    req.user = {
      principalType: "user",
      userId: user.id,
      id: user.id,
      email: user.email,
      role: user.role,
    }
    return next()
  }

  if (user.role !== "it_support") {
    return rejectAuthentication(
      res,
      "SERVICE_TOKEN_REVOKED",
      "Service token is no longer authorized"
    )
  }
  const scopes = isLegacyServiceToken
    ? [SERVICE_SCOPES.SYSTEM_READ_STATUS]
    : payload.scopes
  if (
    (!payload?.serviceId && !isLegacyServiceToken) ||
    !Array.isArray(scopes) ||
    !scopes.length ||
    scopes.some((scope) => !validServiceScopes.has(scope))
  ) {
    return rejectAuthentication(res, "AUTH_TOKEN_INVALID", "Invalid service token")
  }
  req.user = {
    principalType: "service",
    serviceId: payload.serviceId || `legacy:${payload.createdBy}`,
    createdByUserId: user.id,
    scopes: [...new Set(scopes)],
  }
  return next()
}

export const authenticate = createAuthenticate()

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role
    if (
      req.user?.principalType !== "user" ||
      !userRole ||
      !allowedRoles.includes(userRole)
    ) {
      return res.status(403).json({ error: "Unauthorized access" })
    }
    return next()
  }
}

export const authorizeServiceScopes = (...requiredScopes) => {
  return (req, res, next) => {
    if (
      req.user?.principalType !== "service" ||
      !requiredScopes.every((scope) => req.user.scopes?.includes(scope))
    ) {
      return res.status(403).json({ error: "Unauthorized service scope" })
    }
    return next()
  }
}

export const authorizeUserOrService = ({
  userRoles = [],
  serviceScopes = [],
} = {}) => {
  const userAuthorization = authorize(...userRoles)
  const serviceAuthorization = authorizeServiceScopes(...serviceScopes)
  return (req, res, next) =>
    req.user?.principalType === "service"
      ? serviceAuthorization(req, res, next)
      : userAuthorization(req, res, next)
}
