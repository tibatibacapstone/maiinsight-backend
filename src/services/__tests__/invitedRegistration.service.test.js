import assert from "node:assert/strict"
import test from "node:test"

import { registerInvitedUser } from "../invitedRegistration.service.js"
import {
  MINIMUM_PASSWORD_LENGTH,
  validatePassword,
} from "../passwordPolicy.service.js"

const VALID_PASSWORD = "ValidPass123!"

function createDatabase({ failUserCreation = false } = {}) {
  const state = {
    invite: {
      id: 1,
      token: "test-invite-token",
      email: "invitee@example.com",
      name: "Invited User",
      role: "operational",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      usedAt: null,
    },
    users: [],
  }

  const db = {
    userInvite: {
      findUnique: async ({ where }) =>
        where.token === state.invite.token ? { ...state.invite } : null,
    },
    user: {
      findUnique: async ({ where }) =>
        state.users.find((user) => user.email === where.email) || null,
    },
    $transaction: async (operation) => {
      const draft = {
        invite: { ...state.invite },
        users: state.users.map((user) => ({ ...user })),
      }
      const transaction = {
        userInvite: {
          updateMany: async ({ where, data }) => {
            if (
              draft.invite.id !== where.id ||
              draft.invite.usedAt !== null ||
              draft.invite.expiresAt <= where.expiresAt.gt
            ) {
              return { count: 0 }
            }
            draft.invite.usedAt = data.usedAt
            return { count: 1 }
          },
        },
        user: {
          create: async ({ data }) => {
            if (failUserCreation) throw new Error("simulated user creation failure")
            const user = { id: draft.users.length + 1, ...data }
            draft.users.push(user)
            return user
          },
        },
      }

      const result = await operation(transaction)
      state.invite = draft.invite
      state.users = draft.users
      return result
    },
  }

  return { db, state }
}

test("password policy rejects missing, empty, and weak passwords", () => {
  assert.equal(validatePassword(undefined).errorCode, "PASSWORD_REQUIRED")
  assert.equal(validatePassword("").errorCode, "PASSWORD_REQUIRED")
  assert.equal(
    validatePassword("x".repeat(MINIMUM_PASSWORD_LENGTH - 1)).errorCode,
    "PASSWORD_TOO_SHORT",
  )
  assert.equal(validatePassword(VALID_PASSWORD).valid, true)
})

test("invalid password does not hash, create a user, or consume the invitation", async () => {
  const { db, state } = createDatabase()
  let hashCalls = 0

  await assert.rejects(
    registerInvitedUser(
      { inviteToken: state.invite.token, password: "weak" },
      {
        db,
        hashPassword: async () => {
          hashCalls += 1
          return "unexpected-hash"
        },
      },
    ),
    (error) => error.errorCode === "PASSWORD_TOO_SHORT",
  )

  assert.equal(hashCalls, 0)
  assert.equal(state.invite.usedAt, null)
  assert.equal(state.users.length, 0)
})

test("failed user creation rolls back invitation consumption", async () => {
  const { db, state } = createDatabase({ failUserCreation: true })

  await assert.rejects(
    registerInvitedUser(
      { inviteToken: state.invite.token, password: VALID_PASSWORD },
      { db, hashPassword: async () => "valid-hash" },
    ),
    /simulated user creation failure/,
  )

  assert.equal(state.invite.usedAt, null)
  assert.equal(state.users.length, 0)
})

test("successful registration hashes after validation and consumes invitation once", async () => {
  const { db, state } = createDatabase()
  const calls = []

  const user = await registerInvitedUser(
    { inviteToken: state.invite.token, password: VALID_PASSWORD },
    {
      db,
      hashPassword: async (password) => {
        calls.push(password)
        return "valid-hash"
      },
    },
  )

  assert.equal(calls.length, 1)
  assert.equal(user.password, "valid-hash")
  assert.equal(state.users.length, 1)
  assert.ok(state.invite.usedAt instanceof Date)

  await assert.rejects(
    registerInvitedUser(
      { inviteToken: state.invite.token, password: VALID_PASSWORD },
      { db, hashPassword: async () => "second-hash" },
    ),
    (error) => error.errorCode === "INVITE_INVALID_OR_USED",
  )
  assert.equal(state.users.length, 1)
})

test("concurrent replay permits exactly one invitation claim", async () => {
  const invite = {
    id: 1,
    token: "concurrent-token",
    email: "concurrent@example.com",
    name: "Concurrent User",
    role: "operational",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    usedAt: null,
  }
  let claimed = false
  const users = []
  const db = {
    userInvite: { findUnique: async () => ({ ...invite }) },
    user: { findUnique: async () => null },
    $transaction: async (operation) =>
      operation({
        userInvite: {
          updateMany: async () => {
            if (claimed) return { count: 0 }
            claimed = true
            return { count: 1 }
          },
        },
        user: {
          create: async ({ data }) => {
            const user = { id: users.length + 1, ...data }
            users.push(user)
            return user
          },
        },
      }),
  }

  const attempts = await Promise.allSettled([
    registerInvitedUser(
      { inviteToken: invite.token, password: VALID_PASSWORD },
      { db, hashPassword: async () => "hash-one" },
    ),
    registerInvitedUser(
      { inviteToken: invite.token, password: VALID_PASSWORD },
      { db, hashPassword: async () => "hash-two" },
    ),
  ])

  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1)
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1)
  assert.equal(users.length, 1)
})
