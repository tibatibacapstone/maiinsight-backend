import { prisma } from "../config/prisma.js"
import {
  OCCUPANCY_OPPORTUNITY_RULES,
  OFF_PEAK_ANALYSIS_RULES,
  DEFAULT_ANALYSIS_PERIOD,
  normalizeKey,
  resolveAnalysisPeriod,
} from "../constants/aiStrategy.constants.js"
import {
  buildCourtHourUsageWhere,
  buildFacilityTransactionWhere,
  createApplicationDateStart,
  formatIsoDate,
  getApplicationCalendarParts,
  getApplicationWeekday,
  getPreviousComparisonRange,
  parseCalendarDate,
  resolveCustomDateRange,
  resolveSelectedDateRange,
} from "./dashboardPeriod.service.js"
import {
  CANONICAL_TRANSACTION_STATUSES,
  isEligibleCustomerStatus,
} from "./transactionStatus.service.js"
import { getSessionDefinitionByName } from "./lowOccupancyTargeting.service.js"

const DAY_MS = 86400000
const INTERNAL_OCCUPIED_STATUS = CANONICAL_TRANSACTION_STATUSES.INTERNAL
const BLOCKED_STATUSES = new Set([
  CANONICAL_TRANSACTION_STATUSES.TUTUP_MAINTENANCE,
])
const SESSION_LABELS = ["Morning", "Afternoon", "Evening", "Night"]
const OFF_PEAK_OBJECTIVE_KEY = "maximize_off_peak_occupancy"
const DAY_DEFINITIONS = [
  { key: "sunday", label: "Minggu" },
  { key: "monday", label: "Senin" },
  { key: "tuesday", label: "Selasa" },
  { key: "wednesday", label: "Rabu" },
  { key: "thursday", label: "Kamis" },
  { key: "friday", label: "Jumat" },
  { key: "saturday", label: "Sabtu" },
]
const SESSION_LOCAL_LABELS = {
  Morning: "Pagi",
  Afternoon: "Siang",
  Evening: "Sore",
  Night: "Malam",
}

const round = (value, precision = 1) =>
  value == null || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(precision))

const getHour = (value) => {
  const hour = Number(String(value || "").split(":")[0])
  return Number.isInteger(hour) ? hour : null
}

const getOperatingDefinitions = (session) => {
  if (session.key !== "all") return [getSessionDefinitionByName(session.label)]
  return SESSION_LABELS.map(getSessionDefinitionByName)
}

const isOccupiedStatus = (status) =>
  status === INTERNAL_OCCUPIED_STATUS || isEligibleCustomerStatus(status)

export const resolveAiOpportunityDateRange = (selected = {}) => {
  if (selected.campaignDate) {
    const range = resolveCustomDateRange({
      startDate: selected.campaignDate,
      endDate: selected.campaignDate,
    })
    return { ...range, description: `campaign date ${selected.campaignDate}` }
  }
  if (selected.startDate && selected.endDate) {
    const range = resolveCustomDateRange({
      startDate: selected.startDate,
      endDate: selected.endDate,
    })
    return {
      ...range,
      description: `custom period ${selected.startDate} to ${selected.endDate}`,
    }
  }
  if (selected.year) {
    const range = resolveSelectedDateRange({
      selectedYear: selected.year,
      selectedMonth: selected.month || "All Month",
      periodType: selected.periodType || "MTD",
    })
    return {
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      description: `${selected.periodType || "MTD"} selected period`,
    }
  }
  return null
}

