import { prisma } from "../config/prisma.js"
import {
  MEMBERSHIP_OPPORTUNITY_RULE,
  SEGMENT_STRATEGY_GUIDANCE,
  DEFAULT_ANALYSIS_PERIOD,
  normalizeKey,
  resolveAnalysisPeriod,
  resolveCustomerSegment,
  resolveOfferFramework,
} from "../constants/aiStrategy.constants.js"
import {
  CANONICAL_TRANSACTION_STATUSES,
  isEligibleCustomerStatus,
} from "./transactionStatus.service.js"
import {
  getLatestCampaignPlayDate,
  getSessionDefinitionByName,
  resolveSessionNameByHour,
} from "./lowOccupancyTargeting.service.js"
import {
  formatIsoDate,
  resolveCustomDateRange,
  resolveSelectedDateRange,
} from "./dashboardPeriod.service.js"
import {
  buildAiBusinessOpportunities,
  resolveAnalysisPeriodRange,
} from "./aiBusinessOpportunity.service.js"
import { computeContentPerformance } from "./instagramContentPerformance.service.js"

const VALID_CUSTOMER_STATUSES = [
  CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
  CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
]

const VENUES = {
  all: { key: "all", label: "All Venue" },
  all_venue: { key: "all", label: "All Venue" },
  mini_soccer: { key: "mini_soccer", label: "Mini Soccer" },
  basketball: { key: "basketball", label: "Basketball" },
}

const SESSIONS = {
  all: { key: "all", label: "All Sessions" },
  morning: { key: "morning", label: "Morning" },
  afternoon: { key: "afternoon", label: "Afternoon" },
  evening: { key: "evening", label: "Evening" },
  night: { key: "night", label: "Night" },
}

const SUPPORTED_WORKSPACE_MODES = new Set([
  "general_strategy",
  "low_occupancy_outreach",
])
const SUPPORTED_CAMPAIGN_OBJECTIVES = new Set([
  "maximize_off_peak_occupancy",
  "drive_revenue_growth",
  "boost_social_media_conversion",
  "increase_customer_retention",
  "customer_reactivation",
  "customer_reactivation_and_retention",
])
const LOW_OCCUPANCY_OBJECTIVE = "maximize_off_peak_occupancy"
const SOCIAL_CONTENT_OBJECTIVE = "boost_social_media_conversion"
const SOCIAL_CONTENT_TOP_LIMIT = 5
const SOCIAL_CONTENT_LOW_LIMIT = 3
const SOCIAL_CAPTION_EXCERPT_LENGTH = 160

export const validateWorkspaceObjectiveCombination = ({
  workspaceModeKey,
  campaignObjectiveKey,
} = {}) => {
  const normalizedMode = normalizeKey(workspaceModeKey || "general_strategy")
  const normalizedObjective = normalizeKey(
    campaignObjectiveKey || LOW_OCCUPANCY_OBJECTIVE
  )

  if (!SUPPORTED_WORKSPACE_MODES.has(normalizedMode)) {
    const error = new Error("The selected workspace mode is not supported.")
    error.errorCode = "INVALID_WORKSPACE_MODE"
    error.statusCode = 400
    throw error
  }
  if (!SUPPORTED_CAMPAIGN_OBJECTIVES.has(normalizedObjective)) {
    const error = new Error("The selected campaign objective is not supported.")
    error.errorCode = "INVALID_CAMPAIGN_OBJECTIVE"
    error.statusCode = 400
    throw error
  }
  if (
    normalizedMode === "low_occupancy_outreach" &&
    normalizedObjective !== LOW_OCCUPANCY_OBJECTIVE
  ) {
    const error = new Error(
      "Low Occupancy Outreach requires Maximize Off-Peak Occupancy."
    )
    error.errorCode = "INVALID_WORKSPACE_OBJECTIVE_COMBINATION"
    error.statusCode = 400
    throw error
  }

  return {
    workspaceModeKey: normalizedMode,
    campaignObjectiveKey: normalizedObjective,
  }
}

const round = (value, precision = 1) =>
  value == null || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(precision))

