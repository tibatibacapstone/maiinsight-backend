import { prisma } from "../config/prisma.js"
import { buildCourtHourUsageWhere, getCourtCount } from "./dashboardPeriod.service.js"
import { buildEmptySlotHeatmap } from "./emptySlotHeatmap.service.js"
import {
  CANONICAL_TRANSACTION_STATUSES,
  DASHBOARD_TRANSACTION_GROUPS,
  getDashboardTransactionGroup,
  isEligibleCustomerStatus,
} from "./transactionStatus.service.js"

const SESSION_DEFINITIONS = [
  { name: "Morning", startHour: 6, endHour: 10 },
  { name: "Afternoon", startHour: 11, endHour: 14 },
  { name: "Evening", startHour: 15, endHour: 18 },
  { name: "Night", startHour: 19, endHour: 23 },
]

const COURT_TYPE_LABELS = {
  mini_soccer: "Mini Soccer",
  basketball: "Basketball",
  all: "All Court Types",
}

const RFM_SEGMENT_SCORE = {
  "Prime Players": 100,
  "Routine Players": 85,
  "Growth Players": 70,
  "Re-Engagement Players": 55,
}

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const toNumber = (value) => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber()
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundNumber = (value, precision = 2) => Number(value.toFixed(precision))

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const endOfDay = (value) => {
  const date = new Date(value)
  date.setHours(23, 59, 59, 999)
  return date
}

const formatIsoDate = (value) => {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

const parseHourValue = (value) => {
  if (!hasValue(value)) return null

  const text = String(value).trim()
  const [hourText] = text.split(":")
  const parsed = Number(hourText)

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return null
  return parsed
}

export const getSessionDefinitionByName = (sessionName) =>
  SESSION_DEFINITIONS.find((session) => session.name === sessionName) || null

export const resolveSessionNameByHour = (hour) => {
  const session = SESSION_DEFINITIONS.find(
    (candidate) => hour >= candidate.startHour && hour <= candidate.endHour
  )

  return session?.name || null
}

export const sumCampaignRevenue = (rows) => {
  let revenue = 0
  const revenueEvents = new Set()

  for (const row of rows) {
    const group = getDashboardTransactionGroup(row.transaction?.status)
    if (
      group === DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING ||
      group === DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN ||
      group === DASHBOARD_TRANSACTION_GROUPS.INTERNAL
    ) {
      const eventKey = row.transaction?.bookingEventKey
      if (!revenueEvents.has(eventKey)) {
        revenueEvents.add(eventKey)
        revenue += toNumber(row.transaction?.netRevenue)
      }
    }
  }

  return revenue
}

const mapCourtTypeLabel = (courtType) => COURT_TYPE_LABELS[courtType] || courtType || "Unknown"

const mapCustomerTypeLabel = (bookingTypeDominant) => {
  if (bookingTypeDominant === "Manual/Walk-in") return "Membership"
  if (bookingTypeDominant === "GeloraApp Booking") return "Non Membership"
  return bookingTypeDominant || "Mixed/Other"
}

const buildCustomerDisplayName = (transaction) =>
  transaction.customerName || transaction.nama || transaction.normalizedName || transaction.customerKey

const normalizeText = (value) => (hasValue(value) ? String(value).trim() : null)

const resolveContactInfo = (existingContact, transaction) => {
  const phone = normalizeText(transaction.normalizedPhone) || normalizeText(transaction.noTelepon)
  const email = normalizeText(transaction.normalizedEmail) || normalizeText(transaction.email)

  if (!existingContact) {
    return { phone, email }
  }

  return {
    phone: existingContact.phone || phone,
    email: existingContact.email || email,
  }
}

const buildDateRange = ({ date = null, startDate: requestedStartDate = null, endDate: requestedEndDate = null } = {}) => {
  const start = requestedStartDate || date || formatIsoDate(new Date())
  const end = requestedEndDate || date || start
  const startValue = new Date(start)
  const endValue = new Date(end)
  return {
    date: start === end ? formatIsoDate(startValue) : formatIsoDate(startValue) + " to " + formatIsoDate(endValue),
    startDate: startOfDay(startValue),
    endDate: endOfDay(endValue),
  }
}

const buildBookingTypeFilter = (customerType) => {
  if (customerType === "membership") return "Manual/Walk-in"
  if (customerType === "non_membership") return "GeloraApp Booking"
  return null
}

const CAMPAIGN_VALID_PLAY_DATE_WHERE = {
  validBooking: true,
  customerKey: { not: "" },
  status: {
    in: [
      CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
      CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
    ],
  },
  netRevenue: { gt: 0 },
  NOT: {
    customerKey: {
      startsWith: "SYS-",
    },
  },
  bookingEventKey: { not: "" },
  playDate: { not: null },
  batch: {
    fileName: {
      not: "tmp-upload-sample.csv",
    },
  },
}

export const getLatestCampaignPlayDate = async (database = prisma) => {
  const result = await database.facilityTransaction.aggregate({
    where: CAMPAIGN_VALID_PLAY_DATE_WHERE,
    _max: { playDate: true },
  })

  return result?._max?.playDate || null
}

export const buildCampaignAnalysisRange = (latestPlayDate, analysisPeriodMonths) => {
  if (!latestPlayDate) return null

  const analysisEnd = endOfDay(latestPlayDate)
  return {
    analysisStart: new Date(
      analysisEnd.getFullYear(),
      analysisEnd.getMonth() - analysisPeriodMonths + 1,
      1
    ),
    analysisEnd,
  }
}

const getJakartaWeekdayIndex = (value) => {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
  }).format(new Date(value))
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(weekday)
}

