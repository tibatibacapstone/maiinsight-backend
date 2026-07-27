import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCourtHourUsageWhere,
  buildDashboardTransactionGroupCondition,
  buildFacilityTransactionWhere,
  normalizeBookingTypeFilter,
} from "../dashboardPeriod.service.js"

const customerStatusCondition = {
  status: { in: ["Payment Completed", "Manual/Walk-in"] },
  customerKey: { startsWith: "CUST-" },
  netRevenue: { gt: 0 },
}

const operationalStatusCondition = {
  status: { in: ["Internal", "Tutup", "Maintenance", "Tutup/Maintenance"] },
  customerKey: { startsWith: "SYS-" },
}

test("All dashboard filter includes customer and operational groups", () => {
  assert.deepEqual(
    buildDashboardTransactionGroupCondition({
      customerType: "all",
      includeOperational: true,
    }),
    { OR: [customerStatusCondition, operationalStatusCondition] }
  )
})

test("Membership and Non-Membership require positive CUST customer transactions", () => {
  assert.deepEqual(
    buildDashboardTransactionGroupCondition({ customerType: "membership" }),
    { ...customerStatusCondition, bookingType: "membership" }
  )
  assert.deepEqual(
    buildDashboardTransactionGroupCondition({ customerType: "non_membership" }),
    { ...customerStatusCondition, bookingType: "non_membership" }
  )
})

test("Internal includes every operational status and excludes CUST transactions", () => {
  assert.deepEqual(
    buildDashboardTransactionGroupCondition({ customerType: "internal" }),
    operationalStatusCondition
  )
})

test("Internal revenue is not forced positive or zero", () => {
  const condition = buildDashboardTransactionGroupCondition({ customerType: "internal" })
  assert.equal("netRevenue" in condition, false)
})

test("Court-hour occupancy applies the same group on the related transaction", () => {
  const where = buildCourtHourUsageWhere({
    customerType: "internal",
    includeOperational: true,
  })

  assert.equal(where.transaction.validBooking, true)
  assert.deepEqual(where.transaction.AND, [operationalStatusCondition])
})

test("Facility transaction All includes operational and positive customer revenue", () => {
  const where = buildFacilityTransactionWhere({
    customerType: "all",
    includeOperational: true,
  })

  assert.equal(where.validBooking, true)
  assert.deepEqual(where.AND, [{ OR: [customerStatusCondition, operationalStatusCondition] }])
})

test("unknown dashboard filters are rejected", () => {
  assert.throws(
    () => normalizeBookingTypeFilter({ customerType: "vip", bookingType: "all" }),
    (error) =>
      error.statusCode === 400 &&
      error.message === "Unknown customer type filter."
  )
})