const asDateOnly = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

export const resolveVenue = (value) => VENUES[normalizeKey(value)] || null
export const resolveSession = (value) => SESSIONS[normalizeKey(value)] || null
export const serializeAnalysisPeriod = (analysisPeriod) =>
  analysisPeriod
    ? {
        key: analysisPeriod.analysisPeriodKey,
        label: analysisPeriod.label,
        lookbackMonths: analysisPeriod.lookbackMonths,
        startDate: analysisPeriod.analysisStartDateLabel,
        endDateExclusive: formatIsoDate(analysisPeriod.analysisEndExclusive),
        displayEndDate: analysisPeriod.analysisEndDateLabel,
        timezone: analysisPeriod.timezone,
      }
    : null

export const buildMembershipOpportunity = ({
  segmentKey,
  membershipCount = 0,
  nonMembershipCount = 0,
  membershipSharePct = null,
  nonMembershipSharePct = null,
  averageFrequency = null,
}) => {
  const eligible =
    segmentKey === "routine" &&
    nonMembershipSharePct != null &&
    averageFrequency != null &&
    nonMembershipSharePct >= MEMBERSHIP_OPPORTUNITY_RULE.minimumNonMembershipSharePct &&
    averageFrequency >= MEMBERSHIP_OPPORTUNITY_RULE.minimumAverageFrequency

  let reason
  if (segmentKey !== "routine") {
    reason = "Membership conversion is reserved for Routine Players unless another explicit business rule applies."
  } else if (nonMembershipSharePct == null || averageFrequency == null) {
    reason = "Membership composition or booking frequency is unavailable."
  } else if (nonMembershipSharePct < MEMBERSHIP_OPPORTUNITY_RULE.minimumNonMembershipSharePct) {
    reason = "Most eligible Routine Players are already members, so recurring or loyalty value is a better fit."
  } else if (averageFrequency < MEMBERSHIP_OPPORTUNITY_RULE.minimumAverageFrequency) {
    reason = "Routine Players do not yet meet the minimum repeat-booking frequency for membership conversion."
  } else {
    reason = "Most Routine Players are non-members and already demonstrate repeat-booking behavior."
  }

  return {
    eligible,
    membershipCount,
    nonMembershipCount,
    membershipSharePct,
    nonMembershipSharePct,
    averageFrequency,
    reason,
    rule: MEMBERSHIP_OPPORTUNITY_RULE,
  }
}