export const calculateRevenueOpportunity = ({ currentRevenue, revenueTarget }) => {
  const normalizedRevenue =
    currentRevenue !== null &&
    currentRevenue !== undefined &&
    Number.isFinite(Number(currentRevenue))
    ? Number(currentRevenue)
    : null
  const normalizedTarget =
    revenueTarget !== null &&
    revenueTarget !== undefined &&
    Number.isFinite(Number(revenueTarget))
    ? Number(revenueTarget)
    : null

  if (normalizedTarget == null) {
    return {
      available: false,
      currentRevenue: normalizedRevenue,
      revenueTarget: null,
      revenueGap: null,
      revenueAchievementPct: null,
      gapStatus: "unavailable",
      reason: "Revenue target is unavailable for the selected scope.",
    }
  }

  const achievement =
    normalizedTarget > 0 && normalizedRevenue != null
      ? round((normalizedRevenue / normalizedTarget) * 100)
      : null
  const gap =
    normalizedRevenue != null ? Math.max(normalizedTarget - normalizedRevenue, 0) : null
  const gapStatus =
    normalizedRevenue == null || normalizedTarget <= 0
      ? "unavailable"
      : normalizedRevenue > normalizedTarget
        ? "target_exceeded"
        : normalizedRevenue === normalizedTarget
          ? "target_met"
          : "below_target"

  return {
    available: normalizedTarget > 0 && normalizedRevenue != null,
    currentRevenue: normalizedRevenue,
    revenueTarget: normalizedTarget,
    revenueGap: gap,
    revenueAchievementPct: achievement,
    gapStatus,
    ...(normalizedTarget <= 0
      ? { reason: "Revenue target must be greater than zero for achievement analysis." }
      : {}),
  }
}

export const calculateCourtHourMetrics = ({
  rows,
  knownCourts,
  operatingDefinitions,
  totalDays,
}) => {
  if (
    !knownCourts.length ||
    !operatingDefinitions.length ||
    operatingDefinitions.some((definition) => !definition) ||
    totalDays <= 0
  ) {
    return {
      available: false,
      occupiedCourtHours: null,
      blockedCourtHours: null,
      availableCourtHours: null,
      occupancyRate: null,
      reason: "Reliable occupancy denominator is unavailable.",
    }
  }
  const knownCourtKeys = new Set(
    knownCourts.map((row) => `${row.courtType || ""}|${row.court}`)
  )
  const inOperatingHours = (row) => {
    const hour = getHour(row.hourStart)
    return operatingDefinitions.some(
      (definition) => hour != null && hour >= definition.startHour && hour <= definition.endHour
    )
  }
  const relevantRows = rows.filter(
    (row) =>
      knownCourtKeys.has(`${row.courtType || ""}|${row.court}`) &&
      inOperatingHours(row)
  )
  const occupiedKeys = new Set(
    relevantRows
      .filter(
        (row) =>
          row.transaction?.validBooking === true &&
          isOccupiedStatus(row.transaction.status)
      )
      .map((row) => `${row.courtType || ""}|${row.court}|${row.playDate || ""}|${row.hourStart}`)
  )
  const blockedKeys = new Set(
    relevantRows
      .filter((row) => BLOCKED_STATUSES.has(row.transaction?.status))
      .map((row) => `${row.courtType || ""}|${row.court}|${row.playDate || ""}|${row.hourStart}`)
  )
  const hoursPerDay = operatingDefinitions.reduce(
    (total, definition) => total + definition.endHour - definition.startHour + 1,
    0
  )
  const totalConfiguredCourtHours = knownCourts.length * hoursPerDay * totalDays
  const availableCourtHours = Math.max(totalConfiguredCourtHours - blockedKeys.size, 0)

  return {
    available: availableCourtHours > 0,
    occupiedCourtHours: occupiedKeys.size,
    blockedCourtHours: blockedKeys.size,
    availableCourtHours,
    occupancyRate:
      availableCourtHours > 0
        ? round((occupiedKeys.size / availableCourtHours) * 100)
        : null,
    ...(availableCourtHours > 0
      ? {}
      : { reason: "Reliable occupancy denominator is unavailable." }),
  }
}

export const classifyOccupancyOpportunity = (gap) => {
  if (gap == null) return null
  if (gap >= OCCUPANCY_OPPORTUNITY_RULES.highGapPercentagePoints) return "high"
  if (gap >= OCCUPANCY_OPPORTUNITY_RULES.mediumGapPercentagePoints) return "medium"
  return "low"
}

const getCourtHourRows = async ({ db, range, venue }) =>
  db.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      courtType: venue.key === "all" ? null : venue.key,
      includeOperational: true,
    }),
    select: {
      court: true,
      courtType: true,
      playDate: true,
      hourStart: true,
      transaction: { select: { validBooking: true, status: true } },
    },
  })

const getKnownCourts = async ({ db, venue }) =>
  db.facilityTransaction.findMany({
    where: {
      validBooking: true,
      status: {
        in: [
          CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
          CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
          CANONICAL_TRANSACTION_STATUSES.INTERNAL,
        ],
      },
      ...(venue.key === "all" ? {} : { courtType: venue.key }),
    },
    distinct: ["courtType", "court"],
    select: { court: true, courtType: true },
  })