export const matchesCampaignPlayContext = ({
  playDate,
  startHour,
  campaignDay,
  sessionName,
  rangeStart = null,
  rangeEnd = null,
}) => {
  if (!playDate) return false

  const date = new Date(playDate)
  if (rangeStart && date < rangeStart) return false
  if (rangeEnd && date > rangeEnd) return false

  const dayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(campaignDay)
  return (
    getJakartaWeekdayIndex(date) === dayIndex &&
    resolveSessionNameByHour(parseHourValue(startHour)) === sessionName
  )
}

const bucketRecencyScore = (recencyDays) => {
  if (recencyDays <= 30) return 100
  if (recencyDays <= 90) return 80
  if (recencyDays <= 180) return 60
  return 30
}

const getRfmSegmentWeight = (segmentName) => {
  if (!segmentName) return 50
  return RFM_SEGMENT_SCORE[segmentName] || 50
}

export const buildTargetPriorityScore = ({
  selectedSessionBookingCount,
  selectedCourtBookingCount,
  totalBookingCount,
  recencyDays,
  rfmSegmentName,
  hasPhone,
  hasEmail,
  maxSelectedSessionBookingCount,
  maxSelectedCourtBookingCount,
  maxTotalBookingCount,
}) => {
  const safeTotal = Math.max(totalBookingCount, 1)
  const sessionIntensity = maxSelectedSessionBookingCount > 0
    ? selectedSessionBookingCount / maxSelectedSessionBookingCount
    : 0
  const sessionShare = selectedSessionBookingCount / safeTotal
  const sessionScore = (sessionIntensity * 0.7 + sessionShare * 0.3) * 100

  const courtIntensity = maxSelectedCourtBookingCount > 0
    ? (selectedCourtBookingCount / maxSelectedCourtBookingCount) * 100
    : 0

  const recencyScore = bucketRecencyScore(recencyDays)
  const rfmScore = getRfmSegmentWeight(rfmSegmentName)
  const frequencyScore = maxTotalBookingCount > 0
    ? (totalBookingCount / maxTotalBookingCount) * 100
    : 0
  const contactScore = hasPhone ? 100 : hasEmail ? 60 : 10

  return roundNumber(
    sessionScore * 0.35 +
      courtIntensity * 0.2 +
      recencyScore * 0.15 +
      rfmScore * 0.15 +
      frequencyScore * 0.1 +
      contactScore * 0.05,
    2
  )
}

