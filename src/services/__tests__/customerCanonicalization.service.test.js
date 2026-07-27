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
  let nextId = 1

  return {
    customers,
    customer: {
      upsert: async ({ where, create, update }) => {
        const existing = customers.get(where.customerIdentity)
        if (existing) {
          Object.assign(existing, update)
          return { ...existing }
        }

        const customer = { id: nextId++, ...create }
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

test("operational rows keep SYS keys and do not create Customer records", async () => {
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

  assert.equal(database.customers.size, 0)
  assert.equal(result.customers.length, 0)
  assert.equal(result.transactions[0].customerId, null)
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