const numberOfDays = (range) =>
  Math.max(0, Math.round((range.endDateExclusive - range.startDate) / DAY_MS))

export const subtractApplicationCalendarMonths = (date, months) => {
  const parts = getApplicationCalendarParts(date)
  const targetMonthIndex = parts.month - 1 - months
  const targetYear = parts.year + Math.floor(targetMonthIndex / 12)
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12
  const targetMonth = normalizedMonthIndex + 1
  const nextMonthStart = createApplicationDateStart(targetYear, targetMonth + 1, 1)
  const lastTargetDay = getApplicationCalendarParts(
    new Date(nextMonthStart.getTime() - DAY_MS)
  ).day
  return createApplicationDateStart(
    targetYear,
    targetMonth,
    Math.min(parts.day, lastTargetDay)
  )
}

export const resolveAnalysisPeriodRange = ({
  analysisPeriodKey = DEFAULT_ANALYSIS_PERIOD.key,
  now = new Date(),
} = {}) => {
  const period = resolveAnalysisPeriod(analysisPeriodKey)
  if (!period) {
    const error = new Error("The selected analysis period is not supported.")
    error.errorCode = "INVALID_ANALYSIS_PERIOD"
    error.statusCode = 400
    throw error
  }
  const parts = getApplicationCalendarParts(now)
  const analysisEndExclusive = createApplicationDateStart(
    parts.year,
    parts.month,
    parts.day
  )
  const analysisStart = subtractApplicationCalendarMonths(
    analysisEndExclusive,
    period.months
  )
  return {
    analysisPeriodKey: period.key,
    label: period.label,
    lookbackMonths: period.months,
    analysisStart,
    analysisEndExclusive,
    analysisStartDateLabel: formatIsoDate(analysisStart),
    analysisEndDateLabel: formatIsoDate(
      new Date(analysisEndExclusive.getTime() - DAY_MS)
    ),
    timezone: "Asia/Bangkok",
  }
}

export const resolveOffPeakAnalysisRange = ({
  analysisDate,
  now = new Date(),
  rules = OFF_PEAK_ANALYSIS_RULES,
} = {}) => {
  const analysisEndExclusive = analysisDate
    ? parseCalendarDate(analysisDate)
    : (() => {
        const parts = getApplicationCalendarParts(now)
        return createApplicationDateStart(parts.year, parts.month, parts.day)
      })()
  return {
    startDate: subtractApplicationCalendarMonths(analysisEndExclusive, rules.lookbackMonths),
    endDateExclusive: analysisEndExclusive,
  }
}

const getWeekKey = (date) => {
  const weekday = getApplicationWeekday(date)
  return formatIsoDate(new Date(date.getTime() - weekday * DAY_MS))
}

const courtKey = (row) => `${row.courtType || ""}|${row.court}`
const courtHourKey = (row) =>
  `${courtKey(row)}|${formatIsoDate(new Date(row.playDate))}|${row.hourStart}`

