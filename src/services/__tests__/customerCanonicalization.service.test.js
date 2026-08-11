import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCustomerUpsertCandidates,
  resolveCustomersForTransactions,
} from "../customerCanonicalization.service.js"

test("buildCustomerUpsertCandidates keeps the richest candidate per identity", () => {
  const candidates = buildCustomerUpsertCandidates([
    {
      customerIdentity: "EMAIL|test@example.com",
      customerName: "Test User",
      normalizedEmail: "test@example.com",
      customerKeyType: "email",
      customerKeyConfidence: "high",
    },
    {
      customerIdentity: "EMAIL|test@example.com",
      customerName: "Test User",
      normalizedEmail: "test@example.com",
      normalizedPhone: "8123456789",
      customerProfile: "vip",
      customerKeyType: "email",
      customerKeyConfidence: "high",
    },
  ])

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].phone, "8123456789")
  assert.equal(candidates[0].customerProfile, "vip")
})

const buildDatabase = () => {
  const customers = new Map()

  return {
    customers,
    customer: {
      findMany: async () => [...customers.values()].map((customer) => ({ ...customer })),
      upsert: async ({ where, create, update }) => {
        const existing = customers.get(where.customerIdentity)
        if (existing) {
          Object.assign(existing, update)
          return { ...existing }
        }

        const customer = {
          id: Math.max(0, ...[...customers.values()].map((item) => item.id)) + 1,
          ...create,
        }
        customers.set(customer.customerIdentity, customer)
        return { ...customer }
      },
      update: async ({ where, data }) => {
        const customer = [...customers.values()].find((item) => item.id === where.id)
        Object.assign(customer, data)
        return { ...customer }
      },
    },
  }
}

const buildTransaction = (overrides = {}) => ({
  rowNumber: 1,
  customerIdentity: "EMAIL|test@example.com",
  customerName: "Test User",
  normalizedEmail: "test@example.com",
  customerKeyType: "email",
  customerKeyConfidence: "high",
  court: "Basketball",
  courtType: "basketball",
  playDate: new Date(2025, 0, 1),
  startHour: "15:00",
  endHour: "16:00",
  ...overrides,
})

const seedCustomer = (database, overrides = {}) => {
  const id = overrides.id || database.customers.size + 1
  const customer = {
    id,
    customerIdentity: "EMAIL|test@example.com",
    customerKey: `CUST-${String(id).padStart(5, "0")}`,
    name: "Test User",
    email: "test@example.com",
    phone: null,
    customerProfile: null,
    customerKeyType: "email",
    customerKeyConfidence: 1,
    ...overrides,
  }
  database.customers.set(customer.customerIdentity, customer)
  return customer
}

test("same identity in one batch reuses one customer and customer key", async () => {
  const database = buildDatabase()
  const result = await resolveCustomersForTransactions(database, [
    buildTransaction(),
    buildTransaction({ rowNumber: 2, customerName: "Different Name" }),
  ])

  assert.equal(result.customers.length, 1)
  assert.equal(result.transactions[0].customerKey, "CUST-00001")
  assert.equal(result.transactions[1].customerKey, "CUST-00001")
})

test("returning customer reuses its persisted key and a new identity receives the next key", async () => {
  const database = buildDatabase()
  const first = await resolveCustomersForTransactions(database, [buildTransaction()])
  const later = await resolveCustomersForTransactions(database, [
    buildTransaction({ rowNumber: 2 }),
    buildTransaction({
      rowNumber: 3,
      customerIdentity: "NAME|NEW CUSTOMER",
      customerName: "New Customer",
      normalizedEmail: null,
      customerKeyType: "name",
      customerKeyConfidence: "low",
    }),
  ])

  assert.equal(first.transactions[0].customerKey, "CUST-00001")
  assert.equal(later.transactions[0].customerKey, "CUST-00001")
  assert.equal(later.transactions[1].customerKey, "CUST-00002")
})