const mostFrequent = (values) => {
  const counts = new Map()
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1))
  return [...counts.entries()].sort(
    ([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || String(leftKey).localeCompare(String(rightKey))
  )[0]?.[0] || null
}

export const aggregateSelectedSegmentHistory = ({ segment, scores, customers, transactions }) => {
  const eligibleCustomers = customers.filter((customer) =>
    ["membership", "non_membership", "unknown"].includes(customer.customerType)
  )
  const eligibleCustomerKeys = new Set(eligibleCustomers.map((customer) => customer.customerKey))
  const validTransactions = transactions.filter(
    (transaction) =>
      transaction.validBooking === true &&
      eligibleCustomerKeys.has(transaction.customerKey) &&
      isEligibleCustomerStatus(transaction.status)
  )
  const bookingKeys = new Set(validTransactions.map((transaction) => transaction.bookingEventKey))
  const revenue = validTransactions.reduce(
    (total, transaction) => total + Number(transaction.netRevenue || 0),
    0
  )
  const membershipCount = eligibleCustomers.filter(
    (customer) => customer.customerType === "membership"
  ).length
  const nonMembershipCount = eligibleCustomers.filter(
    (customer) => customer.customerType === "non_membership"
  ).length
  const unknownCustomerTypeCount = eligibleCustomers.filter(
    (customer) => customer.customerType === "unknown"
  ).length
  const denominator = eligibleCustomers.length
  const preferredVenueKey = mostFrequent(validTransactions.map((row) => normalizeKey(row.courtType)))
  const preferredSessionKey = mostFrequent(
    validTransactions.map((row) => normalizeKey(row.playTimeGroup || resolveSessionNameByHour(Number(String(row.startHour || "").split(":")[0]))))
  )
  const promotedBookingKeys = new Set(
    validTransactions
      .filter((row) => Boolean(String(row.promoName || row.promosi || "").trim()) || Number(row.voucherDiscount || 0) > 0)
      .map((row) => row.bookingEventKey)
  )
  const promotionAttributable = validTransactions.some(
    (row) => "promoName" in row || "promosi" in row || "voucherDiscount" in row
  )

  return {
    segmentKey: segment.key,
    segmentLabel: segment.label,
    customerCount: denominator,
    averageRecencyDays: scores.length ? round(scores.reduce((sum, row) => sum + row.recency, 0) / scores.length) : null,
    averageFrequency: scores.length ? round(scores.reduce((sum, row) => sum + row.frequency, 0) / scores.length) : null,
    averageMonetary: scores.length ? round(scores.reduce((sum, row) => sum + Number(row.monetary || 0), 0) / scores.length) : null,
    averageBookingValue: bookingKeys.size ? round(revenue / bookingKeys.size) : null,
    membershipCount,
    nonMembershipCount,
    unknownCustomerTypeCount,
    membershipSharePct: denominator ? round((membershipCount / denominator) * 100) : null,
    nonMembershipSharePct: denominator ? round((nonMembershipCount / denominator) * 100) : null,
    preferredVenueKey,
    preferredVenueLabel: preferredVenueKey ? resolveVenue(preferredVenueKey)?.label || preferredVenueKey : null,
    preferredSessionKey,
    preferredSessionLabel: preferredSessionKey ? resolveSession(preferredSessionKey)?.label || preferredSessionKey : null,
    latestValidBookingDate: validTransactions.length
      ? asDateOnly(
          validTransactions.reduce((latest, row) => {
            const value = row.playDate || row.tanggalMain
            return !latest || (value && new Date(value) > new Date(latest)) ? value : latest
          }, null)
        )
      : null,
    historicalPromotionUsageRate:
      promotionAttributable && bookingKeys.size
        ? round((promotedBookingKeys.size / bookingKeys.size) * 100)
        : null,
    selectedPeriodValidBookingCount: bookingKeys.size,
    selectedPeriodRevenue: round(revenue),
  }
}

const getOperatingSessionDefinitions = () =>
  Object.values(SESSIONS)
    .filter((candidate) => candidate.key !== "all")
    .map((candidate) => getSessionDefinitionByName(candidate.label))

const getHour = (value) => {
  const hour = Number(String(value).split(":")[0])
  return Number.isInteger(hour) ? hour : null
}

const isHourInDefinition = (hour, definition) =>
  hour != null && hour >= definition.startHour && hour <= definition.endHour

export const buildVenueOpportunity = async ({
  venue,
  session,
  campaignDate,
  db = prisma,
  operatingSessionDefinitions = getOperatingSessionDefinitions(),
}) => {
  const base = {
    venueKey: venue.key === "all" ? null : venue.key,
    venueLabel: venue.key === "all" ? null : venue.label,
    sessionKey: session.key === "all" ? null : session.key,
    sessionLabel: session.key === "all" ? null : session.label,
    currentOccupancyRate: null,
    historicalAverageOccupancyRate: null,
    availableCourtHours: null,
    occupiedCourtHours: null,
    currentRevenue: null,
    revenueTarget: null,
    revenueGap: null,
    occupancyAvailabilityReason: null,
  }

  if (!campaignDate) {
    return {
      ...base,
      occupancyAvailabilityReason: "A campaign date is required to calculate occupancy.",
    }
  }

  let dateRange
  try {
    dateRange = resolveCustomDateRange({
      startDate: campaignDate,
      endDate: campaignDate,
    })
  } catch {
    return {
      ...base,
      occupancyAvailabilityReason:
        "The campaign date could not be resolved as an Asia/Bangkok calendar date.",
    }
  }

  const courtWhere = {
    playDate: {
      gte: dateRange.startDate,
      lt: dateRange.endDateExclusive,
    },
    ...(venue.key !== "all" ? { courtType: venue.key } : {}),
  }
  const rows = await db.courtHourUsage.findMany({
    where: courtWhere,
    select: {
      court: true,
      courtType: true,
      hourStart: true,
      hourlyRevenue: true,
      transaction: {
        select: {
          validBooking: true,
          status: true,
        },
      },
    },
  })
  const sessionDefinition =
    session.key === "all" ? null : getSessionDefinitionByName(session.label)
  const operatingDefinitions = sessionDefinition
    ? [sessionDefinition]
    : operatingSessionDefinitions
  const operatingHoursReliable =
    operatingDefinitions.length > 0 && operatingDefinitions.every(Boolean)

  if (!operatingHoursReliable) {
    return {
      ...base,
      occupancyAvailabilityReason:
        "Venue operating hours are unavailable from the configured MaiinSight session definitions.",
    }
  }

  const isInSelectedOperatingHours = (row) => {
    const hour = getHour(row.hourStart)
    return operatingDefinitions.some((definition) => isHourInDefinition(hour, definition))
  }
  const eligibleRows = rows.filter(
    (row) =>
      isInSelectedOperatingHours(row) &&
      row.transaction?.validBooking === true &&
      isEligibleCustomerStatus(row.transaction.status)
  )
  const blockedRows = rows.filter(
    (row) =>
      isInSelectedOperatingHours(row) &&
      [CANONICAL_TRANSACTION_STATUSES.TUTUP_MAINTENANCE].includes(row.transaction?.status)
  )
  const knownCourts = await db.facilityTransaction.findMany({
    where: {
      validBooking: true,
      status: { in: VALID_CUSTOMER_STATUSES },
      ...(venue.key !== "all" ? { courtType: venue.key } : {}),
    },
    distinct: ["courtType", "court"],
    select: { court: true, courtType: true },
  })
  const operatingHourCount = operatingDefinitions.reduce(
    (total, definition) => total + definition.endHour - definition.startHour + 1,
    0
  )
  const knownCourtNames = new Set(
    knownCourts.map((row) => `${row.courtType || ""}|${row.court}`)
  )
  const blockedCourtHourCount = new Set(
    blockedRows
      .filter((row) => knownCourtNames.has(`${row.courtType || ""}|${row.court}`))
      .map((row) => `${row.courtType || ""}|${row.court}|${row.hourStart}`)
  ).size
  const availableCourtHours =
    knownCourts.length && operatingHourCount
      ? Math.max(0, knownCourts.length * operatingHourCount - blockedCourtHourCount)
      : null

  return {
    ...base,
    occupiedCourtHours: eligibleRows.length,
    availableCourtHours,
    currentOccupancyRate:
      availableCourtHours != null && availableCourtHours > 0
        ? round((eligibleRows.length / availableCourtHours) * 100)
        : null,
    currentRevenue: round(
      eligibleRows.reduce((total, row) => total + Number(row.hourlyRevenue || 0), 0)
    ),
    occupancyAvailabilityReason:
      availableCourtHours == null
        ? "No reliable venue court inventory is available for the selected venue."
        : availableCourtHours === 0
          ? "All configured court-hours are blocked or unavailable for the selected date."
          : null,
  }
}

const average = (values) => {
  const finite = values.filter((value) => Number.isFinite(value))
  return finite.length
    ? round(finite.reduce((total, value) => total + value, 0) / finite.length)
    : null
}

const excerptCaption = (caption) => {
  const text = String(caption ?? "").trim()
  if (!text) return null
  return text.length > SOCIAL_CAPTION_EXCERPT_LENGTH
    ? `${text.slice(0, SOCIAL_CAPTION_EXCERPT_LENGTH)}…`
    : text
}

const summarizeContentGroup = (key, items) => ({
  key,
  postCount: items.length,
  averageViews: average(items.map((item) => item.views)),
  averageReach: average(items.map((item) => item.reach)),
  averageEngagementRate: average(items.map((item) => item.engagementRate)),
})

const summarizePost = (item) => ({
  postedAt: asDateOnly(item.postedAt),
  mediaType: item.mediaProductType || item.mediaType || null,
  contentLabel: item.contentLabel,
  captionExcerpt: excerptCaption(item.caption),
  views: item.views,
  reach: item.reach,
  likes: item.likes,
  comments: item.comments,
  shares: item.shares,
  saved: item.saved,
  engagementRate: item.engagementRate,
})

const groupBy = (items, keyOf) => {
  const groups = new Map()
  items.forEach((item) => {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) || []), item])
  })
  return groups
}

