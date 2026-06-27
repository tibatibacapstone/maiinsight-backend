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

export const EXCLUDED_IMPORT_BATCH_FILE_NAMES = ["tmp-upload-sample.csv"]

const cloneDate = (value) => new Date(value.getTime())

const startOfDay = (value) => {
  const date = cloneDate(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const endOfDay = (value) => {
  const date = cloneDate(value)
  date.setHours(23, 59, 59, 999)
  return date
}

const addDays = (value, amount) => {
  const date = cloneDate(value)
  date.setDate(date.getDate() + amount)
  return date
}

const isAllMonth = (selectedMonth) =>
  !selectedMonth || selectedMonth === ALL_MONTH_LABEL

export const formatIsoDate = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

export const formatHourLabel = (hourStart) =>
  `${String(hourStart).padStart(2, "0")}:00`

export const getMonthIndex = (selectedMonth) => {
  if (isAllMonth(selectedMonth)) return null

  const monthIndex = MONTH_INDEX_MAP[selectedMonth]

  if (monthIndex === undefined) {
    throw new Error("Invalid month.")
  }

  return monthIndex
}

const getSafeMonthEndDate = (year, monthIndex, today) => {
  const currentYear = today.getFullYear()
  const currentMonthIndex = today.getMonth()

  if (year === currentYear && monthIndex === currentMonthIndex) {
    return endOfDay(today)
  }

  return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999)
}

const getLastVisibleMonthIndex = (selectedYear, today) => {
  const currentYear = today.getFullYear()

  if (selectedYear < currentYear) return 11
  if (selectedYear === currentYear) return today.getMonth()

  return -1
}

const getEffectiveSelectedMonthIndex = (selectedYear, requestedMonthIndex, today) => {
  const currentYear = today.getFullYear()
  const currentMonthIndex = today.getMonth()

  if (selectedYear < currentYear) return requestedMonthIndex
  if (selectedYear === currentYear) return Math.min(requestedMonthIndex, currentMonthIndex)

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
    const lastVisibleMonthIndex = getLastVisibleMonthIndex(year, today)

    if (lastVisibleMonthIndex < 0) return null

    return {
      startDate: startOfDay(new Date(year, 0, 1)),
      endDate: getSafeMonthEndDate(year, lastVisibleMonthIndex, today),
      selectedYear: year,
      selectedMonthIndex: lastVisibleMonthIndex,
      isAllMonth: true,
      periodType,
    }
  }

  const requestedMonthIndex = getMonthIndex(selectedMonth)

  if (periodType === "MTD") {
    if (year > today.getFullYear()) return null

    if (year === today.getFullYear() && requestedMonthIndex > today.getMonth()) {
      return null
    }

    return {
      startDate: startOfDay(new Date(year, requestedMonthIndex, 1)),
      endDate: getSafeMonthEndDate(year, requestedMonthIndex, today),
      selectedYear: year,
      selectedMonthIndex: requestedMonthIndex,
      isAllMonth: false,
      periodType,
    }
  }

  const effectiveMonthIndex = getEffectiveSelectedMonthIndex(year, requestedMonthIndex, today)

  if (effectiveMonthIndex < 0) return null

  return {
    startDate: startOfDay(new Date(year, 0, 1)),
    endDate: getSafeMonthEndDate(year, effectiveMonthIndex, today),
    selectedYear: year,
    selectedMonthIndex: effectiveMonthIndex,
    isAllMonth: false,
    periodType,
  }
}