export const buildTargetPriorityLabel = (score) => {
  if (score >= 75) return "High Priority"
  if (score >= 50) return "Medium Priority"
  return "Low Priority"
}

export const buildSuggestedAction = ({ customerTypeLabel, rfmSegmentName }) => {
  if (rfmSegmentName === "Prime Players") {
    return "Give VIP priority slot access and personalized loyalty perks."
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Routine Players") {
    return "Offer session promo or repeat booking package."
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Growth Players") {
    return "Send follow-up promo to encourage repeat booking."
  }

  if (customerTypeLabel === "Membership" && rfmSegmentName === "Routine Players") {
    return "Offer priority slot reminder or membership package maintenance."
  }

  if (rfmSegmentName === "Re-Engagement Players") {
    return "Send comeback offer or low-touch reactivation message."
  }

  return "Offer available slot reminder."
}

const buildBookingHistoryPhrase = ({ totalBookingCount, recencyDays }) => {
  if (!Number.isFinite(recencyDays) || recencyDays >= 999) {
    return "Ini kesempatan pertama kami hubungi Kakak"
  }

  const timesPhrase = totalBookingCount > 1 ? `sudah ${totalBookingCount}x booking` : "pernah booking"
  const recencyPhrase =
    recencyDays <= 3
      ? "beberapa hari lalu"
      : recencyDays <= 30
        ? `sekitar ${recencyDays} hari lalu`
        : recencyDays <= 180
          ? `sekitar ${Math.round(recencyDays / 30)} bulan lalu`
          : "cukup lama"

  return `Kakak ${timesPhrase} bareng kami, terakhir ${recencyPhrase}`
}

export const buildWhatsappMessage = ({
  customerName,
  preferredSession,
  courtType,
  rfmSegmentName,
  customerTypeLabel,
  totalBookingCount,
  recencyDays,
}) => {
  const safeName = customerName || "Kak"
  const courtLabel = mapCourtTypeLabel(courtType)
  const sessionPhrase = preferredSession ? `sesi ${preferredSession}` : "jadwal yang biasa Kakak pilih"
  const historyPhrase = buildBookingHistoryPhrase({ totalBookingCount, recencyDays })

  if (rfmSegmentName === "Prime Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase}, jadi kami mau kasih Kakak akses prioritas untuk slot ${courtLabel} di ${sessionPhrase}. Kabari kami ya kalau mau kami bantu amankan jadwalnya duluan.`
  }

  if (rfmSegmentName === "Re-Engagement Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase}, kami kangen main bareng Kakak lagi. Saat ini ada slot ${courtLabel} tersedia di ${sessionPhrase}. Yuk balik main bareng tim, kami siapin promo comeback khusus buat Kakak.`
  }

  if (customerTypeLabel === "Membership" && rfmSegmentName === "Routine Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Sebagai member rutin, kami mau ingetin ada slot ${courtLabel} yang bisa Kakak amankan lagi sesuai jadwal favorit.`
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Growth Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada slot ${courtLabel} tersedia, plus promo khusus kalau Kakak booking lagi.`
  }

  if (customerTypeLabel === "Non Membership" && rfmSegmentName === "Routine Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada paket booking berulang yang bisa bikin Kakak lebih hemat kalau mau main rutin di sesi ini.`
  }

  return `Halo Kak ${safeName}, kami dari Maiin Gandaria. ${historyPhrase} di ${sessionPhrase}. Ada slot ${courtLabel} tersedia, kalau Kakak berminat kami bisa bantu cek jadwal dan promo yang ada.`
}

