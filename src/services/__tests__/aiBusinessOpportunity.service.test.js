import test from "node:test"
import assert from "node:assert/strict"

import {
  buildBusinessOpportunitySummary,
  buildFutureSlotOpportunity,
  buildOccupancyOpportunity,
  buildOccupancyHistory,
  buildRevenueHistory,
  buildRevenueOpportunity,
  calculateCourtHourMetrics,
  calculatePromotionUsage,
  calculateRevenueOpportunity,
  classifyOccupancyOpportunity,
  resolveAiOpportunityDateRange,
  resolveAnalysisPeriodRange,
} from "../aiBusinessOpportunity.service.js"
import { resolveSession, resolveVenue } from "../aiStrategyContext.service.js"

const definitions = [
  { name: "Morning", startHour: 6, endHour: 10 },
  { name: "Afternoon", startHour: 11, endHour: 14 },
  { name: "Evening", startHour: 15, endHour: 18 },
  { name: "Night", startHour: 19, endHour: 23 },
]

const usage = ({
  court = "Court 1",
  courtType = "mini_soccer",
  date = "2026-08-05",
  hour = "08:00",
  status = "Payment Completed",
  validBooking = true,
} = {}) => ({
  court,
  courtType,
  playDate: date,
  hourStart: hour,
  transaction: { status, validBooking },
})

test("revenue opportunity calculates gap, achievement, statuses, and unavailable targets safely", () => {
  assert.deepEqual(
    calculateRevenueOpportunity({ currentRevenue: 750, revenueTarget: 1000 }),
    {
      available: true,
      currentRevenue: 750,
      revenueTarget: 1000,
      revenueGap: 250,
      revenueAchievementPct: 75,
      gapStatus: "below_target",
    }
  )
  assert.equal(
    calculateRevenueOpportunity({ currentRevenue: 1200, revenueTarget: 1000 }).gapStatus,
    "target_exceeded"
  )
  const unavailable = calculateRevenueOpportunity({
    currentRevenue: 750,
    revenueTarget: null,
  })
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.currentRevenue, 750)
  assert.equal(unavailable.revenueGap, null)
  const zero = calculateRevenueOpportunity({ currentRevenue: 0, revenueTarget: 0 })
  assert.equal(zero.available, false)
  assert.equal(zero.revenueAchievementPct, null)
})

test("revenue query reuses dashboard filters and sums only returned valid fixture transactions", async () => {
  const capture = {}
  const range = resolveAiOpportunityDateRange({
    startDate: "2026-08-01",
    endDate: "2026-08-05",
  })
  const result = await buildRevenueOpportunity({
    selected: { customerType: "membership" },
    venue: resolveVenue("mini_soccer"),
    range,
    db: {
      facilityTransaction: {
        findMany: async (query) => {
          capture.query = query
          return [{ netRevenue: 400000 }, { netRevenue: 600000 }]
        },
      },
    },
  })
  assert.equal(result.currentRevenue, 1000000)
  assert.equal(result.available, false)
  assert.equal(capture.query.where.courtType, "mini_soccer")
  assert.equal(capture.query.where.playDate.gte.toISOString(), "2026-07-31T17:00:00.000Z")
  assert.equal(capture.query.where.playDate.lt.toISOString(), "2026-08-05T17:00:00.000Z")
  assert.equal(capture.query.where.validBooking, true)
})

test("court-hour occupancy uses configured inventory, not transaction row count", () => {
  const result = calculateCourtHourMetrics({
    rows: [usage(), usage({ hour: "09:00" })],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    operatingDefinitions: definitions,
    totalDays: 1,
  })
  assert.equal(result.availableCourtHours, 18)
  assert.equal(result.occupiedCourtHours, 2)
  assert.equal(result.occupancyRate, 11.1)
})

test("blocked hours reduce capacity and Internal follows dashboard occupied-use behavior", () => {
  const result = calculateCourtHourMetrics({
    rows: [
      usage({ status: "Internal" }),
      usage({ hour: "09:00", status: "Tutup/Maintenance" }),
    ],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    operatingDefinitions: definitions,
    totalDays: 1,
  })
  assert.equal(result.blockedCourtHours, 1)
  assert.equal(result.availableCourtHours, 17)
  assert.equal(result.occupiedCourtHours, 1)
})

test("occupancy opportunity thresholds classify high, medium, and low", () => {
  assert.equal(classifyOccupancyOpportunity(15), "high")
  assert.equal(classifyOccupancyOpportunity(5), "medium")
  assert.equal(classifyOccupancyOpportunity(4.9), "low")
  assert.equal(classifyOccupancyOpportunity(-5), "low")
})

