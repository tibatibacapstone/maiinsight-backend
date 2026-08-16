import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateSelectedSegmentHistory,
  buildMembershipOpportunity,
  buildSocialMediaPerformanceContext,
  buildVenueOpportunity,
  resolveSession,
  resolveVenue,
  serializeAnalysisPeriod,
  serializeStrategyContextForClient,
  validateWorkspaceObjectiveCombination,
} from "../aiStrategyContext.service.js"
import { resolveAnalysisPeriodRange } from "../aiBusinessOpportunity.service.js"
import {
  CUSTOMER_SEGMENTS,
  SEGMENT_STRATEGY_GUIDANCE,
} from "../../constants/aiStrategy.constants.js"

test("selected segment history uses Customer.customerType and excludes internal or invalid rows", () => {
  const result = aggregateSelectedSegmentHistory({
    segment: CUSTOMER_SEGMENTS.RE_ENGAGEMENT,
    scores: [
      { customerKey: "selected-member", recency: 90, frequency: 2, monetary: 800000 },
      { customerKey: "selected-non-member", recency: 100, frequency: 3, monetary: 1000000 },
    ],
    customers: [
      { customerKey: "selected-member", customerType: "membership" },
      { customerKey: "selected-non-member", customerType: "non_membership" },
      { customerKey: "internal", customerType: "internal" },
    ],
    transactions: [
      {
        customerKey: "selected-member", validBooking: true, status: "Payment Completed",
        bookingEventKey: "booking-1", courtType: "mini_soccer", playTimeGroup: "Night",
        playDate: new Date("2026-04-18"), netRevenue: 400000, promoName: "Comeback",
        voucherDiscount: 10000,
      },
      {
        customerKey: "selected-non-member", validBooking: true, status: "Manual/Walk-in",
        bookingEventKey: "booking-2", courtType: "mini_soccer", playTimeGroup: "Night",
        playDate: new Date("2026-04-10"), netRevenue: 500000, promoName: null,
        voucherDiscount: 0,
      },
      {
        customerKey: "internal", validBooking: true, status: "Internal",
        bookingEventKey: "blocked", courtType: "basketball", playTimeGroup: "Morning",
        netRevenue: 0,
      },
      {
        customerKey: "selected-member", validBooking: false, status: "Payment Completed",
        bookingEventKey: "invalid", courtType: "basketball", playTimeGroup: "Morning",
        netRevenue: 900000,
      },
    ],
  })

  assert.equal(result.segmentKey, "re_engagement")
  assert.equal(result.customerCount, 2)
  assert.equal(result.membershipCount, 1)
  assert.equal(result.nonMembershipCount, 1)
  assert.equal(result.preferredVenueKey, "mini_soccer")
  assert.equal(result.preferredSessionKey, "night")
  assert.equal(result.averageBookingValue, 450000)
  assert.equal(result.historicalPromotionUsageRate, 50)
})

test("membership opportunity follows configurable Routine-only rules", () => {
  assert.equal(buildMembershipOpportunity({
    segmentKey: "routine", membershipCount: 20, nonMembershipCount: 80,
    membershipSharePct: 20, nonMembershipSharePct: 80, averageFrequency: 3.8,
  }).eligible, true)
  assert.equal(buildMembershipOpportunity({
    segmentKey: "routine", membershipCount: 70, nonMembershipCount: 30,
    membershipSharePct: 70, nonMembershipSharePct: 30, averageFrequency: 3.8,
  }).eligible, false)
  assert.equal(buildMembershipOpportunity({
    segmentKey: "re_engagement", membershipCount: 20, nonMembershipCount: 80,
    membershipSharePct: 20, nonMembershipSharePct: 80, averageFrequency: 3.8,
  }).eligible, false)
})

