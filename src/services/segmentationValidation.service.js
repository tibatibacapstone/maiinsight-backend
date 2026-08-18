import { badRequest } from "../utils/http-error.js"

const MAX_PAGE_SIZE = 500
const DEFAULT_PAGE_SIZE = 100
const ALLOWED_PERIOD_TYPES = new Set(["MTD", "YTD"])
const BOOKING_TYPE_TOKENS = new Map([
  ["geloraapp booking", "GeloraApp Booking"],
  ["gelora app booking", "GeloraApp Booking"],
  ["geloraappbooking", "GeloraApp Booking"],
  ["manual/walk-in", "Manual/Walk-in"],
  ["manual walk-in", "Manual/Walk-in"],
  ["manual walkin", "Manual/Walk-in"],
  ["manual", "Manual/Walk-in"],
  ["internal", "Internal"],
  ["tutup/maintenance", "Tutup/Maintenance"],
  ["tutup maintenance", "Tutup/Maintenance"],
  ["tutup", "Tutup/Maintenance"],
  ["maintenance", "Tutup/Maintenance"],
  ["closed/maintenance", "Tutup/Maintenance"],
  ["blocked", "Tutup/Maintenance"],
])

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const normalizeBoolean = (value, fallback = false) => {
  if (!hasValue(value)) return fallback
  if (typeof value === "boolean") return value

  const normalized = String(value).trim().toLowerCase()

  if (["true", "1", "yes", "y"].includes(normalized)) return true
  if (["false", "0", "no", "n"].includes(normalized)) return false

  throw badRequest(`Invalid boolean value: ${value}`)
}

const normalizePositiveInteger = (value, fieldName, { minimum = 1, maximum = null } = {}) => {
  if (!hasValue(value)) return null

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw badRequest(`${fieldName} must be an integer greater than or equal to ${minimum}.`)
  }

  if (maximum !== null && parsed > maximum) {
    throw badRequest(`${fieldName} must be less than or equal to ${maximum}.`)
  }

  return parsed
}

const normalizeNonNegativeInteger = (value, fieldName) => {
  if (!hasValue(value)) return 0

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`${fieldName} must be a non-negative integer.`)
  }

  return parsed
}

const normalizePeriodType = (value) => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim().toUpperCase()

  if (!ALLOWED_PERIOD_TYPES.has(normalized)) {
    throw badRequest("periodType must be either MTD or YTD.")
  }

  return normalized
}

const normalizeMonth = (value) => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim()
  const numericMonth = Number(normalized)
  const canonicalMonthLabels = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
  ]

  if (Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12) {
    return canonicalMonthLabels[numericMonth - 1]
  }

  if (normalized.toLowerCase() === "all") return "All Month"
  const allowedMonths = new Set([
    "All Month",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ])

  if (!allowedMonths.has(normalized)) {
    throw badRequest(
      "month must be All Month or a valid month label; canonical numeric values from 1 to 12 are also supported."
    )
  }

  return normalized === "Sep" ? "Sept" : normalized
}

const normalizeYear = (value) => {
  if (!hasValue(value)) return null

  const year = normalizePositiveInteger(value, "year", { minimum: 2000, maximum: 2100 })
  return year
}

const normalizeBookingType = (value) => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ")

  if (normalized === "all") return null

  const canonical = BOOKING_TYPE_TOKENS.get(normalized)

  if (!canonical) {
    throw badRequest(
      "bookingType must be GeloraApp Booking, Manual/Walk-in, Internal, Tutup/Maintenance, or omitted."
    )
  }

  return canonical
}

const normalizeSegmentName = (value) => {
  if (!hasValue(value)) return null

  const normalized = String(value).trim()

  if (normalized.length > 100) {
    throw badRequest("segmentName must be 100 characters or fewer.")
  }

  return normalized
}

const normalizeRunId = (value) => {
  if (!hasValue(value)) return null
  return normalizePositiveInteger(value, "runId")
}

export const validateSegmentationRunInput = (input = {}) => {
  const minK = normalizePositiveInteger(input.minK, "minK", { minimum: 2, maximum: 12 }) ?? 2
  const maxK = normalizePositiveInteger(input.maxK, "maxK", { minimum: minK, maximum: 12 }) ?? 8
  const manualK = normalizePositiveInteger(input.k, "k", { minimum: 2, maximum: 12 })
  const year = normalizeYear(input.year)
  const month = normalizeMonth(input.month)

  return {
    month,
    year,
    periodType: normalizePeriodType(input.periodType) ?? "MTD",
    venue: hasValue(input.venue) ? String(input.venue).trim() : undefined,
    courtType: hasValue(input.courtType) ? String(input.courtType).trim() : undefined,
    customerType: hasValue(input.customerType) ? String(input.customerType).trim() : undefined,
    bookingType: normalizeBookingType(input.bookingType),
    k: manualK,
    minK,
    maxK,
    autoK: normalizeBoolean(input.autoK, false),
    analysisMode: normalizeBoolean(input.analysisMode ?? input.analystMode, false),
  }
}

export const validateSegmentationLookupInput = (input = {}) => ({
  runId: normalizeRunId(input.runId),
  month: normalizeMonth(input.month),
  year: normalizeYear(input.year),
  periodType: normalizePeriodType(input.periodType),
  venue: hasValue(input.venue) ? String(input.venue).trim() : undefined,
  courtType: hasValue(input.courtType) ? String(input.courtType).trim() : undefined,
  customerType: hasValue(input.customerType) ? String(input.customerType).trim() : undefined,
  bookingType: normalizeBookingType(input.bookingType),
  includeCustomers: normalizeBoolean(input.includeCustomers, false),
})

export const validateSegmentationCustomerInput = (input = {}) => ({
  ...validateSegmentationLookupInput(input),
  segmentName: normalizeSegmentName(input.segmentName),
  limit:
    normalizePositiveInteger(input.limit, "limit", {
      minimum: 1,
      maximum: MAX_PAGE_SIZE,
    }) ?? DEFAULT_PAGE_SIZE,
  offset: normalizeNonNegativeInteger(input.offset, "offset"),
  search: hasValue(input.search) ? String(input.search).trim().slice(0, 120) : null,
})

export const PAGINATION_DEFAULTS = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxPageSize: MAX_PAGE_SIZE,
}
