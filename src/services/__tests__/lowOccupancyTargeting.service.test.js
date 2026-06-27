import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSuggestedAction,
  buildTargetPriorityLabel,
  buildTargetPriorityScore,
  buildWhatsappMessage,
  getSessionDefinitionByName,
  resolveSessionNameByHour,
} from "../lowOccupancyTargeting.service.js"

test("resolveSessionNameByHour maps hours into business sessions", () => {
  assert.equal(resolveSessionNameByHour(6), "Morning")
  assert.equal(resolveSessionNameByHour(12), "Afternoon")
  assert.equal(resolveSessionNameByHour(17), "Evening")
  assert.equal(resolveSessionNameByHour(21), "Night")
  assert.equal(resolveSessionNameByHour(2), null)
})

test("getSessionDefinitionByName returns the configured session window", () => {
  assert.deepEqual(getSessionDefinitionByName("Morning"), {
    name: "Morning",
    startHour: 6,
    endHour: 11,
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
