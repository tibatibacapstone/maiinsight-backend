import { prisma } from "../config/prisma.js"
import { buildCourtHourUsageWhere } from "./dashboardPeriod.service.js"

const SESSION_DEFINITIONS = [
  { name: "Morning", startHour: 6, endHour: 11 },
  { name: "Afternoon", startHour: 12, endHour: 15 },
  { name: "Evening", startHour: 16, endHour: 18 },
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

const mapCourtTypeLabel = (courtType) => COURT_TYPE_LABELS[courtType] || courtType || "Unknown"

const mapCustomerTypeLabel = (bookingTypeDominant) => {
  if (bookingTypeDominant === "member_internal_booking") return "Membership"
  if (bookingTypeDominant === "regular_booking") return "Non Membership"
  return "Mixed/Other"
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

const buildDateRange = (inputDate) => {
  const baseDate = inputDate ? new Date(inputDate) : new Date()
  return {
    date: formatIsoDate(baseDate),
    startDate: startOfDay(baseDate),
    endDate: endOfDay(baseDate),
  }
}

const buildBookingTypeFilter = (customerType) => {
  if (customerType === "membership") return "member_internal_booking"
  if (customerType === "non_membership") return "regular_booking"
  return null
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

export const buildWhatsappMessage = ({
  customerName,
  sessionName,
  date,
  courtType,
  rfmSegmentName,
}) => {
  const safeName = customerName || "Kak"
  const courtLabel = mapCourtTypeLabel(courtType)

  if (rfmSegmentName === "Re-Engagement Players") {
    return `Halo Kak ${safeName}, kami dari Maiin Gandaria. Sudah lama belum main di Maiin. Saat ini ada slot tersedia untuk ${courtLabel} sesi ${sessionName} pada ${date}. Kalau Kakak mau comeback main bareng tim, kami bisa bantu cek jadwalnya.`
  }

  return `Halo Kak ${safeName}, kami dari Maiin Gandaria. Kakak biasanya main di sesi ${sessionName}, dan kebetulan ada slot tersedia untuk ${courtLabel} pada ${date}. Kalau Kakak berminat, kami bisa bantu cek jadwal dan promo yang tersedia.`
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
    if (!transaction.customerKey || !transaction.bookingEventKey || !transaction.playDate) continue

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

    existingCustomer.totalRevenue += toNumber(transaction.netRevenue)
    existingCustomer.allBookingEventKeys.add(bookingEventKey)

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

export const getLowOccupancySessions = async ({ date, courtType = "all", threshold = 40 }) => {
  const { date: selectedDate, startDate, endDate } = buildDateRange(date)
  const courtTypes = courtType === "all" ? ["mini_soccer", "basketball"] : [courtType]

  const usageRows = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate,
      endDate,
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
      playDate: { not: null },
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
      startHour: true,
      courtType: true,
    },
  })

  const potentialTargetBuckets = new Map()

  relevantTransactions.forEach((transaction) => {
    const hour = parseHourValue(transaction.startHour)
    const derivedSessionName = hour === null ? null : resolveSessionNameByHour(hour)
    if (!derivedSessionName || !transaction.courtType) return

    const bucketKey = `${transaction.courtType}:${derivedSessionName}`
    const set = potentialTargetBuckets.get(bucketKey) || new Set()
    set.add(transaction.customerKey)
    potentialTargetBuckets.set(bucketKey, set)
  })

  return courtTypes.flatMap((selectedCourtType) =>
    SESSION_DEFINITIONS.map((session) => {
      const occupiedCourtHours = occupiedBuckets.get(`${selectedCourtType}:${session.name}`) || 0
      const availableCourtHours = session.endHour - session.startHour + 1
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
  date,
  courtType = "all",
  sessionName,
  customerType = "all",
  segmentName = null,
  minSessionBookingCount = 1,
  limit = 50,
  offset = 0,
}) => {
  const { date: selectedDate } = buildDateRange(date)
  const bookingType = buildBookingTypeFilter(customerType)

  const transactions = await prisma.facilityTransaction.findMany({
    where: {
      validBooking: true,
      customerKey: { not: "" },
      playDate: { not: null },
      bookingEventKey: { not: "" },
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
      playDate: true,
      startHour: true,
      bookingEventKey: true,
      courtType: true,
      netRevenue: true,
    },
  })

  const aggregatedCustomers = aggregateCustomerHistory(transactions, sessionName, courtType)
    .filter((customer) => customer.selectedSessionBookingCount >= minSessionBookingCount)

  if (!aggregatedCustomers.length) {
    return {
      date: selectedDate,
      courtType,
      sessionName,
      segmentName,
      customerType,
      customers: [],
      totalCustomers: 0,
      pagination: {
        limit,
        offset,
        returned: 0,
        totalCustomers: 0,
        hasMore: false,
      },
    }
  }

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

  if (!filteredCustomers.length) {
    return {
      date: selectedDate,
      courtType,
      sessionName,
      segmentName,
      customerType,
      customers: [],
      totalCustomers: 0,
      pagination: {
        limit,
        offset,
        returned: 0,
        totalCustomers: 0,
        hasMore: false,
      },
    }
  }

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
        sessionName,
        date: selectedDate,
        courtType,
        rfmSegmentName: customer.rfmSegmentName,
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

  return {
    date: selectedDate,
    courtType,
    sessionName,
    segmentName,
    customerType,
    customers: pagedCustomers,
    totalCustomers: rankedCustomers.length,
    pagination: {
      limit,
      offset,
      returned: pagedCustomers.length,
      totalCustomers: rankedCustomers.length,
      hasMore: offset + pagedCustomers.length < rankedCustomers.length,
    },
  }
}