test("workspace mode and campaign objective combinations are validated", () => {
  assert.deepEqual(validateWorkspaceObjectiveCombination({
    workspaceModeKey: "low_occupancy_outreach",
    campaignObjectiveKey: "maximize_off_peak_occupancy",
  }), {
    workspaceModeKey: "low_occupancy_outreach",
    campaignObjectiveKey: "maximize_off_peak_occupancy",
  })

  for (const campaignObjectiveKey of [
    "maximize_off_peak_occupancy",
    "drive_revenue_growth",
    "boost_social_media_conversion",
    "increase_customer_retention",
    "customer_reactivation",
    "customer_reactivation_and_retention",
  ]) {
    assert.doesNotThrow(() => validateWorkspaceObjectiveCombination({
      workspaceModeKey: "general_strategy",
      campaignObjectiveKey,
    }))
  }

  assert.throws(() => validateWorkspaceObjectiveCombination({
    workspaceModeKey: "low_occupancy_outreach",
    campaignObjectiveKey: "drive_revenue_growth",
  }), { errorCode: "INVALID_WORKSPACE_OBJECTIVE_COMBINATION" })
  assert.throws(() => validateWorkspaceObjectiveCombination({
    workspaceModeKey: "unknown_mode",
    campaignObjectiveKey: "maximize_off_peak_occupancy",
  }), { errorCode: "INVALID_WORKSPACE_MODE" })
  assert.throws(() => validateWorkspaceObjectiveCombination({
    workspaceModeKey: "general_strategy",
    campaignObjectiveKey: "unknown_objective",
  }), { errorCode: "INVALID_CAMPAIGN_OBJECTIVE" })
})

test("segment guidance expresses distinct lifecycle objectives", () => {
  assert.match(SEGMENT_STRATEGY_GUIDANCE.prime.lifecycleObjective, /retain/i)
  assert.match(SEGMENT_STRATEGY_GUIDANCE.routine.lifecycleObjective, /customer value|revenue per visit/i)
  assert.deepEqual(SEGMENT_STRATEGY_GUIDANCE.routine.preferredTreatments, [
    "Photographer",
    "Premium Ball",
    "Match Highlight Video",
    "Referee Package",
  ])
  assert.match(SEGMENT_STRATEGY_GUIDANCE.routine.avoid.join(" "), /membership conversion/i)
  assert.match(SEGMENT_STRATEGY_GUIDANCE.routine.avoid.join(" "), /recurring booking package/i)
  assert.match(SEGMENT_STRATEGY_GUIDANCE.growth.preferredTreatments.join(" "), /recurring booking package/i)
  assert.deepEqual(
    SEGMENT_STRATEGY_GUIDANCE.routine.campaignObjectiveTreatments.boost_social_media_conversion,
    ["Photographer", "Match Highlight Video"]
  )
  assert.deepEqual(
    SEGMENT_STRATEGY_GUIDANCE.routine.campaignObjectiveTreatments.drive_revenue_growth,
    ["Photographer", "Premium Ball", "Match Highlight Video", "Referee Package"]
  )
  assert.match(
    SEGMENT_STRATEGY_GUIDANCE.routine.campaignObjectiveTreatments.maximize_off_peak_occupancy.join(" "),
    /verified lowest-occupancy day and session/i
  )
  assert.match(SEGMENT_STRATEGY_GUIDANCE.growth.lifecycleObjective, /repeat/i)
  assert.match(SEGMENT_STRATEGY_GUIDANCE.re_engagement.lifecycleObjective, /reactivate/i)
})

const eligibleUsage = (hourStart, court = "Court 1", revenue = 100000) => ({
  court,
  hourStart,
  hourlyRevenue: revenue,
  transaction: { validBooking: true, status: "Payment Completed" },
})

const createOpportunityDb = ({ rows, courts = ["Court 1", "Court 2"], capture }) => ({
  courtHourUsage: {
    findMany: async (query) => {
      if (capture) capture.query = query
      return rows
    },
  },
  facilityTransaction: {
    findMany: async () => courts.map((court) => ({ court })),
  },
})

test("all-sessions occupancy uses all configured session hours and excludes blocked inventory", async () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, index) => eligibleUsage(`${6 + index}:00`)),
    {
      court: "Court 2",
      hourStart: "19:00",
      hourlyRevenue: 0,
      transaction: { validBooking: true, status: "Tutup/Maintenance" },
    },
  ]
  const result = await buildVenueOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("all"),
    campaignDate: "2026-08-05",
    db: createOpportunityDb({ rows }),
  })

  // Four configured sessions cover 18 operating hours. Two courts provide
  // 36 court-hours, less one explicitly blocked maintenance court-hour.
  assert.equal(result.availableCourtHours, 35)
  assert.equal(result.occupiedCourtHours, 7)
  assert.equal(result.currentOccupancyRate, 20)
  assert.equal(result.occupancyAvailabilityReason, null)
})