export const aggregateOffPeakWindows = ({
  rows,
  knownCourts,
  range,
  selectedSessionKey = "all",
  rules = OFF_PEAK_ANALYSIS_RULES,
}) => {
  const operatingDefinitions = SESSION_LABELS.map((label) => ({
    key: normalizeKey(label),
    label,
    definition: getSessionDefinitionByName(label),
  }))
  if (
    !knownCourts.length ||
    operatingDefinitions.some((item) => !item.definition)
  ) {
    return {
      available: false,
      windows: [],
      reason: "Reliable operating-hour or court inventory data is unavailable.",
    }
  }
  const knownCourtKeys = new Set(knownCourts.map(courtKey))
  const relevantRows = rows.filter((row) => {
    if (!row.playDate || !knownCourtKeys.has(courtKey(row))) return false
    const hour = getHour(row.hourStart)
    return operatingDefinitions.some(
      ({ definition }) =>
        hour != null && hour >= definition.startHour && hour <= definition.endHour
    )
  })
  const observedWeekKeys = new Set(relevantRows.map((row) => getWeekKey(new Date(row.playDate))))
  if (observedWeekKeys.size < rules.minimumObservedWeeks) {
    return {
      available: false,
      windows: [],
      reason: `Historical coverage is below the required ${rules.minimumObservedWeeks} observed weeks.`,
    }
  }

  const occurrencesByDay = Array(7).fill(0)
  for (
    let cursor = new Date(range.startDate);
    cursor < range.endDateExclusive;
    cursor = new Date(cursor.getTime() + DAY_MS)
  ) {
    if (observedWeekKeys.has(getWeekKey(cursor))) {
      occurrencesByDay[getApplicationWeekday(cursor)] += 1
    }
  }

  const sessionCandidates = operatingDefinitions.filter(
    ({ key }) => selectedSessionKey === "all" || key === selectedSessionKey
  )
  const windows = []
  DAY_DEFINITIONS.forEach((day, dayIndex) => {
    sessionCandidates.forEach(({ key: sessionKey, label, definition }, sessionIndex) => {
      const sessionHours = definition.endHour - definition.startHour + 1
      const configuredHours =
        occurrencesByDay[dayIndex] * knownCourts.length * sessionHours
      const matchingRows = relevantRows.filter((row) => {
        const hour = getHour(row.hourStart)
        return (
          getApplicationWeekday(new Date(row.playDate)) === dayIndex &&
          hour >= definition.startHour &&
          hour <= definition.endHour
        )
      })
      const occupied = new Set(
        matchingRows
          .filter(
            (row) =>
              row.transaction?.validBooking === true &&
              isOccupiedStatus(row.transaction.status)
          )
          .map(courtHourKey)
      ).size
      const blocked = new Set(
        matchingRows
          .filter((row) => BLOCKED_STATUSES.has(row.transaction?.status))
          .map(courtHourKey)
      ).size
      const availableCourtHours = Math.max(configuredHours - blocked, 0)
      if (availableCourtHours < rules.minimumAvailableCourtHours) return
      windows.push({
        dayKey: day.key,
        dayLabel: day.label,
        sessionKey,
        sessionLabel: SESSION_LOCAL_LABELS[label] || label,
        occupiedCourtHours: occupied,
        availableCourtHours,
        emptyCourtHours: Math.max(availableCourtHours - occupied, 0),
        occupancyRate: round((occupied / availableCourtHours) * 100),
        observedWeeks: observedWeekKeys.size,
        dayOrder: dayIndex,
        sessionOrder: sessionIndex,
      })
    })
  })
  windows.sort(
    (left, right) =>
      left.occupancyRate - right.occupancyRate ||
      right.emptyCourtHours - left.emptyCourtHours ||
      left.dayOrder - right.dayOrder ||
      left.sessionOrder - right.sessionOrder
  )
  return {
    available: windows.length > 0,
    windows: windows
      .slice(0, rules.resultLimit)
      .map((window, index) => ({
        rank: index + 1,
        dayKey: window.dayKey,
        dayLabel: window.dayLabel,
        sessionKey: window.sessionKey,
        sessionLabel: window.sessionLabel,
        occupiedCourtHours: window.occupiedCourtHours,
        availableCourtHours: window.availableCourtHours,
        emptyCourtHours: window.emptyCourtHours,
        occupancyRate: window.occupancyRate,
        observedWeeks: window.observedWeeks,
      })),
    ...(windows.length
      ? {}
      : { reason: "No day-and-session window meets the minimum historical coverage." }),
  }
}