test("operational rows keep SYS keys and resolve to canonical Customer records", async () => {
  const database = buildDatabase()
  const result = await resolveCustomersForTransactions(database, [
    buildTransaction({
      customerIdentity: "STATUS|INTERNAL",
      customerKey: "SYS-INTERNAL",
      customerKeyType: "operational",
      customerKeyConfidence: "system",
    }),
    buildTransaction({
      rowNumber: 2,
      customerIdentity: "STATUS|INTERNAL",
      customerKey: "SYS-INTERNAL",
      customerKeyType: "operational",
      customerKeyConfidence: "system",
      startHour: "16:00",
      endHour: "17:00",
    }),
    buildTransaction({
      rowNumber: 3,
      customerIdentity: "STATUS|MAINTENANCE",
      customerKey: "SYS-MAINTENANCE",
      customerKeyType: "operational",
      customerKeyConfidence: "system",
    }),
  ])

  assert.equal(database.customers.size, 2)
  assert.equal(result.customers.length, 2)
  assert.equal(result.transactions[0].customerId, 1)
  assert.equal(result.transactions[1].customerId, 1)
  assert.equal(result.transactions[2].customerId, 2)
  assert.equal(result.transactions[0].customerKey, "SYS-INTERNAL")
  assert.equal(result.transactions[2].customerKey, "SYS-MAINTENANCE")
  assert.equal(result.transactions[0].bookingEventKey, "SES-INTERNAL-BB-20250101-1500")
  assert.notEqual(
    result.transactions[0].bookingEventKey,
    result.transactions[1].bookingEventKey
  )
  assert.notEqual(
    result.transactions[0].bookingEventKey,
    result.transactions[2].bookingEventKey
  )
  assert.equal(
    result.transactions[0].bookingRangeKey,
    "RNG-SYS-INTERNAL-BB-20250101-1500-1600"
  )
})

test("email match fills an empty phone and ignores a conflicting later phone and name", async () => {
  const database = buildDatabase()
  seedCustomer(database)

  const filled = await resolveCustomersForTransactions(database, [
    buildTransaction({
      normalizedEmail: " TEST@EXAMPLE.COM ",
      normalizedPhone: "0812-3456-7890",
      customerName: "Different Name",
    }),
  ])
  assert.equal(filled.transactions[0].customerId, 1)
  assert.equal(database.customers.get("EMAIL|test@example.com").phone, "81234567890")
  assert.equal(database.customers.get("EMAIL|test@example.com").name, "Test User")

  await resolveCustomersForTransactions(database, [
    buildTransaction({ normalizedPhone: "0822-2222-2222" }),
  ])
  assert.equal(database.customers.get("EMAIL|test@example.com").phone, "81234567890")
})

test("phone match fills an empty email and preserves a conflicting stored email", async () => {
  const database = buildDatabase()
  seedCustomer(database, {
    customerIdentity: "PHONE|81234567890",
    email: null,
    phone: "81234567890",
    customerKeyType: "phone",
  })

  await resolveCustomersForTransactions(database, [
    buildTransaction({
      customerIdentity: "EMAIL|new@example.com",
      normalizedEmail: "new@example.com",
      normalizedPhone: "0812-3456-7890",
    }),
  ])
  assert.equal(database.customers.get("PHONE|81234567890").email, "new@example.com")

  await resolveCustomersForTransactions(database, [
    buildTransaction({
      customerIdentity: "EMAIL|other@example.com",
      normalizedEmail: "other@example.com",
      normalizedPhone: "081234567890",
    }),
  ])
  assert.equal(database.customers.get("PHONE|81234567890").email, "new@example.com")
  assert.equal(database.customers.size, 1)
})

test("email and phone matching different customers produces a controlled conflict without writes", async () => {
  const database = buildDatabase()
  seedCustomer(database, { id: 1, email: "a@example.com", phone: "8111111111", customerIdentity: "EMAIL|a@example.com" })
  seedCustomer(database, { id: 2, email: "b@example.com", phone: "8222222222", customerIdentity: "EMAIL|b@example.com" })
  const before = structuredClone([...database.customers.values()])

  await assert.rejects(
    resolveCustomersForTransactions(database, [
      buildTransaction({ normalizedEmail: "a@example.com", normalizedPhone: "08222222222" }),
    ]),
    (error) => error.errorCode === "CUSTOMER_IDENTITY_CONFLICT" && error.validationErrors[0].rowNumber === 1
  )
  assert.deepEqual([...database.customers.values()], before)
})