const buildSegmentMap = async (customerKeys) => {
  if (!customerKeys.length) return new Map()

  const latestRun = await prisma.segmentationRun.findFirst({
    where: { status: "completed" },
    orderBy: { runDate: "desc" },
    select: { id: true },
  })

  if (!latestRun) return new Map()

  const scores = await prisma.customerRfmScore.findMany({
    where: {
      runId: latestRun.id,
      customerKey: { in: customerKeys },
    },
    select: {
      customerKey: true,
      segmentName: true,
    },
  })

  return new Map(scores.map((score) => [score.customerKey, score.segmentName]))
}

const aggregateCustomerHistory = (transactions, sessionName, courtType) => {
  const customerMap = new Map()

  for (const transaction of transactions) {
    if (
      !transaction.customerKey ||
      transaction.customerKey.startsWith("SYS-") ||
      !isEligibleCustomerStatus(transaction.status) ||
      toNumber(transaction.netRevenue) <= 0 ||
      !transaction.bookingEventKey ||
      !transaction.playDate
    ) {
      continue
    }

    const playDate = new Date(transaction.playDate)
    const bookingEventKey = transaction.bookingEventKey
    const hour = parseHourValue(transaction.startHour)
    const derivedSessionName = hour === null ? null : resolveSessionNameByHour(hour)
    const existingCustomer = customerMap.get(transaction.customerKey) || {
      customerKey: transaction.customerKey,
      customerName: buildCustomerDisplayName(transaction),
      phone: null,
      email: null,
      latestPlayDate: null,
      totalRevenue: 0,
      bookingTypeCounts: new Map(),
      sessionCounts: new Map(),
      allBookingEventKeys: new Set(),
      selectedSessionEventKeys: new Set(),
      selectedCourtEventKeys: new Set(),
    }

    const contactInfo = resolveContactInfo({ phone: existingCustomer.phone, email: existingCustomer.email }, transaction)
    existingCustomer.phone = contactInfo.phone
    existingCustomer.email = contactInfo.email

    if (!existingCustomer.latestPlayDate || playDate > existingCustomer.latestPlayDate) {
      existingCustomer.latestPlayDate = playDate
    }

    if (!existingCustomer.allBookingEventKeys.has(bookingEventKey)) {
      existingCustomer.allBookingEventKeys.add(bookingEventKey)
      existingCustomer.totalRevenue += toNumber(transaction.netRevenue)
    }

    if (!existingCustomer.bookingTypeCounts.has(bookingEventKey)) {
      existingCustomer.bookingTypeCounts.set(bookingEventKey, transaction.bookingType || "other")
    }

    if (derivedSessionName) {
      const sessionEventKey = `${derivedSessionName}:${bookingEventKey}`
      if (!existingCustomer.sessionCounts.has(sessionEventKey)) {
        existingCustomer.sessionCounts.set(sessionEventKey, derivedSessionName)
      }

      if (derivedSessionName === sessionName) {
        existingCustomer.selectedSessionEventKeys.add(bookingEventKey)
      }
    }

    if (transaction.courtType && (!courtType || courtType === "all" || transaction.courtType === courtType)) {
      existingCustomer.selectedCourtEventKeys.add(bookingEventKey)
    }

    customerMap.set(transaction.customerKey, existingCustomer)
  }

  return [...customerMap.values()].map((customer) => {
    const bookingTypeCounter = new Map()
    customer.bookingTypeCounts.forEach((bookingType) => {
      bookingTypeCounter.set(bookingType, (bookingTypeCounter.get(bookingType) || 0) + 1)
    })

    const sortedBookingTypes = [...bookingTypeCounter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })

    const bookingTypeDominant = sortedBookingTypes[0]?.[0] || "other"
    const preferredSessionCounter = new Map()

    customer.sessionCounts.forEach((sessionNameValue) => {
      preferredSessionCounter.set(
        sessionNameValue,
        (preferredSessionCounter.get(sessionNameValue) || 0) + 1
      )
    })

    const preferredSession = [...preferredSessionCounter.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })[0]?.[0] || null

    const totalBookingCount = customer.allBookingEventKeys.size
    const selectedSessionBookingCount = customer.selectedSessionEventKeys.size
    const selectedCourtBookingCount = customer.selectedCourtEventKeys.size
    const avgSpend = totalBookingCount > 0 ? customer.totalRevenue / totalBookingCount : 0

    return {
      customerKey: customer.customerKey,
      customerName: customer.customerName,
      phone: customer.phone,
      email: customer.email,
      bookingTypeDominant,
      customerTypeLabel: mapCustomerTypeLabel(bookingTypeDominant),
      preferredSession,
      selectedSessionBookingCount,
      selectedCourtBookingCount,
      totalBookingCount,
      lastBookingDate: customer.latestPlayDate ? formatIsoDate(customer.latestPlayDate) : null,
      latestPlayDate: customer.latestPlayDate,
      avgSpend: roundNumber(avgSpend),
      totalRevenue: roundNumber(customer.totalRevenue),
    }
  })
}

