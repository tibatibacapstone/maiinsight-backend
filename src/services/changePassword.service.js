import crypto from "node:crypto"
import bcrypt from "bcryptjs"

import { prisma } from "../config/prisma.js"
import { assertValidPassword } from "./passwordPolicy.service.js"

const CODE_TTL_MS = 15 * 60 * 1000

const createChangePasswordError = (errorCode, message, statusCode = 400) =>
  Object.assign(new Error(message), { errorCode, statusCode })

const generateSixDigitCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")

export const requestChangePasswordCode = async (
  userId,
  { db = prisma, hashCode = (value) => bcrypt.hash(value, 10), now = () => new Date() } = {},
) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  })

  if (!user) {
    throw createChangePasswordError("ACCOUNT_NOT_FOUND", "Account is no longer available.", 404)
  }

  const code = generateSixDigitCode()
  const hashedCode = await hashCode(code)
  const expiresAt = new Date(now().getTime() + CODE_TTL_MS)

  await db.user.update({
    where: { id: userId },
    data: {
      changePasswordCode: hashedCode,
      changePasswordCodeExpiresAt: expiresAt,
    },
  })

  return { code, user }
}

export const confirmChangePassword = async (
  userId,
  { code, newPassword },
  {
    db = prisma,
    hashPassword = (value) => bcrypt.hash(value, 10),
    compareCode = (value, hash) => bcrypt.compare(value, hash),
    now = () => new Date(),
  } = {},
) => {
  assertValidPassword(newPassword)

  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw createChangePasswordError("CHANGE_PASSWORD_CODE_INVALID", "Enter the 6-digit code from your email.")
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      changePasswordCode: true,
      changePasswordCodeExpiresAt: true,
      passwordResetVersion: true,
    },
  })

  if (!user?.changePasswordCode || !user.changePasswordCodeExpiresAt) {
    throw createChangePasswordError(
      "CHANGE_PASSWORD_CODE_MISSING",
      "Request a new confirmation code before continuing.",
    )
  }

  if (user.changePasswordCodeExpiresAt.getTime() <= now().getTime()) {
    throw createChangePasswordError(
      "CHANGE_PASSWORD_CODE_EXPIRED",
      "This confirmation code has expired. Request a new one.",
    )
  }

  const codeMatches = await compareCode(code, user.changePasswordCode)
  if (!codeMatches) {
    throw createChangePasswordError("CHANGE_PASSWORD_CODE_INVALID", "That confirmation code is incorrect.")
  }

  const hashedPassword = await hashPassword(newPassword)

  await db.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      passwordResetVersion: { increment: 1 },
      changePasswordCode: null,
      changePasswordCodeExpiresAt: null,
    },
  })

  return { userId }
}
