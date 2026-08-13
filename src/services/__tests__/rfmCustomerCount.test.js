import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateCustomerMetrics,
  countEligibleCanonicalCustomers,
} from "../rfmSegmentation.service.js"

const eligibleTransaction = (customerKey, index = 0) => ({
  customerKey,
  customerName: customerKey,
  bookingType: "GeloraApp Booking",
  status: "Payment Completed",
  playDate: new Date(2026, 6, 1 + index),
  bookingEventKey: `${customerKey}-EVENT-${index}`,
  netRevenue: 100000,
})

test("RFM aggregation counts one canonical customer regardless of transaction count", () => {
  const transactions = [
    ...Array.from({ length: 5 }, (_, index) => eligibleTransaction("CUST-A", index)),
    ...Array.from({ length: 3 }, (_, index) => eligibleTransaction("CUST-B", index)),
    eligibleTransaction("CUST-C"),
  ]

  assert.equal(aggregateCustomerMetrics(transactions, new Date(2026, 7, 1)).length, 3)
})

test("RFM aggregation excludes missing and non-canonical customer keys", () => {
  const transactions = [
    eligibleTransaction("CUST-VALID"),
    eligibleTransaction(null),
    eligibleTransaction(""),
    eligibleTransaction("SYS-INTERNAL"),
    eligibleTransaction("INVALID"),
  ]

  assert.deepEqual(
    aggregateCustomerMetrics(transactions, new Date(2026, 7, 1)).map(({ customerKey }) => customerKey),
    ["CUST-VALID"]
  )
})

test("eligible customer count is a database count over canonical customers with RFM-eligible transactions", async () => {
  let receivedWhere
  const db = {
    customer: {
      count: async ({ where }) => {
        receivedWhere = where
        return 3
      },
    },
  }

  const count = await countEligibleCanonicalCustomers({ db })

  assert.equal(count, 3)
  assert.equal(receivedWhere.customerKey.startsWith, "CUST-")
  const transactionWhere = receivedWhere.facilityTransactions.some
  assert.equal(transactionWhere.playDate.not, null)
  assert.ok(transactionWhere.AND.some(({ validBooking }) => validBooking === true))
  assert.ok(transactionWhere.AND.some(({ netRevenue }) => netRevenue?.gt === 0))
  assert.ok(transactionWhere.AND.some(({ customerKey }) => customerKey?.startsWith === "CUST-"))
})
