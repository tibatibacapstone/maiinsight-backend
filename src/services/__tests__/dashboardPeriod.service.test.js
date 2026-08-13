import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCourtHourUsageWhere,
  buildDashboardTransactionGroupCondition,
  buildFacilityTransactionWhere,
  getMonthIndex,
  normalizeBookingTypeFilter,
  resolveCustomDateRange,
  resolveSelectedDateRange,
} from "../dashboardPeriod.service.js"

const customerStatusCondition = {
  status: { in: ["Payment Completed", "Manual/Walk-in"] },
  customerKey: { startsWith: "CUST-" },
  netRevenue: { gt: 0 },
}

const operationalStatusCondition = {
  status: { in: ["Internal", "Tutup/Maintenance"] },
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
    { ...customerStatusCondition, bookingType: "Manual/Walk-in" }
  )
  assert.deepEqual(
    buildDashboardTransactionGroupCondition({ customerType: "non_membership" }),
    { ...customerStatusCondition, bookingType: "GeloraApp Booking" }
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

test("MTD uses Bangkok start inclusive and next-day exclusive boundaries", () => {
  const range = resolveSelectedDateRange({
    selectedYear: 2026,
    selectedMonth: 7,
    periodType: "MTD",
    today: new Date("2026-07-29T05:00:00.000Z"),
  })

  assert.equal(range.startDate.toISOString(), "2026-06-30T17:00:00.000Z")
  assert.equal(range.endDateExclusive.toISOString(), "2026-07-29T17:00:00.000Z")
})

test("historical MTD covers the complete selected calendar month", () => {
  const range = resolveSelectedDateRange({
    selectedYear: 2024,
    selectedMonth: 2,
    periodType: "MTD",
    today: new Date("2026-07-29T05:00:00.000Z"),
  })

  assert.equal(range.startDate.toISOString(), "2024-01-31T17:00:00.000Z")
  assert.equal(range.endDateExclusive.toISOString(), "2024-02-29T17:00:00.000Z")
})

test("YTD starts January 1 and ends after the selected month", () => {
  const range = resolveSelectedDateRange({
    selectedYear: 2025,
    selectedMonth: 5,
    periodType: "YTD",
    today: new Date("2026-07-29T05:00:00.000Z"),
  })

  assert.equal(range.startDate.toISOString(), "2024-12-31T17:00:00.000Z")
  assert.equal(range.endDateExclusive.toISOString(), "2025-05-31T17:00:00.000Z")
})

test("custom ranges validate date-only input and make end exclusive", () => {
  const range = resolveCustomDateRange({
    startDate: "2026-07-01",
    endDate: "2026-07-31",
  })

  assert.equal(range.startDate.toISOString(), "2026-06-30T17:00:00.000Z")
  assert.equal(range.endDateExclusive.toISOString(), "2026-07-31T17:00:00.000Z")
})

test("canonical numeric and compatibility label months resolve identically", () => {
  assert.equal(getMonthIndex(9), 8)
  assert.equal(getMonthIndex("9"), 8)
  assert.equal(getMonthIndex("Sept"), 8)
})

test("Prisma date filters use an exclusive end boundary", () => {
  const startDate = new Date("2026-06-30T17:00:00.000Z")
  const endDateExclusive = new Date("2026-07-31T17:00:00.000Z")
  const where = buildFacilityTransactionWhere({
    startDate,
    endDateExclusive,
  })

  assert.deepEqual(where.playDate, {
    gte: startDate,
    lt: endDateExclusive,
  })
})

test("unknown dashboard filters are rejected", () => {
  assert.throws(
    () => normalizeBookingTypeFilter({ customerType: "vip", bookingType: "all" }),
    (error) =>
      error.statusCode === 400 &&
      error.message === "Unknown customer type filter."
  )
})