export const buildOffPeakOpportunity = async ({
  venue,
  session,
  generationDate,
  analysisRange,
  analysisPeriod,
  db = prisma,
  rules = OFF_PEAK_ANALYSIS_RULES,
}) => {
  let range
  try {
    range = analysisRange || resolveOffPeakAnalysisRange({
      analysisDate: generationDate || null,
      rules,
    })
  } catch {
    return {
      available: false,
      lookbackMonths: rules.lookbackMonths,
      analysisStartDate: null,
      analysisEndDateExclusive: null,
      venueKey: venue.key,
      historicalBaseline: null,
      recommendedPrimaryWindow: null,
      lowestOccupancyWindows: [],
      reason: "The off-peak analysis date is invalid.",
    }
  }
  const base = {
    analysisPeriodKey: analysisPeriod?.key || null,
    lookbackMonths: analysisPeriod?.lookbackMonths || rules.lookbackMonths,
    analysisStartDate: formatIsoDate(range.startDate),
    analysisEndDateExclusive: formatIsoDate(range.endDateExclusive),
    venueKey: venue.key,
    historicalBaseline: analysisPeriod
      ? `Rolling ${analysisPeriod.label.toLowerCase()} before the strategy generation date.`
      : "Rolling three calendar months before the strategy generation date.",
  }
  const [rows, knownCourts] = await Promise.all([
    getCourtHourRows({ db, range, venue }),
    getKnownCourts({ db, venue }),
  ])
  const periodDays = numberOfDays(range)
  const periodAwareRules = {
    ...rules,
    minimumObservedWeeks: Math.min(
      rules.minimumObservedWeeks,
      Math.max(1, Math.floor(periodDays / 7))
    ),
  }
  const aggregation = aggregateOffPeakWindows({
    rows,
    knownCourts,
    range,
    selectedSessionKey: session.key,
    rules: periodAwareRules,
  })
  if (!aggregation.available) {
    return {
      available: false,
      ...base,
      recommendedPrimaryWindow: null,
      lowestOccupancyWindows: [],
      reason: aggregation.reason,
    }
  }
  return {
    available: true,
    ...base,
    recommendedPrimaryWindow: aggregation.windows[0],
    lowestOccupancyWindows: aggregation.windows,
  }
}

export const buildRevenueOpportunity = async ({
  selected,
  venue,
  range,
  db = prisma,
}) => {
  if (!range) {
    return calculateRevenueOpportunity({ currentRevenue: null, revenueTarget: null })
  }
  const transactions = await db.facilityTransaction.findMany({
    where: buildFacilityTransactionWhere({
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      courtType: venue.key === "all" ? null : venue.key,
      customerType: selected.customerType,
      bookingType: selected.bookingType,
      includeOperational: true,
    }),
    select: { netRevenue: true },
  })
  const currentRevenue = transactions.reduce(
    (total, row) => total + Number(row.netRevenue || 0),
    0
  )
  // Repository audit: no persisted or configured revenue-target source exists.
  return calculateRevenueOpportunity({ currentRevenue, revenueTarget: null })
}

export const buildRevenueHistory = async ({
  selected,
  venue,
  range,
  analysisMonths,
  db = prisma,
}) => {
  const transactions = await db.facilityTransaction.findMany({
    where: buildFacilityTransactionWhere({
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      courtType: venue.key === "all" ? null : venue.key,
      customerType: selected.customerType,
      bookingType: selected.bookingType,
      includeOperational: true,
    }),
    select: { netRevenue: true },
  })
  const totalRevenue = transactions.reduce(
    (total, row) => total + Number(row.netRevenue || 0),
    0
  )
  return {
    available: true,
    totalRevenue: round(totalRevenue),
    averageMonthlyRevenue:
      analysisMonths > 0 ? round(totalRevenue / analysisMonths) : null,
    validRevenueTransactionCount: transactions.length,
    analysisMonths,
    currency: "IDR",
  }
}

export const buildOccupancyHistory = async ({
  venue,
  session,
  range,
  analysisPeriodKey,
  db = prisma,
}) => {
  const operatingDefinitions = getOperatingDefinitions(session)
  const [knownCourts, rows] = await Promise.all([
    getKnownCourts({ db, venue }),
    getCourtHourRows({ db, range, venue }),
  ])
  const metrics = calculateCourtHourMetrics({
    rows,
    knownCourts,
    operatingDefinitions,
    totalDays: numberOfDays(range),
  })
  if (!metrics.available) {
    return {
      available: false,
      averageOccupancyRate: null,
      occupiedCourtHours: null,
      availableCourtHours: null,
      emptyCourtHours: null,
      analysisPeriodKey,
      reason: "Reliable operating-hour or court inventory data is unavailable.",
    }
  }
  return {
    available: true,
    averageOccupancyRate: metrics.occupancyRate,
    occupiedCourtHours: metrics.occupiedCourtHours,
    availableCourtHours: metrics.availableCourtHours,
    emptyCourtHours: Math.max(
      metrics.availableCourtHours - metrics.occupiedCourtHours,
      0
    ),
    analysisPeriodKey,
  }
}

