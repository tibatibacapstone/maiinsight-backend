import { badRequest } from "../utils/http-error.js"

const MAX_PAGE_SIZE = 500
const DEFAULT_PAGE_SIZE = 50
const ALLOWED_COURT_TYPES = new Set(["mini_soccer", "basketball", "all"])
const ALLOWED_CUSTOMER_TYPES = new Set(["all", "membership", "non_membership"])
const ALLOWED_SESSION_NAMES = new Set(["Morning", "Afternoon", "Evening", "Night"])
const ALLOWED_SEGMENT_NAMES = new Set([
  "Prime Players",
  "Routine Players",
  "Growth Players",
  "Re-Engagement Players",
])

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const normalizeIsoDate = (value, fieldName = "date") => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw badRequest(`${fieldName} must be in YYYY-MM-DD format.`)
  }

  const parsedDate = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsedDate.getTime())) {
    throw badRequest(`${fieldName} must be a valid calendar date.`)
  }

  return normalized
}

const normalizeCourtType = (value, { required = false } = {}) => {
  if (!hasValue(value)) {
    if (required) throw badRequest("courtType is required.")
    return "all"
  }

  const normalized = String(value).trim().toLowerCase()
  if (!ALLOWED_COURT_TYPES.has(normalized)) {
    throw badRequest("courtType must be mini_soccer, basketball, or all.")
  }

  return normalized
}

const normalizeCustomerType = (value) => {
  if (!hasValue(value)) return "all"

  const normalized = String(value).trim().toLowerCase()
  if (!ALLOWED_CUSTOMER_TYPES.has(normalized)) {
    throw badRequest("customerType must be all, membership, or non_membership.")
  }

  return normalized
}

const normalizeSessionName = (value) => {
  if (!hasValue(value)) {
    throw badRequest("sessionName is required.")
  }

  const normalized = String(value).trim()
  if (!ALLOWED_SESSION_NAMES.has(normalized)) {
    throw badRequest("sessionName must be one of Morning, Afternoon, Evening, or Night.")
  }

  return normalized
}

const normalizeSegmentName = (value) => {
  if (!hasValue(value) || String(value).trim().toLowerCase() === "all") return null

  const normalized = String(value).trim()
  if (!ALLOWED_SEGMENT_NAMES.has(normalized)) {
    throw badRequest(
      "segmentName must be Prime Players, Routine Players, Growth Players, Re-Engagement Players, or omitted."
    )
  }

  return normalized
}

const normalizeNumber = (value, fieldName, { minimum = 0, maximum = null, fallback = null } = {}) => {
  if (!hasValue(value)) return fallback

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum) {
    throw badRequest(`${fieldName} must be an integer greater than or equal to ${minimum}.`)
  }

  if (maximum !== null && parsed > maximum) {
    throw badRequest(`${fieldName} must be less than or equal to ${maximum}.`)
  }

  return parsed
}

export const validateLowOccupancySessionInput = (input = {}) => ({
  date: normalizeIsoDate(input.date),
  courtType: normalizeCourtType(input.courtType),
  threshold: normalizeNumber(input.threshold, "threshold", {
    minimum: 0,
    maximum: 100,
    fallback: 40,
  }),
})

export const validateRecommendedCustomersInput = (input = {}) => ({
  date: normalizeIsoDate(input.date),
  courtType: normalizeCourtType(input.courtType),
  sessionName: normalizeSessionName(input.sessionName),
  customerType: normalizeCustomerType(input.customerType),
  segmentName: normalizeSegmentName(input.segmentName),
  minSessionBookingCount: normalizeNumber(input.minSessionBookingCount, "minSessionBookingCount", {
    minimum: 1,
    fallback: 1,
  }),
  limit: normalizeNumber(input.limit, "limit", {
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  }),
  offset: normalizeNumber(input.offset, "offset", {
    minimum: 0,
    fallback: 0,
  }),
})

export const LOW_OCCUPANCY_TARGETING_DEFAULTS = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxPageSize: MAX_PAGE_SIZE,
}
