import bcrypt from "bcryptjs"

import { prisma } from "../config/prisma.js"
import { assertValidPassword } from "./passwordPolicy.service.js"

const registrationError = (errorCode, message, statusCode = 400) =>
  Object.assign(new Error(message), { errorCode, statusCode })

export const registerInvitedUser = async (
  { inviteToken, password, now = new Date() },
  {
    db = prisma,
    hashPassword = (value) => bcrypt.hash(value, 10),
  } = {},
) => {
  assertValidPassword(password)

  const invite = await db.userInvite.findUnique({ where: { token: inviteToken } })
  if (!invite || invite.usedAt) {
    throw registrationError(
      "INVITE_INVALID_OR_USED",
      "Invalid or expired invite token",
    )
  }
  if (invite.expiresAt <= now) {
    throw registrationError("INVITE_EXPIRED", "Invite token has expired")
  }

  const existingUser = await db.user.findUnique({ where: { email: invite.email } })
  if (existingUser) {
    throw registrationError("USER_ALREADY_EXISTS", "User already exists", 409)
  }

  const hashedPassword = await hashPassword(password)

  return db.$transaction(async (transaction) => {
    const consumed = await transaction.userInvite.updateMany({
      where: {
        id: invite.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    })

    if (consumed.count !== 1) {
      throw registrationError(
        "INVITE_INVALID_OR_USED",
        "Invalid or expired invite token",
      )
    }

    return transaction.user.create({
      data: {
        email: invite.email,
        name: invite.name,
        password: hashedPassword,
        role: invite.role,
      },
    })
  }, { isolationLevel: "Serializable" })
}
