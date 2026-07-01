import test from "node:test"
import assert from "node:assert/strict"

import {
  validateLowOccupancySessionInput,
  validateRecommendedCustomersInput,
} from "../lowOccupancyTargetingValidation.service.js"

test("validateLowOccupancySessionInput applies defaults", () => {
  assert.deepEqual(validateLowOccupancySessionInput({}), {
    date: null,
    courtType: "all",
    threshold: 40,
  })
})

test("validateRecommendedCustomersInput normalizes valid query params", () => {
  assert.deepEqual(
    validateRecommendedCustomersInput({
      date: "2026-07-10",
      courtType: "mini_soccer",
      sessionName: "Morning",
      customerType: "non_membership",
      segmentName: "Growth Players",
      minSessionBookingCount: "2",
      limit: "25",
      offset: "5",
    }),
    {
      date: "2026-07-10",
      courtType: "mini_soccer",
      sessionName: "Morning",
      customerType: "non_membership",
      segmentName: "Growth Players",
      minSessionBookingCount: 2,
      limit: 25,
      offset: 5,
    }
  )
})

test("validateRecommendedCustomersInput rejects invalid sessionName", () => {
  assert.throws(
    () =>
      validateRecommendedCustomersInput({
        sessionName: "Late Night",
      }),
    /sessionName must be one of Morning, Afternoon, Evening, or Night/
  )
})

test("validateLowOccupancySessionInput rejects invalid date format", () => {
  assert.throws(
    () => validateLowOccupancySessionInput({ date: "07-10-2026" }),
    /date must be in YYYY-MM-DD format/
  )
})