test("occupancy denominator is unavailable without inventory or operating hours", () => {
  assert.equal(calculateCourtHourMetrics({
    rows: [],
    knownCourts: [],
    operatingDefinitions: definitions,
    totalDays: 1,
  }).available, false)
  assert.equal(calculateCourtHourMetrics({
    rows: [],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    operatingDefinitions: [],
    totalDays: 1,
  }).occupancyRate, null)
})

test("historical occupancy uses the previous equivalent period and selected session", async () => {
  let usageCall = 0
  const db = {
    facilityTransaction: {
      findMany: async () => [{ court: "Court 1", courtType: "mini_soccer" }],
    },
    courtHourUsage: {
      findMany: async () => {
        usageCall += 1
        return usageCall === 1
          ? [usage({ hour: "06:00" })]
          : [usage({ date: "2026-08-04", hour: "06:00" }), usage({ date: "2026-08-04", hour: "07:00" })]
      },
    },
  }
  const result = await buildOccupancyOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("morning"),
    range: resolveAiOpportunityDateRange({ campaignDate: "2026-08-05" }),
    db,
  })
  assert.equal(result.available, true)
  assert.equal(result.currentOccupancyRate, 20)
  assert.equal(result.historicalAverageOccupancyRate, 40)
  assert.equal(result.occupancyGapPercentagePoints, 20)
  assert.equal(result.opportunityLevel, "high")
  assert.match(result.historicalBaseline, /Previous equivalent period/)
  assert.match(result.historicalBaseline, /2026-08-04/)
})

test("future slot opportunity derives remaining hours from inventory, bookings, and blocks", async () => {
  const db = {
    facilityTransaction: {
      findMany: async () => [{ court: "Court 1", courtType: "mini_soccer" }],
    },
    courtHourUsage: {
      findMany: async () => [
        usage({ hour: "06:00" }),
        usage({ hour: "07:00", status: "Tutup/Maintenance" }),
      ],
    },
  }
  const result = await buildFutureSlotOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("morning"),
    campaignDate: "2026-08-05",
    db,
  })
  assert.equal(result.totalEligibleCourtHours, 5)
  assert.equal(result.occupiedCourtHours, 1)
  assert.equal(result.blockedCourtHours, 1)
  assert.equal(result.remainingCourtHours, 3)
  assert.equal(result.availabilityStatus, "available")
})

test("future slot opportunity does not assume availability without known inventory", async () => {
  const result = await buildFutureSlotOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("all"),
    campaignDate: "2026-08-05",
    db: {
      facilityTransaction: { findMany: async () => [] },
      courtHourUsage: { findMany: async () => [] },
    },
  })
  assert.equal(result.available, false)
  assert.equal(result.remainingCourtHours, null)
  assert.equal(result.availabilityStatus, "unavailable")
})

test("promotion usage counts booking events, ignores blanks and invalid rows, and finds actual mode", () => {
  const result = calculatePromotionUsage([
    { bookingEventKey: "1", validBooking: true, status: "Payment Completed", promoName: "Comeback" },
    { bookingEventKey: "2", validBooking: true, status: "Manual/Walk-in", promosi: "Comeback" },
    { bookingEventKey: "3", validBooking: true, status: "Payment Completed", promoName: " " },
    { bookingEventKey: "4", validBooking: false, status: "Payment Completed", promoName: "Invalid" },
    { bookingEventKey: "5", validBooking: true, status: "Tutup/Maintenance", promoName: "Blocked" },
  ])
  assert.equal(result.validBookingCount, 3)
  assert.equal(result.promotionUsageCount, 2)
  assert.equal(result.promotionUsagePct, 66.7)
  assert.equal(result.mostUsedPromotion, "Comeback")
  assert.equal("conversionRate" in result, false)
})

const summaryInput = (segmentKey, membershipEligible = false) => ({
  segmentKey,
  segmentHistory: { averageRecencyDays: 30 },
  membershipOpportunity: { eligible: membershipEligible },
  analysisPeriod: { key: "three_months", label: "3 Bulan" },
  revenueHistory: { available: true, totalRevenue: 500000 },
  occupancyHistory: {
    available: true,
    averageOccupancyRate: 10,
    emptyCourtHours: 4,
  },
  offPeakOpportunity: {
    available: true,
    recommendedPrimaryWindow: {
      dayLabel: "Selasa",
      sessionLabel: "Siang",
      occupancyRate: 10,
    },
  },
  promotionUsageContext: {
    available: true,
    promotionUsageCount: 2,
    promotionUsagePct: 20,
  },
})

