import test from "node:test"
import assert from "node:assert/strict"

import { deleteImportBatchData } from "../importBatchDeletion.service.js"

const buildDatabase = () => {
  const state = {
    customers: [
      { id: 1, customerKey: "CUST-00001", customerKeyType: "email", customerType: "membership" },
      { id: 2, customerKey: "CUST-00002", customerKeyType: "email", customerType: "non_membership" },
      { id: 3, customerKey: "SYS-INTERNAL", customerKeyType: "operational", customerType: "internal" },
      { id: 4, customerKey: "CUST-00004", customerKeyType: "email", customerType: "membership" },
    ],
    transactions: [
      { id: 10, batchId: 10, customerId: 1, bookingType: "Manual/Walk-in", validBooking: true },
      { id: 11, batchId: 20, customerId: 1, bookingType: "GeloraApp Booking", validBooking: true },
      { id: 12, batchId: 20, customerId: 2, bookingType: "GeloraApp Booking", validBooking: true },
      { id: 13, batchId: 20, customerId: 3, bookingType: "Internal", validBooking: true },
      { id: 14, batchId: 30, customerId: 4, bookingType: "Manual/Walk-in", validBooking: true },
    ],
    courtHours: [{ id: 1, batchId: 20 }, { id: 2, batchId: 30 }],
    rawRows: [{ id: 1, batchId: 20 }, { id: 2, batchId: 20 }, { id: 3, batchId: 30 }],
    batches: [{ id: 10 }, { id: 20 }, { id: 30 }],
  }

  const removeByBatch = (collection, batchId) => {
    const before = collection.length
    const remaining = collection.filter((item) => item.batchId !== batchId)
    collection.splice(0, collection.length, ...remaining)
    return { count: before - collection.length }
  }
  const idsFromWhere = (where) => new Set(where?.id?.in || where?.customerId?.in || [])

  const transaction = {
    courtHourUsage: { deleteMany: async ({ where }) => removeByBatch(state.courtHours, where.batchId) },
    rawTransactionTable: { deleteMany: async ({ where }) => removeByBatch(state.rawRows, where.batchId) },
    importBatch: {
      delete: async ({ where }) => {
        const index = state.batches.findIndex((batch) => batch.id === where.id)
        if (index < 0) throw new Error("batch not found")
        return state.batches.splice(index, 1)[0]
      },
    },
    facilityTransaction: {
      findMany: async ({ where }) => [
        ...new Set(
          state.transactions
            .filter((item) => item.batchId === where.batchId && item.customerId !== null)
            .map((item) => item.customerId)
        ),
      ].map((customerId) => ({ customerId })),
      deleteMany: async ({ where }) => removeByBatch(state.transactions, where.batchId),
      groupBy: async ({ by, where }) => {
        const ids = idsFromWhere(where)
        const matching = state.transactions.filter(
          (item) =>
            ids.has(item.customerId) &&
            (where.validBooking === undefined || item.validBooking === where.validBooking) &&
            (!where.bookingType?.in || where.bookingType.in.includes(item.bookingType))
        )
        const groups = new Map()
        for (const item of matching) {
          const key = by.includes("bookingType")
            ? `${item.customerId}|${item.bookingType}`
            : String(item.customerId)
          const current = groups.get(key) || {
            customerId: item.customerId,
            ...(by.includes("bookingType") ? { bookingType: item.bookingType } : {}),
            _count: { _all: 0 },
          }
          current._count._all += 1
          groups.set(key, current)
        }
        return [...groups.values()]
      },
    },
    customer: {
      findMany: async ({ where }) => {
        const ids = idsFromWhere(where)
        return state.customers.filter((customer) => ids.has(customer.id)).map((customer) => ({ ...customer }))
      },
      deleteMany: async ({ where }) => {
        const ids = idsFromWhere(where)
        const before = state.customers.length
        state.customers = state.customers.filter((customer) => !ids.has(customer.id))
        return { count: before - state.customers.length }
      },
      update: async ({ where, data }) => {
        const customer = state.customers.find((item) => item.id === where.id)
        Object.assign(customer, data)
        return { ...customer }
      },
    },
  }

  return {
    state,
    transaction,
    $transaction: async (callback) => {
      const snapshot = structuredClone(state)
      try {
        return await callback(transaction)
      } catch (error) {
        Object.assign(state, snapshot)
        throw error
      }
    },
  }
}

test("deleting a batch removes orphan customers and recalculates retained cross-batch customers", async () => {
  const database = buildDatabase()
  const originalKey = database.state.customers[0].customerKey

  const summary = await deleteImportBatchData(database, 20)

  assert.deepEqual(summary, {
    deletedCourtHourCount: 1,
    deletedTransactionCount: 3,
    deletedRawRowCount: 2,
    deletedOrphanCustomerCount: 1,
    retainedCustomerCount: 2,
  })
  assert.equal(database.state.transactions.some((item) => item.batchId === 20), false)
  assert.equal(database.state.courtHours.some((item) => item.batchId === 20), false)
  assert.equal(database.state.rawRows.some((item) => item.batchId === 20), false)
  assert.equal(database.state.batches.some((item) => item.id === 20), false)
  assert.equal(database.state.customers.some((item) => item.id === 2), false)
  assert.equal(database.state.customers.some((item) => item.customerKey === "CUST-00002"), false)

  const retained = database.state.customers.find((item) => item.id === 1)
  assert.equal(retained.customerKey, originalKey)
  assert.equal(retained.membershipTransactionCount, 1)
  assert.equal(retained.nonMembershipTransactionCount, 0)
  assert.equal(retained.internalTransactionCount, 0)
  assert.equal(retained.customerType, "membership")
  assert.ok(retained.customerTypeCalculatedAt instanceof Date)

  const systemCustomer = database.state.customers.find((item) => item.id === 3)
  assert.equal(systemCustomer.customerKey, "SYS-INTERNAL")
  assert.equal(systemCustomer.customerType, "unknown")
  assert.equal(database.state.customers.find((item) => item.id === 4).customerType, "membership")
})

test("batch deletion handles a batch with no inserted customer transactions", async () => {
  const database = buildDatabase()
  database.state.batches.push({ id: 40 })
  database.state.rawRows.push({ id: 40, batchId: 40 })

  const summary = await deleteImportBatchData(database, 40)

  assert.equal(summary.deletedRawRowCount, 1)
  assert.equal(summary.deletedTransactionCount, 0)
  assert.equal(summary.deletedOrphanCustomerCount, 0)
  assert.equal(database.state.customers.length, 4)
})

test("batch deletion rolls back every mutation when customer cleanup fails", async () => {
  const database = buildDatabase()
  const before = structuredClone(database.state)
  database.transaction.customer.deleteMany = async () => {
    throw new Error("simulated cleanup failure")
  }

  await assert.rejects(deleteImportBatchData(database, 20), /simulated cleanup failure/)
  assert.deepEqual(database.state, before)
})