test("name fallback is exact, identifier-free, and refuses ambiguous matches", async () => {
  const database = buildDatabase()
  seedCustomer(database, { id: 1, customerIdentity: "NAME|KAYLA", name: "Kayla", email: null })

  const exact = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerIdentity: "NAME|KAYLA", normalizedEmail: null, normalizedPhone: null, customerName: " kayla " }),
  ])
  assert.equal(exact.transactions[0].customerId, 1)

  const separate = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerIdentity: "EMAIL|second@example.com", normalizedEmail: "second@example.com", normalizedPhone: null, customerName: "Kayla" }),
  ])
  assert.notEqual(separate.transactions[0].customerId, 1)

  const differentPhone = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerIdentity: "PHONE|8333333333", normalizedEmail: null, normalizedPhone: "08333333333", customerName: "Kayla" }),
  ])
  assert.notEqual(differentPhone.transactions[0].customerId, 1)

  const differentName = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerIdentity: "NAME|M SYIRA KAYLA", normalizedEmail: null, normalizedPhone: null, customerName: "M Syira Kayla" }),
  ])
  assert.notEqual(differentName.transactions[0].customerId, 1)

  seedCustomer(database, { id: 3, customerIdentity: "NAME|KAYLA-SECOND", customerKey: "CUST-00003", name: "KAYLA", email: null })
  await assert.rejects(
    resolveCustomersForTransactions(database, [
      buildTransaction({ customerIdentity: "NAME|KAYLA", normalizedEmail: null, normalizedPhone: null, customerName: "Kayla" }),
    ]),
    (error) => error.errorCode === "CUSTOMER_NAME_AMBIGUOUS"
  )
})

test("same-batch candidates fill identifiers and detect cross-customer conflict before persistence", async () => {
  const database = buildDatabase()
  const merged = await resolveCustomersForTransactions(database, [
    buildTransaction({ normalizedPhone: null }),
    buildTransaction({ rowNumber: 2, normalizedPhone: "08123456789" }),
  ])
  assert.equal(merged.customers.length, 1)
  assert.equal(merged.transactions[0].customerId, merged.transactions[1].customerId)
  assert.equal(database.customers.get("EMAIL|test@example.com").phone, "8123456789")

  const conflictDatabase = buildDatabase()
  await assert.rejects(
    resolveCustomersForTransactions(conflictDatabase, [
      buildTransaction({ normalizedEmail: "a@example.com", customerIdentity: "EMAIL|a@example.com", normalizedPhone: "08111111111" }),
      buildTransaction({ rowNumber: 2, normalizedEmail: "b@example.com", customerIdentity: "EMAIL|b@example.com", normalizedPhone: "08222222222" }),
      buildTransaction({ rowNumber: 3, normalizedEmail: "a@example.com", customerIdentity: "EMAIL|a@example.com", normalizedPhone: "08222222222" }),
    ]),
    (error) => error.errorCode === "CUSTOMER_IDENTITY_CONFLICT"
  )
  assert.equal(conflictDatabase.customers.size, 0)
})

test("email match fills transient normalized-name state for later name-only same-batch matching", async () => {
  const database = buildDatabase()
  seedCustomer(database, { name: null })

  const result = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerName: "  Kayla   Putri ", normalizedName: "KAYLA PUTRI" }),
    buildTransaction({
      rowNumber: 2,
      customerIdentity: "NAME|KAYLA PUTRI",
      normalizedEmail: null,
      normalizedPhone: null,
      normalizedName: "KAYLA PUTRI",
      customerName: "Kayla Putri",
    }),
  ])

  assert.equal(result.customers.length, 1)
  assert.equal(result.transactions[0].customerId, 1)
  assert.equal(result.transactions[1].customerId, 1)
  assert.equal(database.customers.size, 1)
  assert.equal(database.customers.get("EMAIL|test@example.com").name, "  Kayla   Putri ")
})

test("name filling preserves strong-identifier precedence and exact-name ambiguity", async () => {
  const database = buildDatabase()
  seedCustomer(database, { name: null })
  seedCustomer(database, {
    id: 2,
    customerIdentity: "NAME|KAYLA",
    customerKey: "CUST-00002",
    name: "Kayla",
    email: null,
  })

  const emailMatched = await resolveCustomersForTransactions(database, [
    buildTransaction({ customerName: "Kayla", normalizedName: "KAYLA" }),
  ])
  assert.equal(emailMatched.transactions[0].customerId, 1)
  assert.equal(database.customers.get("EMAIL|test@example.com").name, "Kayla")

  await assert.rejects(
    resolveCustomersForTransactions(database, [
      buildTransaction({
        customerIdentity: "NAME|KAYLA",
        normalizedEmail: null,
        normalizedPhone: null,
        normalizedName: "KAYLA",
        customerName: "Kayla",
      }),
    ]),
    (error) => error.errorCode === "CUSTOMER_NAME_AMBIGUOUS"
  )
})
