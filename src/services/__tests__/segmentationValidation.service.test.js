import test from "node:test"
import assert from "node:assert/strict"

import {
  validateSegmentationCustomerInput,
  validateSegmentationLookupInput,
  validateSegmentationRunInput,
} from "../segmentationValidation.service.js"

test("validateSegmentationRunInput normalizes valid input", () => {
  const input = validateSegmentationRunInput({
    month: "Sep",
    year: "2026",
    periodType: "ytd",
    bookingType: "GeloraApp Booking",
    k: "4",
    minK: "2",
    maxK: "6",
    autoK: "false",
    analysisMode: "true",
  })

  assert.deepEqual(input, {
    month: "Sept",
    year: 2026,
    periodType: "YTD",
    venue: undefined,
    courtType: undefined,
    customerType: undefined,
    bookingType: "GeloraApp Booking",
    k: 4,
    minK: 2,
    maxK: 6,
    autoK: false,
    analysisMode: true,
  })
})

test("validateSegmentationLookupInput rejects invalid month", () => {
  assert.throws(
    () => validateSegmentationLookupInput({ month: "January" }),
    /month must be All Month or a valid month label/
  )
})

test("validateSegmentationLookupInput accepts canonical numeric month", () => {
  const input = validateSegmentationLookupInput({
    month: "9",
    year: "2026",
    periodType: "mtd",
  })

  assert.equal(input.month, "Sept")
  assert.equal(input.year, 2026)
  assert.equal(input.periodType, "MTD")
})

test("validateSegmentationCustomerInput applies safe pagination defaults", () => {
  const input = validateSegmentationCustomerInput({
    includeCustomers: "true",
    limit: "25",
    offset: "10",
    segmentName: "Prime Players",
  })

  assert.equal(input.includeCustomers, true)
  assert.equal(input.limit, 25)
  assert.equal(input.offset, 10)
  assert.equal(input.segmentName, "Prime Players")
})

test("validateSegmentationCustomerInput rejects oversized page size", () => {
  assert.throws(
    () => validateSegmentationCustomerInput({ limit: "501" }),
    /limit must be less than or equal to 500/
  )
})