test("all-sessions occupancy remains unavailable when operating-hour configuration is unavailable", async () => {
  const result = await buildVenueOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("all"),
    campaignDate: "2026-08-05",
    db: createOpportunityDb({ rows: [eligibleUsage("08:00")] }),
    operatingSessionDefinitions: [],
  })

  assert.equal(result.availableCourtHours, null)
  assert.equal(result.currentOccupancyRate, null)
  assert.match(result.occupancyAvailabilityReason, /operating hours are unavailable/i)
})

test("specific-session occupancy preserves the configured session-hour denominator", async () => {
  const result = await buildVenueOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("morning"),
    campaignDate: "2026-08-05",
    db: createOpportunityDb({
      rows: [eligibleUsage("06:00"), eligibleUsage("10:00"), eligibleUsage("11:00")],
    }),
  })

  assert.equal(result.availableCourtHours, 10)
  assert.equal(result.occupiedCourtHours, 2)
  assert.equal(result.currentOccupancyRate, 20)
})

test("campaign date query uses Bangkok-local start and exclusive next-day start", async () => {
  const capture = {}
  await buildVenueOpportunity({
    venue: resolveVenue("mini_soccer"),
    session: resolveSession("night"),
    campaignDate: "2026-08-05",
    db: createOpportunityDb({ rows: [], capture }),
  })

  assert.equal(capture.query.where.playDate.gte.toISOString(), "2026-08-04T17:00:00.000Z")
  assert.equal(capture.query.where.playDate.lt.toISOString(), "2026-08-05T17:00:00.000Z")
  assert.equal("lte" in capture.query.where.playDate, false)
})

test("Bangkok campaign-day boundaries remain correct across leap day", async () => {
  const capture = {}
  await buildVenueOpportunity({
    venue: resolveVenue("basketball"),
    session: resolveSession("all"),
    campaignDate: "2028-02-29",
    db: createOpportunityDb({ rows: [], capture }),
  })

  assert.equal(capture.query.where.playDate.gte.toISOString(), "2028-02-28T17:00:00.000Z")
  assert.equal(capture.query.where.playDate.lt.toISOString(), "2028-02-29T17:00:00.000Z")
})

test("resolved analysis period is echoed with backend-provided labels and dates", () => {
  const resolved = resolveAnalysisPeriodRange({
    analysisPeriodKey: "six_months",
    now: new Date("2026-07-30T08:00:00.000Z"),
  })
  assert.deepEqual(serializeAnalysisPeriod(resolved), {
    key: "six_months",
    label: "6 Bulan",
    lookbackMonths: 6,
    startDate: "2026-01-30",
    endDateExclusive: "2026-07-30",
    displayEndDate: "2026-07-29",
    timezone: "Asia/Bangkok",
  })
})

const igInsight = (metricName, metricValue) => ({
  metricName,
  metricValue,
  insightDate: "2026-04-05T00:00:00Z",
  updatedAt: "2026-04-05T00:00:00Z",
})

const igPost = ({ id, mediaProductType, contentLabel, views, reach, likes = 0, comments = 0 }) => ({
  id,
  igMediaId: id,
  caption: `Caption for ${id}`,
  contentLabel,
  mediaType: null,
  mediaProductType,
  postedAt: "2026-04-10T00:00:00Z",
  rawJson: {},
  insights: [
    igInsight("views", views),
    ...(reach != null ? [igInsight("reach", reach)] : []),
    igInsight("likes", likes),
    igInsight("comments", comments),
  ],
})

test("social media performance is unavailable without a resolved analysis period", async () => {
  const result = await buildSocialMediaPerformanceContext({ analysisPeriod: null })
  assert.equal(result.available, false)
  assert.match(result.reason, /no analysis period/i)
})

test("social media performance is unavailable when nothing was posted in the period", async () => {
  const analysisPeriod = resolveAnalysisPeriodRange({
    analysisPeriodKey: "three_months",
    now: new Date("2026-07-30T00:00:00.000Z"),
  })
  const result = await buildSocialMediaPerformanceContext({
    analysisPeriod,
    db: { instagramMedia: { findMany: async () => [] } },
  })
  assert.equal(result.available, false)
  assert.equal(result.analysisPeriodKey, "three_months")
  assert.match(result.reason, /no instagram content/i)
})

