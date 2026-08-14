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
const ALLOWED_CAMPAIGN_DAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
const ALLOWED_ANALYSIS_MONTHS = new Set([1, 2, 3, 4, 6, 12])
const ALLOWED_CUSTOMER_TYPE_LABELS = new Set(["Membership", "Non Membership", "Mixed/Other"])

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
  campaignDay: ALLOWED_CAMPAIGN_DAYS.has(String(input.campaignDay || "Monday"))
    ? String(input.campaignDay || "Monday")
    : (() => { throw badRequest("campaignDay must be a weekday name.") })(),
  analysisPeriodMonths: (() => {
    const months = normalizeNumber(input.analysisPeriodMonths, "analysisPeriodMonths", { minimum: 1, fallback: 3 })
    if (!ALLOWED_ANALYSIS_MONTHS.has(months)) throw badRequest("analysisPeriodMonths must be 1, 2, 3, 4, 6, or 12.")
    return months
  })(),
  courtType: normalizeCourtType(input.courtType),
  sessionName: normalizeSessionName(input.sessionName),
  customerType: normalizeCustomerType(input.customerType),
  segmentName: normalizeSegmentName(input.segmentName),
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

const normalizeRequiredText = (value, fieldName, { maxLength = 200 } = {}) => {
  if (!hasValue(value)) throw badRequest(`${fieldName} is required.`)

  const normalized = String(value).trim()
  if (normalized.length > maxLength) {
    throw badRequest(`${fieldName} must be ${maxLength} characters or fewer.`)
  }

  return normalized
}

export const validateGenerateOutreachMessageInput = (input = {}) => ({
  customerName: normalizeRequiredText(input.customerName, "customerName", { maxLength: 120 }),
  rfmSegmentName: normalizeSegmentName(input.rfmSegmentName),
  customerTypeLabel: (() => {
    if (!hasValue(input.customerTypeLabel)) return "Mixed/Other"

    const normalized = String(input.customerTypeLabel).trim()
    if (!ALLOWED_CUSTOMER_TYPE_LABELS.has(normalized)) {
      throw badRequest("customerTypeLabel must be Membership, Non Membership, or Mixed/Other.")
    }

    return normalized
  })(),
  preferredSession: (() => {
    if (!hasValue(input.preferredSession)) return null

    const normalized = String(input.preferredSession).trim()
    if (!ALLOWED_SESSION_NAMES.has(normalized)) {
      throw badRequest("preferredSession must be Morning, Afternoon, Evening, Night, or omitted.")
    }

    return normalized
  })(),
  courtType: normalizeCourtType(input.courtType),
  suggestedAction: normalizeRequiredText(input.suggestedAction, "suggestedAction", { maxLength: 200 }),
  recencyDays: normalizeNumber(input.recencyDays, "recencyDays", {
    minimum: 0,
    maximum: 99999,
    fallback: 999,
  }),
  totalBookingCount: normalizeNumber(input.totalBookingCount, "totalBookingCount", {
    minimum: 0,
    maximum: 100000,
    fallback: 0,
  }),
})

export const LOW_OCCUPANCY_TARGETING_DEFAULTS = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxPageSize: MAX_PAGE_SIZE,
}
