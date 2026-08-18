import test from "node:test"
import assert from "node:assert/strict"

import { aggregateCustomerMetrics } from "../rfmSegmentation.service.js"

test("one order with three session rows counts three events and sums session revenue", () => {
  const transactions = [8, 10, 12].map((hour, index) => ({
    orderId: "ORD-ONE",
    customerKey: "CUST-00001",
    customerName: "Customer",
    bookingType: "GeloraApp Booking",
    status: "Payment Completed",
    playDate: new Date(2025, 0, 1),
    bookingEventKey: `SES-00001-BB-20250101-${String(hour).padStart(2, "0")}00`,
    netRevenue: [100000, 150000, 200000][index],
  }))

  const [metrics] = aggregateCustomerMetrics(transactions, new Date(2025, 0, 10))

  assert.equal(metrics.frequency, 3)
  assert.equal(metrics.monetary, 450000)
})

test("duplicate event contributes once to both frequency and monetary", () => {
  const transactions = [100000, 50000].map((netRevenue) => ({
    customerKey: "CUST-00001",
    playDate: new Date(2025, 0, 1),
    bookingEventKey: "SES-00001-BB-20250101-0800",
    status: "Payment Completed",
    netRevenue,
  }))

  const [metrics] = aggregateCustomerMetrics(transactions, new Date(2025, 0, 2))

  assert.equal(metrics.frequency, 1)
  assert.equal(metrics.monetary, 100000)
})

test("operational and non-positive customer rows never enter RFM", () => {
  const transactions = [
    {
      customerKey: "SYS-INTERNAL",
      status: "Internal",
      playDate: new Date(2025, 0, 1),
      bookingEventKey: "SES-INTERNAL-BB-20250101-0800",
      netRevenue: 100000,
    },
    {
      customerKey: "CUST-00001",
      status: "Payment Completed",
      playDate: new Date(2025, 0, 1),
      bookingEventKey: "SES-00001-BB-20250101-0900",
      netRevenue: 0,
    },
  ]

  assert.deepEqual(aggregateCustomerMetrics(transactions, new Date(2025, 0, 2)), [])
})
