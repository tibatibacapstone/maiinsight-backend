import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSuggestedAction,
  buildCampaignAnalysisRange,
  buildTargetPriorityLabel,
  buildTargetPriorityScore,
  buildWhatsappMessage,
  getSessionDefinitionByName,
  getLatestCampaignPlayDate,
  matchesCampaignPlayContext,
  resolveSessionNameByHour,
} from "../lowOccupancyTargeting.service.js"

test("Campaign Targeting anchors calendar months to the latest valid play date", async () => {
  const queries = []
  const latestPlayDate = await getLatestCampaignPlayDate({
    facilityTransaction: {
      aggregate: async (query) => {
        queries.push(query)
        return { _max: { playDate: new Date(2026, 4, 31) } }
      },
    },
  })
  const range = buildCampaignAnalysisRange(latestPlayDate, 4)

  assert.equal(queries[0]._max.playDate, true)
  assert.equal("transactionDate" in queries[0]._max, false)
  assert.equal(range.analysisStart.getFullYear(), 2026)
  assert.equal(range.analysisStart.getMonth(), 1)
  assert.equal(range.analysisStart.getDate(), 1)
  assert.equal(range.analysisEnd.getFullYear(), 2026)
  assert.equal(range.analysisEnd.getMonth(), 4)
  assert.equal(range.analysisEnd.getDate(), 31)
})

test("Campaign Targeting reports unavailable history instead of falling back without play dates", async () => {
  const latestPlayDate = await getLatestCampaignPlayDate({
    facilityTransaction: {
      aggregate: async () => ({ _max: { playDate: null } }),
    },
  })

  assert.equal(latestPlayDate, null)
  assert.equal(buildCampaignAnalysisRange(latestPlayDate, 4), null)
})

test("campaign month attribution follows play date rather than payment date", () => {
  const transaction = {
    transactionDate: new Date(2026, 3, 20),
    playDate: new Date(2026, 4, 5),
    startHour: "19:00",
    netRevenue: 500000,
  }

  assert.equal(matchesCampaignPlayContext({
    ...transaction,
    campaignDay: "Tuesday",
    sessionName: "Night",
    rangeStart: new Date(2026, 4, 1),
    rangeEnd: new Date(2026, 4, 31, 23, 59, 59, 999),
  }), true)
  assert.equal(matchesCampaignPlayContext({
    ...transaction,
    campaignDay: "Tuesday",
    sessionName: "Night",
    rangeStart: new Date(2026, 3, 1),
    rangeEnd: new Date(2026, 3, 30, 23, 59, 59, 999),
  }), false)
})

test("recommended-customer context uses the weekday and session of playDate", () => {
  assert.equal(matchesCampaignPlayContext({
    transactionDate: new Date(2026, 3, 20),
    playDate: new Date(2026, 4, 4),
    startHour: "20:00",
    campaignDay: "Monday",
    sessionName: "Night",
  }), true)
})

test("resolveSessionNameByHour maps hours into business sessions", () => {
  assert.equal(resolveSessionNameByHour(6), "Morning")
  assert.equal(resolveSessionNameByHour(10), "Morning")
  assert.equal(resolveSessionNameByHour(11), "Afternoon")
  assert.equal(resolveSessionNameByHour(14), "Afternoon")
  assert.equal(resolveSessionNameByHour(15), "Evening")
  assert.equal(resolveSessionNameByHour(18), "Evening")
  assert.equal(resolveSessionNameByHour(19), "Night")
  assert.equal(resolveSessionNameByHour(23), "Night")
  assert.equal(resolveSessionNameByHour(2), null)
})

test("getSessionDefinitionByName returns the configured session window", () => {
  assert.deepEqual(getSessionDefinitionByName("Morning"), {
    name: "Morning",
    startHour: 6,
    endHour: 10,
  })
})

test("buildTargetPriorityScore favors better session match, recency, and contactability", () => {
  const highScore = buildTargetPriorityScore({
    selectedSessionBookingCount: 8,
    selectedCourtBookingCount: 8,
    totalBookingCount: 10,
    recencyDays: 14,
    rfmSegmentName: "Prime Players",
    hasPhone: true,
    hasEmail: true,
    maxSelectedSessionBookingCount: 8,
    maxSelectedCourtBookingCount: 8,
    maxTotalBookingCount: 10,
  })
  const lowScore = buildTargetPriorityScore({
    selectedSessionBookingCount: 1,
    selectedCourtBookingCount: 1,
    totalBookingCount: 3,
    recencyDays: 240,
    rfmSegmentName: "Re-Engagement Players",
    hasPhone: false,
    hasEmail: false,
    maxSelectedSessionBookingCount: 8,
    maxSelectedCourtBookingCount: 8,
    maxTotalBookingCount: 10,
  })

  assert.equal(buildTargetPriorityLabel(highScore), "High Priority")
  assert.equal(buildTargetPriorityLabel(lowScore), "Low Priority")
  assert.ok(highScore > lowScore)
})

test("buildSuggestedAction follows business targeting rules", () => {
  assert.equal(
    buildSuggestedAction({
      customerTypeLabel: "Non Membership",
      rfmSegmentName: "Routine Players",
    }),
    "Offer session promo or repeat booking package."
  )

  assert.equal(
    buildSuggestedAction({
      customerTypeLabel: "Membership",
      rfmSegmentName: "Routine Players",
    }),
    "Offer priority slot reminder or membership package maintenance."
  )
})

test("buildWhatsappMessage switches tone for re-engagement customers", () => {
  const regularMessage = buildWhatsappMessage({
    customerName: "Andi",
    sessionName: "Morning",
    date: "2026-07-10",
    courtType: "mini_soccer",
    rfmSegmentName: "Routine Players",
  })

  const comebackMessage = buildWhatsappMessage({
    customerName: "Budi",
    sessionName: "Night",
    date: "2026-07-10",
    courtType: "basketball",
    rfmSegmentName: "Re-Engagement Players",
  })

  assert.match(regularMessage, /Andi/)
  assert.match(regularMessage, /Morning/)
  assert.match(comebackMessage, /Sudah lama belum main di Maiin/)
  assert.match(comebackMessage, /Night/)
})