// Evidence for the "boost social media conversion" objective: how the
// account's own Instagram content actually performed within the same
// analysis-period window already resolved for the rest of the context (see
// buildAiStrategyContext), so "3 months" means the same 3 months everywhere
// in the prompt. There is no data linking a specific post to a specific
// customer or segment in MaiinSight, so this only supplies aggregate content
// evidence; the prompt is responsible for reasoning qualitatively from
// segment lifecycle + this evidence rather than claiming attribution.
export const buildSocialMediaPerformanceContext = async ({ analysisPeriod, db = prisma }) => {
  if (!analysisPeriod) {
    return { available: false, reason: "No analysis period is selected." }
  }

  const media = await db.instagramMedia.findMany({
    where: {
      postedAt: {
        gte: analysisPeriod.analysisStart,
        lt: analysisPeriod.analysisEndExclusive,
      },
    },
    include: { insights: true },
    orderBy: { postedAt: "desc" },
    take: 1000,
  })

  if (!media.length) {
    return {
      available: false,
      analysisPeriodKey: analysisPeriod.analysisPeriodKey,
      reason: "No Instagram content was posted during the selected analysis period.",
    }
  }

  const contentPerformance = computeContentPerformance(media)
  const hasEngagementSignal = contentPerformance.some((item) => item.engagementRate != null)
  const rankingMetric = hasEngagementSignal ? "engagementRate" : "views"
  const ranked = [...contentPerformance]
    .filter((item) => item[rankingMetric] != null)
    .sort((left, right) => right[rankingMetric] - left[rankingMetric])

  const byMediaType = groupBy(
    contentPerformance,
    (item) => item.mediaProductType || item.mediaType || "Unknown"
  )
  const byContentLabel = groupBy(contentPerformance, (item) => item.contentLabel)
  const sortByEngagement = (left, right) =>
    (right.averageEngagementRate ?? -1) - (left.averageEngagementRate ?? -1)

  return {
    available: true,
    analysisPeriodKey: analysisPeriod.analysisPeriodKey,
    postCount: contentPerformance.length,
    averageEngagementRate: average(contentPerformance.map((item) => item.engagementRate)),
    rankingMetric,
    contentTypeBreakdown: [...byMediaType.entries()]
      .map(([key, items]) => summarizeContentGroup(key, items))
      .sort(sortByEngagement),
    contentLabelBreakdown: [...byContentLabel.entries()]
      .map(([key, items]) => summarizeContentGroup(key, items))
      .sort(sortByEngagement),
    topPerformingContent: ranked.slice(0, SOCIAL_CONTENT_TOP_LIMIT).map(summarizePost),
    lowestPerformingContent: ranked
      .slice(-SOCIAL_CONTENT_LOW_LIMIT)
      .reverse()
      .map(summarizePost),
  }
}

