import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCustomerTypeSummary,
  classifyCustomerType,
  recalculateCustomerTypes,
} from "../customerType.service.js"

test("classifyCustomerType applies the required priority", () => {
  assert.equal(
    classifyCustomerType({
      membershipTransactionCount: 1,
      nonMembershipTransactionCount: 4,
      internalTransactionCount: 2,
    }),
    "membership"
  )
  assert.equal(
    classifyCustomerType({
      nonMembershipTransactionCount: 4,
      internalTransactionCount: 2,
    }),
    "non_membership"
  )
  assert.equal(
    classifyCustomerType({
      internalTransactionCount: 2,
      isOperationalIdentity: true,
    }),
    "internal"
  )
  assert.equal(
    classifyCustomerType({ internalTransactionCount: 2 }),
    "unknown"
  )
  assert.equal(classifyCustomerType(), "unknown")
})

test("buildCustomerTypeSummary counts recognized historical booking types", () => {
  assert.deepEqual(
    buildCustomerTypeSummary(
      [
        { bookingType: "Manual/Walk-in", _count: { _all: 2 } },
        { bookingType: "GeloraApp Booking", _count: { _all: 3 } },
        { bookingType: "Internal", _count: { _all: 1 } },
        { bookingType: "Tutup/Maintenance", _count: { _all: 99 } },
        { bookingType: null, _count: { _all: 99 } },
      ],
      { isOperationalIdentity: true }
    ),
    {
      membershipTransactionCount: 2,
      nonMembershipTransactionCount: 3,
      internalTransactionCount: 1,
      customerType: "membership",
    }
  )
})

test("recalculateCustomerTypes queries all valid historical linked transactions", async () => {
  const updates = []
  let groupByArguments
  const calculatedAt = new Date("2026-07-30T12:00:00.000Z")
  const database = {
    facilityTransaction: {
      groupBy: async (args) => {
        groupByArguments = args
        return [
          {
            customerId: 1,
            bookingType: "GeloraApp Booking",
            _count: { _all: 3 },
          },
          {
            customerId: 1,
            bookingType: "Manual/Walk-in",
            _count: { _all: 1 },
          },
        ]
      },
    },
    customer: {
      findMany: async () => [
        {
          id: 1,
          customerKey: "CUST-00001",
          customerKeyType: "email",
        },
        {
          id: 2,
          customerKey: "SYS-INTERNAL",
          customerKeyType: "operational",
        },
      ],
      update: async (args) => {
        updates.push(args)
        return { id: args.where.id, ...args.data }
      },
    },
  }

  await recalculateCustomerTypes(database, [1, 2, 1], { calculatedAt })

  assert.deepEqual(groupByArguments.where, {
    customerId: { in: [1, 2] },
    validBooking: true,
    bookingType: {
      in: ["Manual/Walk-in", "GeloraApp Booking", "Internal"],
    },
  })
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[0], {
    where: { id: 1 },
    data: {
      membershipTransactionCount: 1,
      nonMembershipTransactionCount: 3,
      internalTransactionCount: 0,
      customerType: "membership",
      customerTypeCalculatedAt: calculatedAt,
    },
  })
  assert.deepEqual(updates[1], {
    where: { id: 2 },
    data: {
      membershipTransactionCount: 0,
      nonMembershipTransactionCount: 0,
      internalTransactionCount: 0,
      customerType: "unknown",
      customerTypeCalculatedAt: calculatedAt,
    },
  })
})
