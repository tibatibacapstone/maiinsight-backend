import { badRequest } from "../utils/http-error.js"
import {
  CANONICAL_TRANSACTION_STATUSES,
  DASHBOARD_TRANSACTION_GROUPS,
  normalizeDashboardTransactionGroup,
} from "./transactionStatus.service.js"

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
]

const MONTH_INDEX_MAP = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sept: 8,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

const ALL_MONTH_LABEL = "All Month"
export const APPLICATION_TIME_ZONE = "Asia/Bangkok"
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

// Same label style as the Revenue Trend grouping on the management report
// (operations.routes.js): "May 5" for daily buckets, "May 26" for monthly buckets.
const DAILY_PERIOD_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: APPLICATION_TIME_ZONE,
})

const MONTHLY_PERIOD_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: APPLICATION_TIME_ZONE,
})

export const EXCLUDED_IMPORT_BATCH_FILE_NAMES = ["tmp-upload-sample.csv"]

export const getApplicationCalendarParts = (value) => {
  const shifted = new Date(value.getTime() + BANGKOK_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

export const getApplicationWeekday = (value) =>
  new Date(value.getTime() + BANGKOK_OFFSET_MS).getUTCDay()

export const createApplicationDateStart = (year, month, day) =>
  new Date(Date.UTC(year, month - 1, day) - BANGKOK_OFFSET_MS)

export const parseCalendarDate = (value) => {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw badRequest("Date must use YYYY-MM-DD format.")

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = createApplicationDateStart(year, month, day)
  const parts = getApplicationCalendarParts(parsed)

  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    throw badRequest("Date is not a valid calendar date.")
  }

  return parsed
}

export const resolveCustomDateRange = ({ startDate, endDate }) => {
  const inclusiveStartDate = parseCalendarDate(startDate)
  const inclusiveEndDate = parseCalendarDate(endDate)
  if (inclusiveStartDate > inclusiveEndDate) {
    throw badRequest("Start date must not be after end date.")
  }

  return {
    startDate: inclusiveStartDate,
    endDateExclusive: new Date(inclusiveEndDate.getTime() + 86400000),
  }
}

const isAllMonth = (selectedMonth) =>
  !selectedMonth ||
  selectedMonth === ALL_MONTH_LABEL ||
  String(selectedMonth).trim().toLowerCase() === "all"

export const formatIsoDate = (date) => {
  const parts = getApplicationCalendarParts(date)
  const year = parts.year
  const month = String(parts.month).padStart(2, "0")
  const day = String(parts.day).padStart(2, "0")

  return `${year}-${month}-${day}`
}

export const formatHourLabel = (hourStart) =>
  `${String(hourStart).padStart(2, "0")}:00`

export const getMonthIndex = (selectedMonth) => {
  if (isAllMonth(selectedMonth)) return null

  if (String(selectedMonth).trim().toLowerCase() === "all") return null

  const numericMonth = Number(selectedMonth)
  if (Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12) {
    return numericMonth - 1
  }

  const monthIndex = MONTH_INDEX_MAP[selectedMonth]

  if (monthIndex === undefined) {
    throw new Error("Invalid month.")
  }

  return monthIndex
}

const getSafeMonthEndExclusive = (year, monthIndex, today) => {
  const todayParts = getApplicationCalendarParts(today)

  if (year === todayParts.year && monthIndex === todayParts.month - 1) {
    return createApplicationDateStart(todayParts.year, todayParts.month, todayParts.day + 1)
  }

  return createApplicationDateStart(year, monthIndex + 2, 1)
}

const getLastVisibleMonthIndex = (selectedYear, today) => {
  const todayParts = getApplicationCalendarParts(today)

  if (selectedYear < todayParts.year) return 11
  if (selectedYear === todayParts.year) return todayParts.month - 1

  return -1
}

const getEffectiveSelectedMonthIndex = (selectedYear, requestedMonthIndex, today) => {
  const todayParts = getApplicationCalendarParts(today)

  if (selectedYear < todayParts.year) return requestedMonthIndex
  if (selectedYear === todayParts.year) return Math.min(requestedMonthIndex, todayParts.month - 1)

  return -1
}

export const resolveSelectedDateRange = ({
  selectedYear,
  selectedMonth = ALL_MONTH_LABEL,
  periodType = "MTD",
  today = new Date(),
}) => {
  const year = Number(selectedYear)

  if (!year || Number.isNaN(year)) {
    throw new Error("Invalid year.")
  }

  if (isAllMonth(selectedMonth)) {
    const todayParts = getApplicationCalendarParts(today)
    return {
      startDate: createApplicationDateStart(year, 1, 1),
      endDateExclusive:
        year === todayParts.year
          ? createApplicationDateStart(todayParts.year, todayParts.month, todayParts.day + 1)
          : createApplicationDateStart(year + 1, 1, 1),
      selectedYear: year,
      selectedMonthIndex: year === todayParts.year ? todayParts.month - 1 : 11,
      isAllMonth: true,
      periodType,
    }
  }

  const requestedMonthIndex = getMonthIndex(selectedMonth)
  if (requestedMonthIndex === null) {
    throw new Error("Invalid month.")
  }

  if (periodType === "YTD") {
    return {
      startDate: createApplicationDateStart(year, 1, 1),
      endDateExclusive: getSafeMonthEndExclusive(year, requestedMonthIndex, today),
      selectedYear: year,
      selectedMonthIndex: requestedMonthIndex,
      isAllMonth: false,
      periodType,
    }
  }

  return {
    startDate: createApplicationDateStart(year, requestedMonthIndex + 1, 1),
    endDateExclusive: getSafeMonthEndExclusive(year, requestedMonthIndex, today),
    selectedYear: year,
    selectedMonthIndex: requestedMonthIndex,
    isAllMonth: false,
    periodType,
  }
}

export const getPreviousComparisonRange = ({ startDate, endDateExclusive }) => {
  const totalDays = Math.max(
    1,
    Math.round((endDateExclusive.getTime() - startDate.getTime()) / 86400000)
  )
  const previousEndDateExclusive = new Date(startDate)
  const previousStartDate = new Date(startDate.getTime() - totalDays * 86400000)

  return {
    startDate: previousStartDate,
    endDateExclusive: previousEndDateExclusive,
  }
}

export const normalizeCourtTypeFilter = (value) => {
  const text = String(value ?? "").trim().toLowerCase()

  if (!text || text === "all venue" || text === "all court" || text === "all") {
    return null
  }

  if (text.includes("basket")) return "basketball"
  if (text.includes("soccer") || text.includes("mini")) return "mini_soccer"

  return null
}

export const normalizeBookingTypeFilter = ({
  customerType,
  bookingType,
}) => {
  const rawBookingType = String(bookingType ?? "").trim()
  const explicitGroup = normalizeDashboardTransactionGroup(bookingType)
  if (explicitGroup && explicitGroup !== DASHBOARD_TRANSACTION_GROUPS.ALL) {
    return explicitGroup
  }
  if (rawBookingType && !explicitGroup) {
    throw badRequest("Unknown booking type filter.")
  }

  const rawCustomerType = String(customerType ?? "").trim()
  const selectedGroup = normalizeDashboardTransactionGroup(customerType)
  if (selectedGroup) return selectedGroup
  if (rawCustomerType) {
    throw badRequest("Unknown customer type filter.")
  }

  return null
}

const CUSTOMER_STATUSES = [
  CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
  CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
]

const OPERATIONAL_STATUSES = [
  CANONICAL_TRANSACTION_STATUSES.INTERNAL,
  CANONICAL_TRANSACTION_STATUSES.TUTUP,
  CANONICAL_TRANSACTION_STATUSES.MAINTENANCE,
  CANONICAL_TRANSACTION_STATUSES.TUTUP_MAINTENANCE,
]

export const buildDashboardTransactionGroupCondition = ({
  customerType,
  bookingType,
  includeOperational = false,
}) => {
  const group =
    normalizeBookingTypeFilter({ customerType, bookingType }) ||
    DASHBOARD_TRANSACTION_GROUPS.ALL
  const customerCondition = {
    status: { in: CUSTOMER_STATUSES },
    customerKey: { startsWith: "CUST-" },
    netRevenue: { gt: 0 },
  }
  const operationalCondition = {
    status: { in: OPERATIONAL_STATUSES },
    customerKey: { startsWith: "SYS-" },
  }

  if (group === DASHBOARD_TRANSACTION_GROUPS.MEMBERSHIP) {
    return {
      ...customerCondition,
      bookingType: DASHBOARD_TRANSACTION_GROUPS.MEMBERSHIP,
    }
  }

  if (group === DASHBOARD_TRANSACTION_GROUPS.NON_MEMBERSHIP) {
    return {
      ...customerCondition,
      bookingType: DASHBOARD_TRANSACTION_GROUPS.NON_MEMBERSHIP,
    }
  }

  if (group === DASHBOARD_TRANSACTION_GROUPS.INTERNAL) {
    return operationalCondition
  }

  return includeOperational
    ? { OR: [customerCondition, operationalCondition] }
    : customerCondition
}

export const getCourtCount = (courtType) => (courtType ? 1 : 2)

export const getAvailableCourtHours = (startDate, endDateExclusive, courtCount) => {
  const totalDays = Math.max(
    0,
    Math.round((endDateExclusive.getTime() - startDate.getTime()) / 86400000)
  )

  return totalDays * 18 * courtCount
}

export const buildFacilityTransactionWhere = ({
  startDate,
  endDateExclusive,
  courtType,
  customerType,
  bookingType,
  requireValidBooking = true,
  includeOperational = false,
}) => {
  const where = {
    batch: {
      fileName: {
        notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
      },
    },
  }

  if (startDate || endDateExclusive) {
    where.playDate = {}

    if (startDate) where.playDate.gte = startDate
    if (endDateExclusive) where.playDate.lt = endDateExclusive
  }

  if (requireValidBooking) {
    where.validBooking = true
  }

  where.AND = [
    buildDashboardTransactionGroupCondition({
      customerType,
      bookingType,
      includeOperational,
    }),
  ]

 if (courtType && courtType !== "all") {
  where.courtType = courtType
}

  return where
}

export const buildCourtHourUsageWhere = ({
  startDate,
  endDateExclusive,
  courtType,
  customerType,
  bookingType,
  requireValidBooking = true,
  includeOperational = false,
}) => {
  const where = {
    transaction: {
      batch: {
        fileName: {
          notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
        },
      },
    },
  }

  if (startDate || endDateExclusive) {
    where.playDate = {}

    if (startDate) where.playDate.gte = startDate
    if (endDateExclusive) where.playDate.lt = endDateExclusive
  }

  if (courtType && courtType !== "all") {
  where.courtType = courtType
}

  if (requireValidBooking) {
    where.transaction.validBooking = true
  }

  where.transaction.AND = [
    buildDashboardTransactionGroupCondition({
      customerType,
      bookingType,
      includeOperational,
    }),
  ]

  return where
}
export const buildCustomRangeOccupancyPeriods = ({ startDate, endDate, forceDaily = false }) => {
  let selectedRange
  try {
    selectedRange = resolveCustomDateRange({ startDate, endDate })
  } catch {
    return []
  }
  const safeStartDate = selectedRange.startDate
  const safeEndDateExclusive = selectedRange.endDateExclusive

  const totalDays = Math.round(
    (safeEndDateExclusive.getTime() - safeStartDate.getTime()) / 86400000
  )

  // Daily buckets for short ranges (< 30 days), otherwise monthly buckets —
  // same boundary as the Revenue Trend grouping on the management report.
  // When `forceDaily` is true, always emit one bucket per day in the range.
  if (forceDaily || totalDays < 30) {
    const days = []
    const cursor = new Date(safeStartDate)

    while (cursor < safeEndDateExclusive) {
      const dayStart = new Date(cursor)
      const dayEndExclusive = new Date(cursor.getTime() + 86400000)

      days.push({
        label: DAILY_PERIOD_LABEL_FORMATTER.format(cursor),
        date: formatIsoDate(dayStart),
        startDate: dayStart,
        endDateExclusive: dayEndExclusive,
      })

      cursor.setTime(cursor.getTime() + 86400000)
    }

    return days
  }

  const months = []
  const startParts = getApplicationCalendarParts(safeStartDate)
  const cursor = createApplicationDateStart(startParts.year, startParts.month, 1)

  while (cursor < safeEndDateExclusive) {
    const monthStart = new Date(cursor)
    const monthParts = getApplicationCalendarParts(cursor)
    const rawMonthEndExclusive = createApplicationDateStart(
      monthParts.year,
      monthParts.month + 1,
      1
    )
    const monthEndExclusive =
      rawMonthEndExclusive > safeEndDateExclusive
        ? safeEndDateExclusive
        : rawMonthEndExclusive
    const effectiveStart = monthStart < safeStartDate ? safeStartDate : monthStart

    months.push({
      label: MONTHLY_PERIOD_LABEL_FORMATTER.format(cursor),
      month: MONTH_LABELS[getApplicationCalendarParts(cursor).month - 1],
      startDate: effectiveStart,
      endDateExclusive: monthEndExclusive,
    })

    const cursorParts = getApplicationCalendarParts(cursor)
    cursor.setTime(
      createApplicationDateStart(cursorParts.year, cursorParts.month + 1, 1).getTime()
    )
  }

  return months
}

export const buildOccupancyTrendPeriods = ({
  selectedYear,
  selectedMonth = ALL_MONTH_LABEL,
  periodType = "MTD",
  today = new Date(),
}) => {
  const year = Number(selectedYear)

  if (!year || Number.isNaN(year)) {
    throw new Error("Invalid year.")
  }

  if (!isAllMonth(selectedMonth) && periodType === "MTD") {
    const monthIndex = getMonthIndex(selectedMonth)

    if (year > today.getFullYear()) return []

    if (year === today.getFullYear() && monthIndex > today.getMonth()) {
      return []
    }

    const endDateExclusive = getSafeMonthEndExclusive(year, monthIndex, today)
    const endParts = getApplicationCalendarParts(
      new Date(endDateExclusive.getTime() - 1)
    )
    const lastDay = endParts.day

    return Array.from({ length: lastDay }, (_, index) => {
      const day = index + 1
      const startDate = createApplicationDateStart(year, monthIndex + 1, day)
      const dayEndDateExclusive = createApplicationDateStart(year, monthIndex + 1, day + 1)

      return {
        label: `${day} ${selectedMonth}`,
        date: formatIsoDate(startDate),
        startDate,
        endDateExclusive: dayEndDateExclusive,
      }
    })
  }

  if (!isAllMonth(selectedMonth) && periodType === "YTD") {
    const requestedMonthIndex = getMonthIndex(selectedMonth)
    const maxMonthIndex = getEffectiveSelectedMonthIndex(year, requestedMonthIndex, today)

    if (maxMonthIndex < 0) return []

    return MONTH_LABELS.slice(0, maxMonthIndex + 1).map((label, monthIndex) => ({
      label,
      month: label,
      startDate: createApplicationDateStart(year, 1, 1),
      endDateExclusive: getSafeMonthEndExclusive(year, monthIndex, today),
    }))
  }

  if (isAllMonth(selectedMonth) && periodType === "MTD") {
    const lastVisibleMonthIndex = getLastVisibleMonthIndex(year, today)

    if (lastVisibleMonthIndex < 0) return []

    return MONTH_LABELS.slice(0, lastVisibleMonthIndex + 1).map((label, monthIndex) => ({
      label,
      month: label,
      startDate: createApplicationDateStart(year, monthIndex + 1, 1),
      endDateExclusive: getSafeMonthEndExclusive(year, monthIndex, today),
    }))
  }

  const lastVisibleMonthIndex = getLastVisibleMonthIndex(year, today)

  if (lastVisibleMonthIndex < 0) return []

  return MONTH_LABELS.slice(0, lastVisibleMonthIndex + 1).map((label, monthIndex) => ({
    label,
    month: label,
    startDate: createApplicationDateStart(year, 1, 1),
    endDateExclusive: getSafeMonthEndExclusive(year, monthIndex, today),
  }))
}

export const getWeekdayLabel = (date) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    getApplicationWeekday(date)
  ]