export const buildAiStrategyContext = async (input = {}, { now } = {}) => {
  const selected = input.selected_scope || input.selected_filters || {}
  const { workspaceModeKey, campaignObjectiveKey } =
    validateWorkspaceObjectiveCombination({
      workspaceModeKey: selected.workspaceModeKey || selected.mode,
      campaignObjectiveKey:
        selected.campaignObjectiveKey || selected.campaignObjective,
    })
  const isGeneralStrategy = workspaceModeKey === "general_strategy"
  const usesHistoricalAnalysis =
    isGeneralStrategy || workspaceModeKey === "low_occupancy_outreach"
  const requestedAnalysisPeriodKey =
    selected.analysisPeriodKey ||
    input.analysisPeriodKey ||
    DEFAULT_ANALYSIS_PERIOD.key
  const resolvedPeriod = resolveAnalysisPeriod(requestedAnalysisPeriodKey)
  if (usesHistoricalAnalysis && !resolvedPeriod) {
    const error = new Error("The selected analysis period is not supported.")
    error.errorCode = "INVALID_ANALYSIS_PERIOD"
    error.statusCode = 400
    throw error
  }
  // "N months" always looks back from the newest real transaction in the
  // database, not from today's calendar date, so a stale dataset still
  // yields a period that actually contains data. `now` may still be passed
  // explicitly (tests, callers with their own anchor); it only falls back to
  // the latest transaction date, then finally today if the database is
  // empty.
  const analysisPeriod = usesHistoricalAnalysis
    ? resolveAnalysisPeriodRange({
        analysisPeriodKey: resolvedPeriod.key,
        now: now || (await getLatestCampaignPlayDate(prisma)) || new Date(),
      })
    : null
  // Instagram content evidence only applies to the social-conversion
  // objective, and reuses the exact same analysisPeriod window resolved
  // above so the strategy reasons about one consistent period.
  const socialMediaPerformance =
    campaignObjectiveKey === SOCIAL_CONTENT_OBJECTIVE
      ? await buildSocialMediaPerformanceContext({ analysisPeriod })
      : {
          available: false,
          reason: "Instagram content performance only applies to the boost social media conversion objective.",
        }
  const segment = resolveCustomerSegment(selected.segmentKey || selected.segmentName)
  if (!segment) {
    const error = new Error("The selected customer segment is not supported.")
    error.errorCode = "INVALID_SELECTED_SEGMENT"
    error.statusCode = 400
    throw error
  }
  const venue = resolveVenue(selected.venueKey || selected.venue || input.business_context?.courtType || "all")
  const session = resolveSession(selected.sessionKey || selected.sessionName || input.business_context?.sessionName || "all")
  if (!venue || !session) {
    const error = new Error("The selected venue or session is not supported.")
    error.errorCode = "INVALID_AI_INPUT"
    error.statusCode = 400
    throw error
  }
  const offer = resolveOfferFramework(
    selected.offerFrameworkKey || input.promotion_context?.incentiveFramework || "ai_recommended"
  )
  if (!offer) {
    const error = new Error("The selected offer framework is not supported.")
    error.errorCode = "INVALID_OFFER_FRAMEWORK"
    error.statusCode = 400
    throw error
  }

  // The stored RFM profile must actually describe the customer's history
  // under the same venue / booking-type / period scope the strategy is
  // being generated for — the globally newest completed run may have been
  // scoped to a different venue or a single month, which would silently
  // misrepresent "the customer's overall history" for this context. A run
  // left unscoped on a given dimension (courtType/bookingType/date) covers
  // every value on that dimension, so it's treated as compatible with any
  // requested scope for that dimension; a run scoped to a *different*
  // specific value is not.
  const wantedCourtType = venue.key === "all" ? null : venue.key
  const isRunPeriodCompatible = (run) => {
    if (!analysisPeriod) return true
    if (!run.filterYear) return true
    try {
      const runRange = resolveSelectedDateRange({
        selectedYear: run.filterYear,
        selectedMonth: run.filterMonth,
        periodType: run.filterPeriodType || "MTD",
      })
      return (
        runRange.startDate <= analysisPeriod.analysisStart &&
        runRange.endDateExclusive >= analysisPeriod.analysisEndExclusive
      )
    } catch {
      return false
    }
  }

  const recentCompletedRuns = await prisma.segmentationRun.findMany({
    where: { status: "completed" },
    orderBy: { runDate: "desc" },
    select: { id: true, filterCourtType: true, filterBookingType: true, filterYear: true, filterMonth: true, filterPeriodType: true },
    take: 50,
  })
  const latestRun =
    recentCompletedRuns.find(
      (run) =>
        (!run.filterCourtType || run.filterCourtType === wantedCourtType) &&
        (!run.filterBookingType || run.filterBookingType === "all") &&
        isRunPeriodCompatible(run)
    ) || null

  const scores = latestRun
    ? await prisma.customerRfmScore.findMany({
        where: { runId: latestRun.id, segmentName: segment.label },
        select: { customerKey: true, recency: true, frequency: true, monetary: true },
      })
    : []
  if (!scores.length) {
    const error = new Error(
      recentCompletedRuns.length
        ? `No stored RFM profile for ${segment.label} matches the current venue/period scope. Run segmentation again for this scope, or broaden the filters.`
        : `No stored RFM profile exists for ${segment.label}.`
    )
    error.errorCode = "SELECTED_SEGMENT_PROFILE_NOT_FOUND"
    error.statusCode = 404
    throw error
  }
  const customerKeys = scores.map((score) => score.customerKey)
  const customers = await prisma.customer.findMany({
    where: { customerKey: { in: customerKeys } },
    select: { customerKey: true, customerType: true },
  })
  const transactions = await prisma.facilityTransaction.findMany({
    where: {
      customerKey: { in: customerKeys },
      validBooking: true,
      status: { in: VALID_CUSTOMER_STATUSES },
      ...(analysisPeriod
        ? {
            playDate: {
              gte: analysisPeriod.analysisStart,
              lt: analysisPeriod.analysisEndExclusive,
            },
          }
        : {}),
    },
    select: {
      customerKey: true,
      validBooking: true,
      status: true,
      bookingEventKey: true,
      courtType: true,
      playTimeGroup: true,
      startHour: true,
      playDate: true,
      tanggalMain: true,
      netRevenue: true,
      voucherDiscount: true,
      promoName: true,
      promosi: true,
    },
  })
  const history = aggregateSelectedSegmentHistory({ segment, scores, customers, transactions })
  history.rfmProfileScope = "scope_compatible_segmentation_run"
  history.rfmProfileRunId = latestRun?.id ?? null
  history.transactionHistoryScope = analysisPeriod
    ? analysisPeriod.analysisPeriodKey
    : "outreach_scope"
  const membershipOpportunity = buildMembershipOpportunity({
    segmentKey: segment.key,
    ...history,
  })
  if (offer.key === "membership_conversion" && !membershipOpportunity.eligible) {
    const error = new Error(membershipOpportunity.reason)
    error.errorCode = "AI_INVALID_MEMBERSHIP_RECOMMENDATION"
    error.statusCode = 422
    throw error
  }
  const campaignDate = asDateOnly(selected.campaignDate || input.business_context?.date)
  const venueOpportunity = isGeneralStrategy
    ? {
        venueKey: venue.key,
        venueLabel: venue.label,
        sessionKey: session.key,
        sessionLabel: session.label,
        currentOccupancyRate: null,
        availableCourtHours: null,
        occupiedCourtHours: null,
        currentRevenue: null,
        occupancyAvailabilityReason:
          "Campaign-date opportunity is not used in General Strategy.",
      }
    : await buildVenueOpportunity({ venue, session, campaignDate })
  const opportunities = await buildAiBusinessOpportunities({
    selected: {
      ...selected,
      workspaceModeKey,
      campaignObjectiveKey,
      campaignDate,
    },
    venue,
    session,
    segmentKey: segment.key,
    segmentHistory: history,
    selectedSegmentTransactions: transactions,
    analysisPeriod,
    includeFutureSlot: !isGeneralStrategy,
  })
  const selectedScope = {
    workspaceModeKey,
    venueKey: venue.key,
    venueLabel: venue.label,
    segmentKey: segment.key,
    segmentLabel: segment.label,
    campaignObjectiveKey,
    campaignObjectiveLabel: selected.campaignObjectiveLabel || selected.campaignObjective || null,
    offerFrameworkKey: offer.key,
    offerFrameworkLabel: offer.label,
    messageToneKey: normalizeKey(selected.messageToneKey || selected.copyTone || input.promotion_context?.copywritingTone),
    messageToneLabel: selected.messageToneLabel || selected.copyTone || input.promotion_context?.copywritingTone || null,
    channel: selected.channel || "WhatsApp",
    sessionKey: session.key,
    sessionLabel: session.label,
    campaignDate: isGeneralStrategy ? null : campaignDate,
    analysisPeriodKey: analysisPeriod?.analysisPeriodKey || null,
  }
  const dataAvailability = {
    rfmAvailable: true,
    membershipCompositionAvailable: true,
    preferredVenueAvailable: Boolean(history.preferredVenueKey),
    preferredSessionAvailable: Boolean(history.preferredSessionKey),
    occupancyAvailable:
      opportunities.occupancyHistory?.available ??
      opportunities.occupancyOpportunity.available,
    currentRevenueAvailable:
      opportunities.revenueHistory?.available ??
      opportunities.revenueOpportunity.currentRevenue != null,
    revenueGapAvailable: opportunities.revenueOpportunity.available,
    promotionUsageAvailable: opportunities.promotionUsageContext.available,
    futureSlotAvailabilityAvailable:
      !isGeneralStrategy && opportunities.futureSlotOpportunity.available,
    offPeakOpportunityAvailable: opportunities.offPeakOpportunity.available,
    socialMediaPerformanceAvailable: socialMediaPerformance.available,
    promotionConversionAvailable: false,
    campaignAttributionAvailable: false,
    customerResponseRateAvailable: false,
    campaignConversionHistoryAvailable: false,
  }
  const analysisPeriodResponse = serializeAnalysisPeriod(analysisPeriod)

  return {
    analysisPeriod: analysisPeriodResponse,
    analysis_period: analysisPeriodResponse,
    selected_scope: selectedScope,
    selected_segment_history: history,
    membership_opportunity: membershipOpportunity,
    venue_opportunity: venueOpportunity,
    revenue_opportunity: opportunities.revenueOpportunity,
    revenue_history: opportunities.revenueHistory,
    revenue_target_context: {
      available: opportunities.revenueOpportunity.available,
      revenueTarget: opportunities.revenueOpportunity.revenueTarget,
      revenueGap: opportunities.revenueOpportunity.revenueGap,
      revenueAchievementPct:
        opportunities.revenueOpportunity.revenueAchievementPct,
      reason: opportunities.revenueOpportunity.available
        ? null
        : "Revenue target is not configured for this scope.",
    },
    occupancy_opportunity: opportunities.occupancyOpportunity,
    occupancy_history: opportunities.occupancyHistory,
    ...(!isGeneralStrategy
      ? { future_slot_opportunity: opportunities.futureSlotOpportunity }
      : {}),
    promotion_usage_context: opportunities.promotionUsageContext,
    off_peak_opportunity: opportunities.offPeakOpportunity,
    social_media_performance: socialMediaPerformance,
    offer_constraints: {
      exactDiscountAllowed: false,
      approvedDiscountRangePct: null,
    },
    business_opportunity_summary: opportunities.businessOpportunitySummary,
    segment_strategy_guidance: SEGMENT_STRATEGY_GUIDANCE[segment.key],
    business_context: input.business_context || {},
    promotion_context: {
      offerFrameworkKey: offer.key,
      offerFrameworkLabel: offer.label,
    },
    data_availability: dataAvailability,
    analytical_reference: {},
  }
}

// Client-facing projection of the full decision context. The server keeps the
// full context internally (validation depends on data_availability,
// offer_constraints, analysis_period, ...), but the GenAI Workspace UI only
// renders the fields below, so anything else is trimmed from API responses.
export const CLIENT_CONTEXT_FIELDS = [
  "analysis_period",
  "selected_scope",
  "selected_segment_history",
  "membership_opportunity",
  "revenue_history",
  "revenue_target_context",
  "occupancy_history",
  "promotion_usage_context",
  "off_peak_opportunity",
  "social_media_performance",
  "business_opportunity_summary",
]

export const serializeStrategyContextForClient = (context) => {
  if (!context || typeof context !== "object") return null
  return Object.fromEntries(
    CLIENT_CONTEXT_FIELDS
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]])
  )
}