test("social media performance ranks content by engagement rate and groups by type and label", async () => {
  const analysisPeriod = resolveAnalysisPeriodRange({
    analysisPeriodKey: "three_months",
    now: new Date("2026-07-30T00:00:00.000Z"),
  })
  const capture = {}
  const media = [
    igPost({ id: "reel-high", mediaProductType: "REELS", contentLabel: "content_promotion", views: 500, reach: 200, likes: 60, comments: 10 }),
    igPost({ id: "feed-low", mediaProductType: "FEED", contentLabel: "content_advertisement", views: 100, reach: 100, likes: 2, comments: 0 }),
    igPost({ id: "reel-mid", mediaProductType: "REELS", contentLabel: "content_advertisement", views: 300, reach: 150, likes: 15, comments: 5 }),
  ]
  const result = await buildSocialMediaPerformanceContext({
    analysisPeriod,
    db: {
      instagramMedia: {
        findMany: async (query) => {
          capture.query = query
          return media
        },
      },
    },
  })

  assert.equal(capture.query.where.postedAt.gte.getTime(), analysisPeriod.analysisStart.getTime())
  assert.equal(capture.query.where.postedAt.lt.getTime(), analysisPeriod.analysisEndExclusive.getTime())
  assert.equal(result.available, true)
  assert.equal(result.postCount, 3)
  assert.equal(result.rankingMetric, "engagementRate")
  assert.equal(result.topPerformingContent[0].mediaType, "REELS")
  assert.equal(result.topPerformingContent[0].captionExcerpt, "Caption for reel-high")
  assert.equal(result.contentTypeBreakdown[0].key, "REELS")
  assert.equal(result.contentTypeBreakdown[0].postCount, 2)
  assert.deepEqual(
    result.contentLabelBreakdown.map((group) => group.key).sort(),
    ["content_advertisement", "content_promotion"]
  )
  assert.ok(result.lowestPerformingContent.some((item) => item.mediaType === "FEED"))
})

test("social media performance falls back to view rank when no post has reach data", async () => {
  const analysisPeriod = resolveAnalysisPeriodRange({
    analysisPeriodKey: "three_months",
    now: new Date("2026-07-30T00:00:00.000Z"),
  })
  const media = [
    igPost({ id: "no-reach-low", mediaProductType: "FEED", contentLabel: "content_advertisement", views: 50, reach: null }),
    igPost({ id: "no-reach-high", mediaProductType: "FEED", contentLabel: "content_advertisement", views: 900, reach: null }),
  ]
  const result = await buildSocialMediaPerformanceContext({
    analysisPeriod,
    db: { instagramMedia: { findMany: async () => media } },
  })

  assert.equal(result.rankingMetric, "views")
  assert.equal(result.topPerformingContent[0].captionExcerpt, "Caption for no-reach-high")
})

test("client serialization trims server-only context fields", () => {
  const result = serializeStrategyContextForClient({
    selected_scope: { segmentKey: "re_engagement" },
    analysis_period: { key: "three_months" },
    selected_segment_history: { customerCount: 38 },
    membership_opportunity: { eligible: false },
    revenue_history: { available: true },
    revenue_target_context: { available: false },
    occupancy_history: { available: true },
    promotion_usage_context: { available: true },
    off_peak_opportunity: { available: false },
    social_media_performance: { available: false },
    business_opportunity_summary: { primaryOpportunity: "occupancy" },
    data_availability: { rfmAvailable: true },
    offer_constraints: { exactDiscountAllowed: false },
    analytical_reference: { some: "notes" },
    venue_opportunity: { venueKey: "mini_soccer" },
    future_slot_opportunity: { available: true },
    analysisPeriod: { key: "three_months" },
  })
  assert.deepEqual(result, {
    selected_scope: { segmentKey: "re_engagement" },
    analysis_period: { key: "three_months" },
    selected_segment_history: { customerCount: 38 },
    membership_opportunity: { eligible: false },
    revenue_history: { available: true },
    revenue_target_context: { available: false },
    occupancy_history: { available: true },
    promotion_usage_context: { available: true },
    off_peak_opportunity: { available: false },
    social_media_performance: { available: false },
    business_opportunity_summary: { primaryOpportunity: "occupancy" },
  })
  assert.equal(serializeStrategyContextForClient(null), null)
  assert.equal(serializeStrategyContextForClient(undefined), null)
})