export const getLowOccupancySessions = async ({ date, startDate: requestedStartDate, endDate: requestedEndDate, campaignDay = null, analysisPeriodMonths = 3, courtType = "all", threshold = 40 }) => {
  const { date: selectedDate, startDate, endDate } = buildDateRange({ date, startDate: requestedStartDate, endDate: requestedEndDate })
  const courtTypes = courtType === "all" ? ["mini_soccer", "basketball"] : [courtType]
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  const effectiveCampaignDay = campaignDay || weekdayNames[getJakartaWeekdayIndex(startDate)]
  const campaignDayIndex = weekdayNames.indexOf(effectiveCampaignDay)
  const analysisRange = buildCampaignAnalysisRange(endDate, analysisPeriodMonths)

  const usageRows = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate,
      endDateExclusive: new Date(endDate.getTime() + 1),
      courtType: courtType === "all" ? null : courtType,
    }),
    select: {
      courtType: true,
      hourStart: true,
      courtHourKey: true,
    },
  })

  const occupiedBuckets = new Map()

  usageRows.forEach((row) => {
    const hour = parseHourValue(row.hourStart)
    if (hour === null || !row.courtType) return

    const derivedSessionName = resolveSessionNameByHour(hour)
    if (!derivedSessionName) return

    const bucketKey = `${row.courtType}:${derivedSessionName}`
    occupiedBuckets.set(bucketKey, (occupiedBuckets.get(bucketKey) || 0) + 1)
  })

  const relevantTransactions = await prisma.facilityTransaction.findMany({
    where: {
      validBooking: true,
      customerKey: { not: "" },
      playDate: { gte: analysisRange.analysisStart, lte: analysisRange.analysisEnd },
      status: {
        in: [
          CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
          CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
        ],
      },
      netRevenue: { gt: 0 },
      NOT: {
        customerKey: {
          startsWith: "SYS-",
        },
      },
      bookingEventKey: { not: "" },
      ...(courtType === "all" ? {} : { courtType }),
      batch: {
        fileName: {
          not: "tmp-upload-sample.csv",
        },
      },
    },
    select: {
      customerKey: true,
      status: true,
      netRevenue: true,
      startHour: true,
      playDate: true,
      courtType: true,
    },
  })

  const potentialTargetBuckets = new Map()

  relevantTransactions.forEach((transaction) => {
    const hour = parseHourValue(transaction.startHour)
    const derivedSessionName = hour === null ? null : resolveSessionNameByHour(hour)
    if (!derivedSessionName || !transaction.courtType) return
    if (campaignDayIndex >= 0 && getJakartaWeekdayIndex(transaction.playDate) !== campaignDayIndex) return

    const bucketKey = `${transaction.courtType}:${derivedSessionName}`
    const set = potentialTargetBuckets.get(bucketKey) || new Set()
    set.add(transaction.customerKey)
    potentialTargetBuckets.set(bucketKey, set)
  })

  return courtTypes.flatMap((selectedCourtType) =>
    SESSION_DEFINITIONS.map((session) => {
      const occupiedCourtHours = occupiedBuckets.get(`${selectedCourtType}:${session.name}`) || 0
      const sessionDurationHours = session.endHour - session.startHour + 1
      const dayCount = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime() + 1) / 86400000))
      const courtCount = getCourtCount(selectedCourtType)
      const availableCourtHours = sessionDurationHours * courtCount * dayCount
      const occupancyRate = availableCourtHours > 0
        ? roundNumber((occupiedCourtHours / availableCourtHours) * 100)
        : 0

      return {
        date: selectedDate,
        courtType: selectedCourtType,
        courtTypeLabel: mapCourtTypeLabel(selectedCourtType),
        sessionName: session.name,
        sessionStartHour: `${String(session.startHour).padStart(2, "0")}:00`,
        sessionEndHour: `${String(session.endHour).padStart(2, "0")}:59`,
        occupiedCourtHours,
        availableCourtHours,
        occupancyRate,
        status: occupancyRate < threshold ? "Low" : "Normal",
        potentialTargetCount: (potentialTargetBuckets.get(`${selectedCourtType}:${session.name}`) || new Set()).size,
      }
    })
  )
}

