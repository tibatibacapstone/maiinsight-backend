import bcrypt from "bcryptjs"

export const SEEDED_USERS = [
  {
    email: "operational@maiin.com",
    name: "Marketing Operational User",
    role: "operational",
    passwordEnvironmentVariable: "SEED_MARKETING_OPERATIONAL_PASSWORD",
  },
  {
    email: "management@maiin.com",
    name: "Management User",
    role: "management",
    passwordEnvironmentVariable: "SEED_MANAGEMENT_PASSWORD",
  },
  {
    email: "support@maiin.com",
    name: "IT Support",
    role: "it_support",
    passwordEnvironmentVariable: "SEED_IT_SUPPORT_PASSWORD",
  },
]

const FORBIDDEN_SEED_PASSWORDS = new Set([
  "password123!",
  "changeme",
  "change-me",
  "replace-me",
  "your-password-here",
])

export const resolveSeedPassword = ({ environment, variableName }) => {
  const password = String(environment?.[variableName] || "").trim()
  if (!password) {
    throw new Error(
      `${variableName} is required to create its seeded user. Existing user passwords are preserved.`
    )
  }
  if (
    FORBIDDEN_SEED_PASSWORDS.has(password.toLowerCase()) ||
    /^<.*>$/.test(password) ||
    /^(?:placeholder|default)(?:[-_ ].*)?$/i.test(password)
  ) {
    throw new Error(`${variableName} must not use a known default or placeholder password.`)
  }
  return password
}

export const seedUsers = async (
  database,
  {
    environment = process.env,
    hashPassword = (password) => bcrypt.hash(password, 10),
  } = {}
) => {
  const existingUsers = await database.user.findMany({
    where: { email: { in: SEEDED_USERS.map((user) => user.email) } },
    select: { email: true },
  })
  const existingEmails = new Set(existingUsers.map((user) => user.email))

  // Resolve and hash every required credential before the first user write.
  const passwordHashes = new Map()
  for (const user of SEEDED_USERS) {
    if (existingEmails.has(user.email)) continue
    const password = resolveSeedPassword({
      environment,
      variableName: user.passwordEnvironmentVariable,
    })
    passwordHashes.set(user.email, await hashPassword(password))
  }

  for (const user of SEEDED_USERS) {
    const metadata = {
      name: user.name,
      role: user.role,
    }

    if (existingEmails.has(user.email)) {
      await database.user.update({
        where: { email: user.email },
        data: metadata,
      })
      continue
    }

    await database.user.upsert({
      where: { email: user.email },
      update: metadata,
      create: {
        email: user.email,
        ...metadata,
        password: passwordHashes.get(user.email),
      },
    })
  }
}
