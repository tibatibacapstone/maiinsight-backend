import test from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"

import {
  createPasswordResetToken,
  resetPasswordWithToken,
  verifyPasswordResetToken,
} from "../passwordReset.service.js"

const SECRET = "test-only-password-reset-secret-with-sufficient-length"

test("password-reset signing fails safely when an explicit secret is empty", () => {
  assert.throws(
    () =>
      createPasswordResetToken(
        {
          id: 7,
          email: "user@example.com",
          passwordResetVersion: 0,
        },
        { secret: "" }
      ),
    /JWT_SECRET is required/
  )
})

const createUserDb = async () => {
  const state = {
    user: {
      id: 7,
      email: "user@example.com",
      password: await bcrypt.hash("OldPassword123!", 4),
      passwordResetVersion: 0,
    },
  }
  return {
    state,
    db: {
      user: {
        findUnique: async ({ where }) =>
          where.id === state.user.id
            ? {
                id: state.user.id,
                email: state.user.email,
                passwordResetVersion: state.user.passwordResetVersion,
              }
            : null,
        updateMany: async ({ where, data }) => {
          if (
            where.id !== state.user.id ||
            where.passwordResetVersion !== state.user.passwordResetVersion
          ) {
            return { count: 0 }
          }
          state.user.password = data.password
          state.user.passwordResetVersion += data.passwordResetVersion.increment
          return { count: 1 }
        },
      },
    },
  }
}

test("valid reset token changes the hash once and enables only the new password", async () => {
  const { state, db } = await createUserDb()
  const originalHash = state.user.password
  const token = createPasswordResetToken(state.user, { secret: SECRET })

  await resetPasswordWithToken(
    { token, password: "NewPassword123!" },
    { secret: SECRET, db, hashPassword: (value) => bcrypt.hash(value, 4) }
  )

  assert.notEqual(state.user.password, originalHash)
  assert.equal(await bcrypt.compare("NewPassword123!", state.user.password), true)
  assert.equal(await bcrypt.compare("OldPassword123!", state.user.password), false)
  assert.equal(state.user.passwordResetVersion, 1)

  await assert.rejects(
    resetPasswordWithToken(
      { token, password: "AttackerPassword123!" },
      { secret: SECRET, db, hashPassword: (value) => bcrypt.hash(value, 4) }
    ),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_ALREADY_USED"
  )
  assert.equal(await bcrypt.compare("NewPassword123!", state.user.password), true)
})

test("weak reset password is rejected before hashing or account mutation", async () => {
  const { state, db } = await createUserDb()
  const originalHash = state.user.password
  const token = createPasswordResetToken(state.user, { secret: SECRET })
  let hashCalls = 0

  await assert.rejects(
    resetPasswordWithToken(
      { token, password: "weak" },
      {
        secret: SECRET,
        db,
        hashPassword: async () => {
          hashCalls += 1
          return "unexpected-hash"
        },
      }
    ),
    (error) => error.errorCode === "PASSWORD_TOO_SHORT"
  )

  assert.equal(hashCalls, 0)
  assert.equal(state.user.password, originalHash)
  assert.equal(state.user.passwordResetVersion, 0)
})

test("expired, malformed, wrong-purpose, and mismatched-user reset tokens are rejected", async () => {
  const { state, db } = await createUserDb()
  const expired = createPasswordResetToken(state.user, {
    secret: SECRET,
    expiresIn: -1,
  })
  assert.throws(
    () => verifyPasswordResetToken(expired, { secret: SECRET }),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_EXPIRED"
  )
  assert.throws(
    () => verifyPasswordResetToken("not-a-jwt", { secret: SECRET }),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_INVALID"
  )
  const accessToken = jwt.sign(
    { purpose: "access", userId: state.user.id, email: state.user.email, resetVersion: 0 },
    SECRET,
    { expiresIn: "1h" }
  )
  assert.throws(
    () => verifyPasswordResetToken(accessToken, { secret: SECRET }),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_INVALID"
  )
  const serviceToken = jwt.sign(
    {
      tokenType: "service",
      serviceId: "service-test",
      createdByUserId: state.user.id,
      scopes: ["system:read-status"],
    },
    SECRET,
    { expiresIn: "1h" }
  )
  assert.throws(
    () => verifyPasswordResetToken(serviceToken, { secret: SECRET }),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_INVALID"
  )
  const otherUserToken = createPasswordResetToken(
    { ...state.user, email: "other@example.com" },
    { secret: SECRET }
  )
  await assert.rejects(
    resetPasswordWithToken(
      { token: otherUserToken, password: "NewPassword123!" },
      { secret: SECRET, db }
    ),
    (error) => error.errorCode === "PASSWORD_RESET_TOKEN_INVALID"
  )
})

test("ordinary access-token signing and verification remain unaffected", () => {
  const token = jwt.sign(
    { userId: 7, email: "user@example.com", role: "operational" },
    SECRET,
    { expiresIn: "8h" }
  )
  const payload = jwt.verify(token, SECRET)
  assert.equal(payload.userId, 7)
  assert.equal(payload.role, "operational")
  assert.equal(payload.purpose, undefined)
})