export const buildOccupancyOpportunity = async ({
  venue,
  session,
  range,
  db = prisma,
}) => {
  if (!range) {
    return {
      available: false,
      currentOccupancyRate: null,
      historicalAverageOccupancyRate: null,
      occupancyGapPercentagePoints: null,
      opportunityLevel: null,
      historicalBaseline: null,
      reason: "A selected date or period is required for occupancy comparison.",
    }
  }
  const previousRange = getPreviousComparisonRange(range)
  const operatingDefinitions = getOperatingDefinitions(session)
  const knownCourts = await getKnownCourts({ db, venue })
  const [currentRows, previousRows] = await Promise.all([
    getCourtHourRows({ db, range, venue }),
    getCourtHourRows({ db, range: previousRange, venue }),
  ])
  const current = calculateCourtHourMetrics({
    rows: currentRows,
    knownCourts,
    operatingDefinitions,
    totalDays: numberOfDays(range),
  })
  const historical = calculateCourtHourMetrics({
    rows: previousRows,
    knownCourts,
    operatingDefinitions,
    totalDays: numberOfDays(previousRange),
  })
  if (!current.available || !historical.available) {
    return {
      available: false,
      currentOccupancyRate: current.occupancyRate,
      historicalAverageOccupancyRate: historical.occupancyRate,
      occupancyGapPercentagePoints: null,
      opportunityLevel: null,
      historicalBaseline: null,
      reason: "Reliable occupancy denominator is unavailable.",
    }
  }
  const gap = round(historical.occupancyRate - current.occupancyRate)
  return {
    available: true,
    currentOccupancyRate: current.occupancyRate,
    historicalAverageOccupancyRate: historical.occupancyRate,
    occupancyGapPercentagePoints: gap,
    opportunityLevel: classifyOccupancyOpportunity(gap),
    historicalBaseline: `Previous equivalent period: ${formatIsoDate(previousRange.startDate)} to ${formatIsoDate(new Date(previousRange.endDateExclusive.getTime() - DAY_MS))}.`,
    currentOccupiedCourtHours: current.occupiedCourtHours,
    currentAvailableCourtHours: current.availableCourtHours,
    historicalOccupiedCourtHours: historical.occupiedCourtHours,
    historicalAvailableCourtHours: historical.availableCourtHours,
  }
}

export const buildFutureSlotOpportunity = async ({
  venue,
  session,
  campaignDate,
  db = prisma,
}) => {
  const unavailable = (reason) => ({
    available: false,
    campaignDate: campaignDate || null,
    venueKey: venue.key,
    sessionKey: session.key,
    totalEligibleCourtHours: null,
    occupiedCourtHours: null,
    blockedCourtHours: null,
    remainingCourtHours: null,
    availabilityStatus: "unavailable",
    reason,
  })
  if (!campaignDate) return unavailable("A campaign date is required for future slot analysis.")
  let range
  try {
    range = resolveCustomDateRange({ startDate: campaignDate, endDate: campaignDate })
  } catch {
    return unavailable("The campaign date is invalid.")
  }
  const operatingDefinitions = getOperatingDefinitions(session)
  const knownCourts = await getKnownCourts({ db, venue })
  if (!knownCourts.length || operatingDefinitions.some((definition) => !definition)) {
    return unavailable("Reliable venue inventory or operating-hour configuration is unavailable.")
  }
  const rows = await getCourtHourRows({ db, range, venue })
  const metrics = calculateCourtHourMetrics({
    rows,
    knownCourts,
    operatingDefinitions,
    totalDays: 1,
  })
  if (!metrics.available) return unavailable(metrics.reason)
  const totalEligibleCourtHours =
    metrics.availableCourtHours + metrics.blockedCourtHours
  const remainingCourtHours = Math.max(
    totalEligibleCourtHours - metrics.occupiedCourtHours - metrics.blockedCourtHours,
    0
  )
  const ratio = totalEligibleCourtHours > 0 ? remainingCourtHours / totalEligibleCourtHours : 0
  return {
    available: true,
    campaignDate,
    venueKey: venue.key,
    sessionKey: session.key,
    totalEligibleCourtHours,
    occupiedCourtHours: metrics.occupiedCourtHours,
    blockedCourtHours: metrics.blockedCourtHours,
    remainingCourtHours,
    availabilityStatus:
      remainingCourtHours === 0 ? "full" : ratio <= 0.25 ? "limited" : "available",
  }
}

