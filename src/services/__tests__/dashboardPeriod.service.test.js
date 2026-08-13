import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCourtHourUsageWhere,
  buildCustomRangeOccupancyPeriods,
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

// ─── Calendar-correct daily/monthly granularity ────────────────────────────
// The daily/monthly decision must be based on the ACTUAL calendar-day range
// between startDate and endDate, never on the day-of-month value or a fixed
// "28-day" cutoff. These tests lock that behavior for every month length.

test("daily mode covers the exact calendar range and includes the end date (Feb 1-28)", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-02-01",
    endDate: "2026-02-28",
  })

  assert.equal(periods.length, 28)
  assert.equal(periods[0].label, "Feb 1")
  assert.equal(periods[27].label, "Feb 28")
  assert.equal(periods[27].date, "2026-02-28")
})

test("leap-year February daily mode reaches day 29", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2028-02-01",
    endDate: "2028-02-29",
  })

  assert.equal(periods.length, 29)
  assert.equal(periods[28].label, "Feb 29")
  assert.equal(periods[28].date, "2028-02-29")
})

test("forced daily still emits all 31 days of January including Jan 31", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    forceDaily: true,
  })

  assert.equal(periods.length, 31)
  assert.equal(periods[30].label, "Jan 31")
  assert.equal(periods[30].date, "2026-01-31")
})

test("single-day range is daily with exactly one period", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-04-15",
    endDate: "2026-04-15",
  })

  assert.equal(periods.length, 1)
  assert.equal(periods[0].label, "Apr 15")
  assert.equal(periods[0].date, "2026-04-15")
})

test("29-day range stays daily regardless of the ending day-of-month", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-01-01",
    endDate: "2026-01-29",
  })

  assert.equal(periods.length, 29)
  assert.equal(periods[28].date, "2026-01-29")
})

test("30-day range switches to monthly exactly at the calendar-day threshold", () => {
  const daily = buildCustomRangeOccupancyPeriods({
    startDate: "2026-01-01",
    endDate: "2026-01-29",
  })
  const monthly = buildCustomRangeOccupancyPeriods({
    startDate: "2026-01-01",
    endDate: "2026-01-30",
  })

  assert.equal(daily.length, 29)
  assert.equal(monthly.length, 1)
  assert.equal(monthly[0].month, "Jan")
})

test("30-day month (April) becomes monthly and keeps the whole month", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-04-01",
    endDate: "2026-04-30",
  })
  const expected = resolveCustomDateRange({ startDate: "2026-04-01", endDate: "2026-04-30" })

  assert.equal(periods.length, 1)
  assert.equal(periods[0].month, "Apr")
  assert.equal(periods[0].startDate.toISOString(), expected.startDate.toISOString())
  assert.equal(periods[0].endDateExclusive.toISOString(), expected.endDateExclusive.toISOString())
})

test("31-day month (January/May) becomes monthly and keeps the whole month", () => {
  for (const [start, end, month] of [
    ["2026-01-01", "2026-01-31", "Jan"],
    ["2026-05-01", "2026-05-31", "May"],
  ]) {
    const periods = buildCustomRangeOccupancyPeriods({ startDate: start, endDate: end })
    const expected = resolveCustomDateRange({ startDate: start, endDate: end })

    assert.equal(periods.length, 1)
    assert.equal(periods[0].month, month)
    assert.equal(periods[0].endDateExclusive.toISOString(), expected.endDateExclusive.toISOString())
  }
})

test("cross-month range is measured by calendar days, not day-of-month values", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-02-20",
    endDate: "2026-03-10",
  })

  assert.equal(periods.length, 19)
  assert.equal(periods[0].label, "Feb 20")
  assert.equal(periods[18].label, "Mar 10")
  assert.equal(periods[18].date, "2026-03-10")
})

test("monthly buckets split a cross-month range by actual months", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-01-15",
    endDate: "2026-02-14",
  })

  assert.equal(periods.length, 2)
  assert.equal(periods[0].month, "Jan")
  assert.equal(periods[1].month, "Feb")
})

test("cross-year range is measured across the year boundary", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-12-15",
    endDate: "2027-01-15",
  })

  assert.equal(periods.length, 2)
  assert.equal(periods[0].month, "Dec")
  assert.equal(periods[1].month, "Jan")
})

test("non-leap February 29 is rejected as an invalid calendar date", () => {
  const periods = buildCustomRangeOccupancyPeriods({
    startDate: "2026-02-29",
    endDate: "2026-02-29",
  })

  assert.deepEqual(periods, [])
})
