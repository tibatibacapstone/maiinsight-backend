import test from "node:test"
import assert from "node:assert/strict"

import {
  aggregateOffPeakWindows,
  buildOffPeakOpportunity,
  resolveOffPeakAnalysisRange,
} from "../aiBusinessOpportunity.service.js"
import {
  createApplicationDateStart,
  formatIsoDate,
} from "../dashboardPeriod.service.js"

const rules = {
  lookbackMonths: 3,
  resultLimit: 28,
  minimumObservedWeeks: 2,
  minimumAvailableCourtHours: 1,
}

const transaction = (status = "Payment Completed") => ({
  validBooking: true,
  status,
})

const row = ({ date, hour = "06:00", status, court = "Court 1", courtType = "mini_soccer" }) => ({
  playDate: createApplicationDateStart(...date),
  hourStart: hour,
  court,
  courtType,
  transaction: transaction(status),
})

test("off-peak range uses three Bangkok calendar months and an exclusive generation-day end", () => {
  const range = resolveOffPeakAnalysisRange({ analysisDate: "2026-07-30" })
  assert.equal(formatIsoDate(range.startDate), "2026-04-30")
  assert.equal(formatIsoDate(range.endDateExclusive), "2026-07-30")
  assert.equal(range.startDate.toISOString(), "2026-04-29T17:00:00.000Z")
  assert.equal(range.endDateExclusive.toISOString(), "2026-07-29T17:00:00.000Z")
})

test("month-end subtraction clamps safely, including leap years", () => {
  assert.equal(
    formatIsoDate(resolveOffPeakAnalysisRange({ analysisDate: "2026-05-31" }).startDate),
    "2026-02-28"
  )
  assert.equal(
    formatIsoDate(resolveOffPeakAnalysisRange({ analysisDate: "2024-05-31" }).startDate),
    "2024-02-29"
  )
})

test("aggregation uses court-hours, canonical sessions, blocked capacity, and stable ranking", () => {
  const range = {
    startDate: createApplicationDateStart(2026, 6, 7),
    endDateExclusive: createApplicationDateStart(2026, 6, 21),
  }
  const result = aggregateOffPeakWindows({
    rows: [
      row({ date: [2026, 6, 7], status: "Payment Completed" }),
      row({ date: [2026, 6, 8], status: "Internal" }),
      row({ date: [2026, 6, 14], status: "Tutup", hour: "07:00" }),
      row({ date: [2026, 6, 15], status: "Payment Completed" }),
    ],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    range,
    rules,
  })
  assert.equal(result.available, true)
  assert.equal(result.windows[0].dayKey, "sunday")
  assert.equal(result.windows[0].sessionKey, "night")
  assert.equal(result.windows[0].occupancyRate, 0)
  const sundayMorning = result.windows.find(
    (window) => window.dayKey === "sunday" && window.sessionKey === "morning"
  )
  assert.equal(sundayMorning.occupiedCourtHours, 1)
  assert.equal(sundayMorning.availableCourtHours, 9)
  assert.equal(sundayMorning.emptyCourtHours, 8)
  assert.equal(sundayMorning.occupancyRate, 11.1)
  const limited = aggregateOffPeakWindows({
    rows: [
      row({ date: [2026, 6, 7], status: "Payment Completed" }),
      row({ date: [2026, 6, 14], status: "Tutup", hour: "07:00" }),
    ],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    range,
    rules: { ...rules, resultLimit: 3 },
  })
  assert.equal(limited.windows.length, 3)
})

test("coverage and minimum available-hour rules exclude insufficient history", () => {
  const range = {
    startDate: createApplicationDateStart(2026, 6, 7),
    endDateExclusive: createApplicationDateStart(2026, 6, 14),
  }
  const insufficientWeeks = aggregateOffPeakWindows({
    rows: [row({ date: [2026, 6, 7] })],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    range,
    rules,
  })
  assert.equal(insufficientWeeks.available, false)
  assert.match(insufficientWeeks.reason, /observed weeks/)

  const insufficientHours = aggregateOffPeakWindows({
    rows: [
      row({ date: [2026, 6, 7] }),
      row({ date: [2026, 6, 14] }),
    ],
    knownCourts: [{ court: "Court 1", courtType: "mini_soccer" }],
    range: {
      startDate: createApplicationDateStart(2026, 6, 7),
      endDateExclusive: createApplicationDateStart(2026, 6, 21),
    },
    rules: { ...rules, minimumAvailableCourtHours: 1000 },
  })
  assert.equal(insufficientHours.available, false)
})

test("selected venue and exclusive historical period are applied to the trusted query", async () => {
  let usageWhere
  const db = {
    courtHourUsage: {
      findMany: async ({ where }) => {
        usageWhere = where
        return []
      },
    },
    facilityTransaction: { findMany: async () => [] },
  }
  const opportunity = await buildOffPeakOpportunity({
    venue: { key: "mini_soccer", label: "Mini Soccer" },
    session: { key: "all", label: "All Sessions" },
    generationDate: "2026-07-30",
    db,
  })
  assert.equal(usageWhere.courtType, "mini_soccer")
  assert.equal(usageWhere.playDate.gte.toISOString(), "2026-04-29T17:00:00.000Z")
  assert.equal(usageWhere.playDate.lt.toISOString(), "2026-07-29T17:00:00.000Z")
  assert.equal(opportunity.available, false)
  assert.equal(opportunity.recommendedPrimaryWindow, null)
})