export const getPreviousComparisonRange = ({ startDate, endDate }) => {
  const safeStartDate = startOfDay(startDate)
  const safeEndDate = endOfDay(endDate)
  const durationMs = safeEndDate.getTime() - safeStartDate.getTime()
  const totalDays = Math.max(1, Math.round(durationMs / 86400000) + 1)

  const previousEndDate = endOfDay(addDays(safeStartDate, -1))
  const previousStartDate = startOfDay(addDays(safeStartDate, -totalDays))

  return {
    startDate: previousStartDate,
    endDate: previousEndDate,
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
  const explicitBookingType = String(bookingType ?? "").trim().toLowerCase()

  if (
    explicitBookingType === "regular_booking" ||
    explicitBookingType === "member_internal_booking"
  ) {
    return explicitBookingType
  }

  const legacyCustomerType = String(customerType ?? "").trim().toLowerCase()

  if (
    legacyCustomerType === "membership" ||
    legacyCustomerType === "regular booking" ||
    legacyCustomerType === "regular_booking"
  ) {
    return "regular_booking"
  }

  if (
    legacyCustomerType === "non membership" ||
    legacyCustomerType === "manual/walk-in" ||
    legacyCustomerType === "manual walk-in" ||
    legacyCustomerType === "member_internal_booking"
  ) {
    return "member_internal_booking"
  }

  return null
}

export const getCourtCount = (courtType) => (courtType ? 1 : 2)

export const getAvailableCourtHours = (startDate, endDate, courtCount) => {
  const safeStartDate = startOfDay(startDate)
  const safeEndDate = endOfDay(endDate)
  const totalDays =
    Math.max(0, Math.round((safeEndDate.getTime() - safeStartDate.getTime()) / 86400000)) + 1

  return totalDays * 18 * courtCount
}

export const buildFacilityTransactionWhere = ({
  startDate,
  endDate,
  courtType,
  customerType,
  bookingType,
  requireValidBooking = true,
}) => {
  const normalizedBookingType = normalizeBookingTypeFilter({
    customerType,
    bookingType,
  })

  const where = {
    batch: {
      fileName: {
        notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
      },
    },
  }

  if (startDate || endDate) {
    where.playDate = {}

    if (startDate) where.playDate.gte = startDate
    if (endDate) where.playDate.lte = endDate
  }

  if (requireValidBooking) {
    where.validBooking = true
  }

  if (courtType) {
    where.courtType = courtType
  }

  if (normalizedBookingType) {
    where.bookingType = normalizedBookingType
  }

  return where
}

export const buildCourtHourUsageWhere = ({
  startDate,
  endDate,
  courtType,
  customerType,
  bookingType,
  requireValidBooking = true,
}) => {
  const normalizedBookingType = normalizeBookingTypeFilter({
    customerType,
    bookingType,
  })

  const where = {
    transaction: {
      batch: {
        fileName: {
          notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
        },
      },
    },
  }

  if (startDate || endDate) {
    where.playDate = {}

    if (startDate) where.playDate.gte = startDate
    if (endDate) where.playDate.lte = endDate
  }

  if (courtType) {
    where.courtType = courtType
  }

  if (requireValidBooking) {
    where.transaction.validBooking = true
  }

  if (normalizedBookingType) {
    where.transaction.bookingType = normalizedBookingType
  }

  return where
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

    const endDate = getSafeMonthEndDate(year, monthIndex, today)
    const lastDay = endDate.getDate()

    return Array.from({ length: lastDay }, (_, index) => {
      const day = index + 1
      const startDate = startOfDay(new Date(year, monthIndex, day))
      const dayEndDate = endOfDay(new Date(year, monthIndex, day))

      return {
        label: `${day} ${selectedMonth}`,
        date: formatIsoDate(startDate),
        startDate,
        endDate: dayEndDate,
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
      startDate: startOfDay(new Date(year, 0, 1)),
      endDate: getSafeMonthEndDate(year, monthIndex, today),
    }))
  }

  if (isAllMonth(selectedMonth) && periodType === "MTD") {
    const lastVisibleMonthIndex = getLastVisibleMonthIndex(year, today)

    if (lastVisibleMonthIndex < 0) return []

    return MONTH_LABELS.slice(0, lastVisibleMonthIndex + 1).map((label, monthIndex) => ({
      label,
      month: label,
      startDate: startOfDay(new Date(year, monthIndex, 1)),
      endDate: getSafeMonthEndDate(year, monthIndex, today),
    }))
  }

  const lastVisibleMonthIndex = getLastVisibleMonthIndex(year, today)

  if (lastVisibleMonthIndex < 0) return []

  return MONTH_LABELS.slice(0, lastVisibleMonthIndex + 1).map((label, monthIndex) => ({
    label,
    month: label,
    startDate: startOfDay(new Date(year, 0, 1)),
    endDate: getSafeMonthEndDate(year, monthIndex, today),
  }))
}

export const getWeekdayLabel = (date) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()]


