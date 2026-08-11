import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"

import { prisma } from "../config/prisma.js"
import { getRequiredJwtSecret } from "../config/env.js"
import { assertValidPassword } from "./passwordPolicy.service.js"

const createResetError = (errorCode, message) =>
  Object.assign(new Error(message), { errorCode, statusCode: 400 })

export const createPasswordResetToken = (
  user,
  { secret, expiresIn = "1h" } = {}
) =>
  jwt.sign(
    {
      purpose: "password_reset",
      userId: user.id,
      email: user.email,
      resetVersion: user.passwordResetVersion,
    },
    getRequiredJwtSecret(secret),
    { expiresIn }
  )

export const verifyPasswordResetToken = (token, { secret } = {}) => {
  let payload
  try {
    payload = jwt.verify(token, getRequiredJwtSecret(secret))
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      throw createResetError(
        "PASSWORD_RESET_TOKEN_EXPIRED",
        "The password reset link has expired."
      )
    }
    throw createResetError(
      "PASSWORD_RESET_TOKEN_INVALID",
      "The password reset link is invalid."
    )
  }
  if (
    payload?.purpose !== "password_reset" ||
    !Number.isInteger(payload?.userId) ||
    !Number.isInteger(payload?.resetVersion) ||
    typeof payload?.email !== "string"
  ) {
    throw createResetError(
      "PASSWORD_RESET_TOKEN_INVALID",
      "The password reset link is invalid."
    )
  }
  return payload
}

export const resetPasswordWithToken = async (
  { token, password },
  {
    secret,
    db = prisma,
    hashPassword = (value) => bcrypt.hash(value, 10),
  } = {}
) => {
  assertValidPassword(password)
  const payload = verifyPasswordResetToken(token, { secret })
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      passwordResetVersion: true,
    },
  })
  if (!user || user.email !== payload.email) {
    throw createResetError(
      "PASSWORD_RESET_TOKEN_INVALID",
      "The password reset link is invalid."
    )
  }
  if (user.passwordResetVersion !== payload.resetVersion) {
    throw createResetError(
      "PASSWORD_RESET_TOKEN_ALREADY_USED",
      "The password reset link has already been used."
    )
  }
  const hashedPassword = await hashPassword(password)
  const updateResult = await db.user.updateMany({
    where: {
      id: user.id,
      passwordResetVersion: payload.resetVersion,
    },
    data: {
      password: hashedPassword,
      passwordResetVersion: { increment: 1 },
    },
  })
  if (updateResult.count !== 1) {
    throw createResetError(
      "PASSWORD_RESET_TOKEN_ALREADY_USED",
      "The password reset link has already been used."
    )
  }
  return { userId: user.id }
}
