import test from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"

import {
  resolveSeedPassword,
  seedUsers,
} from "../seedUsers.service.js"

const STRONG_PASSWORDS = {
  SEED_MARKETING_OPERATIONAL_PASSWORD: "Local-Operational-Seed-92!",
  SEED_MANAGEMENT_PASSWORD: "Local-Management-Seed-84!",
  SEED_IT_SUPPORT_PASSWORD: "Local-Support-Seed-73!",
}

const buildDatabase = (initialUsers = []) => {
  const users = new Map(initialUsers.map((user) => [user.email, { ...user }]))
  const calls = { updates: [], upserts: [] }

  return {
    users,
    calls,
    user: {
      findMany: async ({ where }) =>
        [...users.values()]
          .filter((user) => where.email.in.includes(user.email))
          .map(({ email }) => ({ email })),
      update: async ({ where, data }) => {
        calls.updates.push({ where, data: { ...data } })
        const user = users.get(where.email)
        Object.assign(user, data)
        return { ...user }
      },
      upsert: async ({ where, update, create }) => {
        calls.upserts.push({ where, update: { ...update }, create: { ...create } })
        const existing = users.get(where.email)
        if (existing) {
          Object.assign(existing, update)
          return { ...existing }
        }
        users.set(where.email, { ...create })
        return { ...create }
      },
    },
  }
}

test("missing seeded users receive bcrypt hashes from environment credentials", async () => {
  const database = buildDatabase()

  await seedUsers(database, {
    environment: STRONG_PASSWORDS,
    hashPassword: (password) => bcrypt.hash(password, 4),
  })

  const support = database.users.get("support@maiin.com")
  assert.equal(await bcrypt.compare(STRONG_PASSWORDS.SEED_IT_SUPPORT_PASSWORD, support.password), true)
  assert.notEqual(support.password, STRONG_PASSWORDS.SEED_IT_SUPPORT_PASSWORD)
  assert.equal(database.calls.upserts.every(({ update }) => !("password" in update)), true)
})

test("re-seeding preserves every existing password while normalizing approved metadata", async () => {
  const existingUsers = [
    {
      email: "operational@maiin.com",
      name: "Old Operational Name",
      role: "management",
      password: "preserved-operational-hash",
    },
    {
      email: "management@maiin.com",
      name: "Old Management Name",
      role: "operational",
      password: "preserved-management-hash",
    },
    {
      email: "support@maiin.com",
      name: "Old Support Name",
      role: "operational",
      password: "preserved-support-hash",
    },
  ]
  const database = buildDatabase(existingUsers)

  await seedUsers(database, { environment: {} })

  assert.equal(database.users.get("operational@maiin.com").password, "preserved-operational-hash")
  assert.equal(database.users.get("management@maiin.com").password, "preserved-management-hash")
  assert.equal(database.users.get("support@maiin.com").password, "preserved-support-hash")
  assert.equal(database.users.get("support@maiin.com").role, "it_support")
  assert.equal(database.users.get("support@maiin.com").name, "IT Support")
  assert.equal(database.calls.updates.every(({ data }) => !("password" in data)), true)
})

test("production preflight rejects missing credentials before modifying any user", async () => {
  const database = buildDatabase([
    {
      email: "operational@maiin.com",
      name: "Existing Name",
      role: "operational",
      password: "existing-hash",
    },
  ])

  await assert.rejects(
    seedUsers(database, { environment: { NODE_ENV: "production" } }),
    /SEED_MANAGEMENT_PASSWORD is required/
  )
  assert.equal(database.calls.updates.length, 0)
  assert.equal(database.calls.upserts.length, 0)
})

test("known public defaults and placeholders are rejected in every environment", () => {
  for (const password of ["Password123!", "change-me", "<strong-password>", "placeholder"]) {
    assert.throws(
      () =>
        resolveSeedPassword({
          environment: { SEED_IT_SUPPORT_PASSWORD: password, NODE_ENV: "production" },
          variableName: "SEED_IT_SUPPORT_PASSWORD",
        }),
      /must not use a known default or placeholder password/
    )
  }
})

test("credential resolution and seeding never log plaintext passwords", async () => {
  const originalLog = console.log
  const originalWarn = console.warn
  const messages = []
  console.log = (...values) => messages.push(values.join(" "))
  console.warn = (...values) => messages.push(values.join(" "))
  try {
    await seedUsers(buildDatabase(), {
      environment: STRONG_PASSWORDS,
      hashPassword: (password) => bcrypt.hash(password, 4),
    })
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }

  for (const password of Object.values(STRONG_PASSWORDS)) {
    assert.equal(messages.join("\n").includes(password), false)
  }
})