export const calculatePromotionUsage = (transactions) => {
  const bookingPromotions = new Map()
  for (const row of transactions) {
    if (!row.validBooking || !isEligibleCustomerStatus(row.status) || !row.bookingEventKey) continue
    const promotion = String(row.promoName || row.promosi || "").trim()
    const existing = bookingPromotions.get(row.bookingEventKey)
    bookingPromotions.set(row.bookingEventKey, existing || promotion || null)
  }
  const validBookingCount = bookingPromotions.size
  const used = [...bookingPromotions.values()].filter(Boolean)
  const counts = new Map()
  used.forEach((promotion) => counts.set(promotion, (counts.get(promotion) || 0) + 1))
  const mostUsedPromotion =
    [...counts.entries()].sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName)
    )[0]?.[0] || null
  return {
    available: validBookingCount > 0,
    validBookingCount,
    promotionUsageCount: used.length,
    promotionUsagePct:
      validBookingCount > 0 ? round((used.length / validBookingCount) * 100) : null,
    mostUsedPromotion,
    ...(validBookingCount > 0
      ? {}
      : {
          reason:
            "Promotion usage cannot be attributed reliably to selected-segment bookings.",
        }),
  }
}

export const buildBusinessOpportunitySummary = ({
  segmentKey,
  segmentHistory,
  analysisPeriod,
  revenueHistory,
  occupancyHistory,
  offPeakOpportunity,
  promotionUsageContext,
}) => {
  const primaryOpportunity = {
    prime: "customer_retention",
    routine: "customer_value_growth",
    growth: "repeat_booking_growth",
    re_engagement: "customer_reactivation",
  }[segmentKey]
  const supportingOpportunities = []
  const supportingReasons = []
  if (occupancyHistory.available && occupancyHistory.emptyCourtHours > 0) {
    supportingOpportunities.push("historical_empty_hour_utilization")
    supportingReasons.push(
      `Rata-rata okupansi selama ${analysisPeriod.label} adalah ${occupancyHistory.averageOccupancyRate}%, dengan ${occupancyHistory.emptyCourtHours} jam lapangan kosong.`
    )
  }
  if (revenueHistory.available) {
    supportingOpportunities.push("revenue_growth")
    supportingReasons.push(
      `Total revenue selama ${analysisPeriod.label} adalah Rp${Math.round(revenueHistory.totalRevenue).toLocaleString("id-ID")}.`
    )
  }
  if (offPeakOpportunity.available && offPeakOpportunity.recommendedPrimaryWindow) {
    supportingOpportunities.push("historical_occupancy_recovery")
    supportingReasons.push(
      `${offPeakOpportunity.recommendedPrimaryWindow.dayLabel} sesi ${offPeakOpportunity.recommendedPrimaryWindow.sessionLabel} memiliki okupansi terendah ${offPeakOpportunity.recommendedPrimaryWindow.occupancyRate}%.`
    )
  }
  if (
    promotionUsageContext.available &&
    promotionUsageContext.promotionUsageCount > 0
  ) {
    supportingOpportunities.push("promotion_usage_opportunity")
    supportingReasons.push(
      `${promotionUsageContext.promotionUsagePct}% booking valid segmen menggunakan promosi selama ${analysisPeriod.label}.`
    )
  }
  if (segmentHistory.averageRecencyDays != null) {
    supportingReasons.push(
      `The selected segment has an average recency of ${segmentHistory.averageRecencyDays} days.`
    )
  }
  return {
    analysisPeriodKey: analysisPeriod.key,
    primaryOpportunity,
    supportingOpportunities,
    opportunityLevel: occupancyHistory.available
      ? occupancyHistory.emptyCourtHours > 0
        ? "medium"
        : "low"
      : supportingOpportunities.length
        ? "medium"
        : "low",
    supportingReasons,
  }
}