test("business lifecycle remains segment-led while metrics stay supporting", () => {
  assert.equal(buildBusinessOpportunitySummary(summaryInput("prime")).primaryOpportunity, "customer_retention")
  assert.equal(buildBusinessOpportunitySummary(summaryInput("routine", true)).primaryOpportunity, "customer_value_growth")
  assert.equal(buildBusinessOpportunitySummary(summaryInput("routine", false)).primaryOpportunity, "customer_value_growth")
  assert.equal(buildBusinessOpportunitySummary(summaryInput("growth")).primaryOpportunity, "repeat_booking_growth")
  const reengagement = buildBusinessOpportunitySummary(summaryInput("re_engagement"))
  assert.equal(reengagement.primaryOpportunity, "customer_reactivation")
  assert.deepEqual(reengagement.supportingOpportunities, [
    "historical_empty_hour_utilization",
    "revenue_growth",
    "historical_occupancy_recovery",
    "promotion_usage_opportunity",
  ])
  assert.ok(reengagement.supportingReasons.some((reason) => reason.includes("10%")))
  assert.ok(reengagement.supportingReasons.some((reason) => reason.includes("500.000")))
})

test("analysis periods resolve to one shared Bangkok-local calendar range", () => {
  const now = new Date("2026-07-30T08:30:00.000Z")
  assert.equal(resolveAnalysisPeriodRange({ now }).analysisPeriodKey, "three_months")
  const expectedStarts = {
    one_month: "2026-06-30",
    three_months: "2026-04-30",
    six_months: "2026-01-30",
    twelve_months: "2025-07-30",
  }
  for (const [analysisPeriodKey, expectedStart] of Object.entries(expectedStarts)) {
    const range = resolveAnalysisPeriodRange({ analysisPeriodKey, now })
    assert.equal(range.analysisStartDateLabel, expectedStart)
    assert.equal(range.analysisEndDateLabel, "2026-07-29")
    assert.equal(range.analysisEndExclusive.toISOString(), "2026-07-29T17:00:00.000Z")
    assert.equal(range.timezone, "Asia/Bangkok")
  }
  assert.equal(
    resolveAnalysisPeriodRange({
      analysisPeriodKey: "three_months",
      now: new Date("2024-05-31T10:00:00.000Z"),
    }).analysisStartDateLabel,
    "2024-02-29"
  )
  assert.throws(
    () => resolveAnalysisPeriodRange({ analysisPeriodKey: "two_months", now }),
    (error) => error.errorCode === "INVALID_ANALYSIS_PERIOD"
  )
})

test("revenue and occupancy histories use the exact selected period", async () => {
  const rangeDetails = resolveAnalysisPeriodRange({
    analysisPeriodKey: "three_months",
    now: new Date("2026-07-30T08:30:00.000Z"),
  })
  const range = {
    startDate: rangeDetails.analysisStart,
    endDateExclusive: rangeDetails.analysisEndExclusive,
  }
  const queries = []
  const db = {
    facilityTransaction: {
      findMany: async (query) => {
        queries.push(query)
        if (query.distinct) return [{ court: "Court 1", courtType: "mini_soccer" }]
        return [{ netRevenue: 300000 }, { netRevenue: 600000 }]
      },
    },
    courtHourUsage: {
      findMany: async (query) => {
        queries.push(query)
        return [usage({ date: "2026-05-01", hour: "06:00" })]
      },
    },
  }
  const revenue = await buildRevenueHistory({
    selected: {},
    venue: resolveVenue("mini_soccer"),
    range,
    analysisMonths: 3,
    db,
  })
  assert.equal(revenue.totalRevenue, 900000)
  assert.equal(revenue.averageMonthlyRevenue, 300000)
  assert.equal(revenue.validRevenueTransactionCount, 2)

  const occupancy = await buildOccupancyHistory({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("morning"),
    range,
    analysisPeriodKey: "three_months",
    db,
  })
  assert.equal(occupancy.available, true)
  assert.equal(occupancy.occupiedCourtHours, 1)
  assert.equal(
    occupancy.emptyCourtHours,
    occupancy.availableCourtHours - occupancy.occupiedCourtHours
  )
  const periodQueries = queries.filter((query) => query.where?.playDate)
  assert.ok(periodQueries.length >= 2)
  periodQueries.forEach((query) => {
    assert.equal(query.where.playDate.gte.toISOString(), range.startDate.toISOString())
    assert.equal(query.where.playDate.lt.toISOString(), range.endDateExclusive.toISOString())
  })
})