export const getRecommendedCustomers = async ({
  campaignDay = "Monday",
  analysisPeriodMonths = 3,
  courtType = "all",
  sessionName,
  customerType = "all",
  segmentName = null,
  limit = 50,
  offset = 0,
}) => {
  const latestPlayDate = await getLatestCampaignPlayDate(prisma)
  if (!latestPlayDate) {
    return { campaignDay, analysisPeriodMonths, latestPlayDate: null, unavailableReason: "LATEST_PLAY_DATE_NOT_AVAILABLE", monthlyPerformance: [], historicalSummary: null, courtType, sessionName, segmentName, customerType, customers: [], totalCustomers: 0, pagination: { limit, offset, returned: 0, totalCustomers: 0, hasMore: false } }
  }
  const { analysisStart, analysisEnd } = buildCampaignAnalysisRange(
    latestPlayDate,
    analysisPeriodMonths
  )
  const selectedDate = formatIsoDate(latestPlayDate)
  const bookingType = buildBookingTypeFilter(customerType)
  const dayIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(campaignDay)
  const session = getSessionDefinitionByName(sessionName)

  const transactions = await prisma.facilityTransaction.findMany({
    where: {
      validBooking: true,
      customerKey: { not: "" },
      status: {
        in: [
          CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
          CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
        ],
      },
      netRevenue: { gt: 0 },
      NOT: {
        customerKey: {
          startsWith: "SYS-",
        },
      },
      bookingEventKey: { not: "" },
      playDate: { gte: analysisStart, lte: analysisEnd },
      ...(bookingType ? { bookingType } : {}),
      ...(courtType && courtType !== "all" ? { courtType } : {}),
      batch: {
        fileName: {
          not: "tmp-upload-sample.csv",
        },
      },
    },
    orderBy: [{ customerKey: "asc" }, { playDate: "desc" }, { bookingEventKey: "asc" }],
    select: {
      customerKey: true,
      customerName: true,
      normalizedName: true,
      nama: true,
      normalizedPhone: true,
      noTelepon: true,
      normalizedEmail: true,
      email: true,
      bookingType: true,
      status: true,
      playDate: true,
      startHour: true,
      bookingEventKey: true,
      courtType: true,
      netRevenue: true,
    },
  })

  const campaignTransactions = transactions.filter((transaction) =>
    matchesCampaignPlayContext({
      playDate: transaction.playDate,
      startHour: transaction.startHour,
      campaignDay,
      sessionName,
    })
  )
  const aggregatedCustomers = aggregateCustomerHistory(campaignTransactions, sessionName, courtType)

  const segmentByCustomerKey = await buildSegmentMap(
    aggregatedCustomers.map((customer) => customer.customerKey)
  )

  const filteredCustomers = aggregatedCustomers
    .map((customer) => {
      const rfmSegmentName = segmentByCustomerKey.get(customer.customerKey) || null
      const recencyDays = customer.latestPlayDate
        ? Math.max(
            0,
            Math.round(
              (startOfDay(new Date(selectedDate)).getTime() -
                startOfDay(customer.latestPlayDate).getTime()) /
                86400000
            )
          )
        : 999

      return {
        ...customer,
        recencyDays,
        rfmSegmentName,
      }
    })
    .filter((customer) => (segmentName ? customer.rfmSegmentName === segmentName : true))

  const maxSelectedSessionBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.selectedSessionBookingCount),
    0
  )
  const maxSelectedCourtBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.selectedCourtBookingCount),
    0
  )
  const maxTotalBookingCount = Math.max(
    ...filteredCustomers.map((customer) => customer.totalBookingCount),
    0
  )

  const rankedCustomers = filteredCustomers
    .map((customer) => {
      const targetPriorityScore = buildTargetPriorityScore({
        selectedSessionBookingCount: customer.selectedSessionBookingCount,
        selectedCourtBookingCount: customer.selectedCourtBookingCount,
        totalBookingCount: customer.totalBookingCount,
        recencyDays: customer.recencyDays,
        rfmSegmentName: customer.rfmSegmentName,
        hasPhone: Boolean(customer.phone),
        hasEmail: Boolean(customer.email),
        maxSelectedSessionBookingCount,
        maxSelectedCourtBookingCount,
        maxTotalBookingCount,
      })
      const targetPriorityLabel = buildTargetPriorityLabel(targetPriorityScore)
      const suggestedAction = buildSuggestedAction({
        customerTypeLabel: customer.customerTypeLabel,
        rfmSegmentName: customer.rfmSegmentName,
      })
      const whatsappMessage = buildWhatsappMessage({
        customerName: customer.customerName,
        preferredSession: customer.preferredSession,
        courtType,
        rfmSegmentName: customer.rfmSegmentName,
        customerTypeLabel: customer.customerTypeLabel,
        totalBookingCount: customer.totalBookingCount,
        recencyDays: customer.recencyDays,
      })

      return {
        customerKey: customer.customerKey,
        customerName: customer.customerName,
        phone: customer.phone,
        email: customer.email,
        customerTypeLabel: customer.customerTypeLabel,
        bookingTypeDominant: customer.bookingTypeDominant,
        preferredSession: customer.preferredSession,
        selectedSessionBookingCount: customer.selectedSessionBookingCount,
        selectedCourtBookingCount: customer.selectedCourtBookingCount,
        totalBookingCount: customer.totalBookingCount,
        lastBookingDate: customer.lastBookingDate,
        recencyDays: customer.recencyDays,
        avgSpend: customer.avgSpend,
        totalRevenue: customer.totalRevenue,
        rfmSegmentName: customer.rfmSegmentName || "Not segmented",
        targetPriorityScore,
        targetPriorityLabel,
        suggestedAction,
        whatsappMessage,
      }
    })
    .sort((left, right) => {
      if (right.targetPriorityScore !== left.targetPriorityScore) {
        return right.targetPriorityScore - left.targetPriorityScore
      }

      if (right.selectedSessionBookingCount !== left.selectedSessionBookingCount) {
        return right.selectedSessionBookingCount - left.selectedSessionBookingCount
      }

      return (left.customerName || left.customerKey).localeCompare(
        right.customerName || right.customerKey
      )
    })

  const pagedCustomers = rankedCustomers.slice(offset, offset + limit)

  const capacityCourtCount = courtType === "all" ? 2 : 1
  const allUsage = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate: analysisStart,
      endDateExclusive: new Date(analysisEnd.getTime() + 1),
      courtType: courtType === "all" ? null : courtType,
      customerType: "all",
      bookingType: "all",
      includeOperational: true,
    }),
    select: { courtHourKey: true, playDate: true, hourStart: true, transaction: { select: { status: true, netRevenue: true, bookingEventKey: true } } },
  })
  const monthlyPerformance = []
  for (let offsetMonth = analysisPeriodMonths - 1; offsetMonth >= 0; offsetMonth -= 1) {
    const monthStart = new Date(analysisEnd.getFullYear(), analysisEnd.getMonth() - offsetMonth, 1)
    const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)
    const monthEnd = nextMonth > analysisEnd ? analysisEnd : new Date(nextMonth.getTime() - 1)
    const matching = allUsage.filter((row) => {
      const playDate = new Date(row.playDate)
      const hour = parseHourValue(row.hourStart)
      return playDate >= monthStart && playDate <= monthEnd && getJakartaWeekdayIndex(playDate) === dayIndex && (!session || (hour >= session.startHour && hour <= session.endHour))
    })
    const monthUsage = allUsage.filter((row) => new Date(row.playDate) >= monthStart && new Date(row.playDate) <= monthEnd)
    const heatmap = buildEmptySlotHeatmap({ usageRows: monthUsage, startDate: monthStart, endDate: monthEnd, courtCount: capacityCourtCount })
    const dayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayIndex]
    const campaignCells = heatmap.slots.filter((cell) => {
      const hour = parseHourValue(cell.startHour)
      return cell.day_short === dayShort && (!session || (hour >= session.startHour && hour <= session.endHour))
    })
    const occupiedSlots = campaignCells.reduce((sum, cell) => sum + cell.occupiedSlots, 0)
    const totalPossibleSlots = campaignCells.reduce((sum, cell) => sum + cell.totalPossibleSlots, 0)
    const revenue = sumCampaignRevenue(matching)
    const emptySlots = Math.max(0, totalPossibleSlots - occupiedSlots)
    monthlyPerformance.push({
      month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`,
      monthLabel: monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }),
      dataThrough: formatIsoDate(monthEnd), totalPossibleSlots, occupiedSlots, emptySlots,
      occupancyRate: totalPossibleSlots > 0 ? roundNumber((occupiedSlots / totalPossibleSlots) * 100, 1) : null,
      revenue: roundNumber(revenue),
    })
  }
  const availableMonths = monthlyPerformance.filter((month) => month.occupancyRate !== null)
  const totalRevenue = monthlyPerformance.reduce((sum, month) => sum + month.revenue, 0)
  const historicalSummary = {
    analysisPeriodMonths,
    averageOccupancy: availableMonths.length ? roundNumber(availableMonths.reduce((sum, month) => sum + month.occupancyRate, 0) / availableMonths.length, 1) : null,
    averageFilledSlots: roundNumber(monthlyPerformance.reduce((sum, month) => sum + month.occupiedSlots, 0) / monthlyPerformance.length, 1),
    totalRevenue: roundNumber(totalRevenue),
    averageMonthlyRevenue: roundNumber(totalRevenue / monthlyPerformance.length),
  }

  return {
    campaignDay, analysisPeriodMonths, latestPlayDate: selectedDate, unavailableReason: null,
    courtType,
    sessionName,
    segmentName,
    customerType,
    customers: pagedCustomers,
    totalCustomers: rankedCustomers.length,
    monthlyPerformance,
    historicalSummary,
    pagination: {
      limit,
      offset,
      returned: pagedCustomers.length,
      totalCustomers: rankedCustomers.length,
      hasMore: offset + pagedCustomers.length < rankedCustomers.length,
    },
  }
}