export const buildAiBusinessOpportunities = async ({
  selected,
  venue,
  session,
  segmentKey,
  segmentHistory,
  selectedSegmentTransactions,
  analysisPeriod = null,
  includeFutureSlot = false,
  db = prisma,
}) => {
  const range = analysisPeriod
    ? {
        startDate: analysisPeriod.analysisStart,
        endDateExclusive: analysisPeriod.analysisEndExclusive,
      }
    : resolveAiOpportunityDateRange(selected)
  const campaignDate = selected.campaignDate || null
  const objectiveKey = normalizeKey(
    selected.campaignObjectiveKey || selected.campaignObjective
  )
  const promotionTransactions = selectedSegmentTransactions.filter((row) => {
    const playDate = row.playDate || row.tanggalMain
    if (
      range &&
      (!playDate ||
        new Date(playDate) < range.startDate ||
        new Date(playDate) >= range.endDateExclusive)
    ) {
      return false
    }
    if (venue.key !== "all" && row.courtType !== venue.key) return false
    if (session.key !== "all") {
      const definition = getSessionDefinitionByName(session.label)
      const hour = getHour(row.startHour)
      if (!definition || hour == null || hour < definition.startHour || hour > definition.endHour) {
        return false
      }
    }
    return true
  })
  const [revenueOpportunity, occupancyOpportunity, futureSlotOpportunity, offPeakOpportunity, revenueHistory, occupancyHistory] =
    await Promise.all([
      buildRevenueOpportunity({ selected, venue, range, db }),
      !includeFutureSlot
        ? Promise.resolve({
            available: false,
            currentOccupancyRate: null,
            historicalAverageOccupancyRate: null,
            occupancyGapPercentagePoints: null,
            opportunityLevel: null,
            historicalBaseline: null,
            reason:
              "General Strategy uses occupancy_history for the selected analysis period.",
          })
        : buildOccupancyOpportunity({ venue, session, range, db }),
      analysisPeriod
        ? Promise.resolve({
            available: false,
            campaignDate: null,
            venueKey: venue.key,
            sessionKey: session.key,
            totalEligibleCourtHours: null,
            occupiedCourtHours: null,
            blockedCourtHours: null,
            remainingCourtHours: null,
            availabilityStatus: "unavailable",
            reason: "Future slot availability is not analyzed in General Strategy.",
          })
        : buildFutureSlotOpportunity({ venue, session, campaignDate, db }),
      analysisPeriod || objectiveKey === OFF_PEAK_OBJECTIVE_KEY
        ? buildOffPeakOpportunity({
            venue,
            session,
            generationDate: campaignDate,
            analysisRange: analysisPeriod ? range : null,
            analysisPeriod: analysisPeriod
              ? {
                  key: analysisPeriod.analysisPeriodKey,
                  label: analysisPeriod.label,
                  lookbackMonths: analysisPeriod.lookbackMonths,
                }
              : null,
            db,
          })
        : Promise.resolve({
            available: false,
            lookbackMonths: OFF_PEAK_ANALYSIS_RULES.lookbackMonths,
            analysisStartDate: null,
            analysisEndDateExclusive: null,
            venueKey: venue.key,
            historicalBaseline: null,
            recommendedPrimaryWindow: null,
            lowestOccupancyWindows: [],
            reason: "Off-peak analysis applies only to the maximize off-peak occupancy objective.",
          }),
      analysisPeriod
        ? buildRevenueHistory({
            selected,
            venue,
            range,
            analysisMonths: analysisPeriod.lookbackMonths,
            db,
          })
        : Promise.resolve(null),
      analysisPeriod
        ? buildOccupancyHistory({
            venue,
            session,
            range,
            analysisPeriodKey: analysisPeriod.analysisPeriodKey,
            db,
          })
        : Promise.resolve(null),
    ])
  const promotionUsageContext = calculatePromotionUsage(promotionTransactions)
  const businessOpportunitySummary = buildBusinessOpportunitySummary({
    segmentKey,
    segmentHistory,
    analysisPeriod: analysisPeriod
      ? { key: analysisPeriod.analysisPeriodKey, label: analysisPeriod.label }
      : { key: "legacy_scope", label: "periode terpilih" },
    revenueHistory: revenueHistory || {
      available: revenueOpportunity.currentRevenue != null,
      totalRevenue: revenueOpportunity.currentRevenue || 0,
    },
    occupancyHistory: occupancyHistory || {
      available: occupancyOpportunity.available,
      averageOccupancyRate: occupancyOpportunity.currentOccupancyRate,
      emptyCourtHours: 0,
    },
    offPeakOpportunity,
    promotionUsageContext,
  })
  return {
    revenueOpportunity,
    occupancyOpportunity,
    futureSlotOpportunity,
    offPeakOpportunity,
    promotionUsageContext,
    businessOpportunitySummary,
    revenueHistory,
    occupancyHistory,
  }
}
