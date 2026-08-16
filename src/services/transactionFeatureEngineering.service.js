const PLACEHOLDER_VALUES = new Set([
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "unknown",
  "tidak ada",
])

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const isPlaceholder = (value) => PLACEHOLDER_VALUES.has(normalizeWhitespace(value).toLowerCase())

export const normalizeCustomerEmail = (value) => {
  const email = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase()

  if (!email || isPlaceholder(email)) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export const normalizeCustomerName = (value) => {
  const name = normalizeWhitespace(value)
  if (!name || isPlaceholder(name)) return null
  return name.toUpperCase()
}

export const normalizeCustomerPhone = (value) => {
  if (value === null || value === undefined || value === "") return null

  const text = String(value ?? "").trim()
  if (isPlaceholder(text)) return null
  if (/e[+-]?\d+/i.test(text)) return null

  const digits = text.replace(/\D/g, "").replace(/^0+/, "")
  if (digits.length < 8 || digits.length > 15) return null
  if (/^(\d)\1+$/.test(digits)) return null
  if (/^(?:12345678|123456789|1234567890)$/.test(digits)) return null
  if (/^6(?:2|28|29)0{8,}$/.test(digits)) return null

  return digits
}

export const buildCustomerIdentity = ({ email, name, phone }) => {
  const normalizedEmail = normalizeCustomerEmail(email)
  const normalizedName = normalizeCustomerName(name)
  const normalizedPhone = normalizeCustomerPhone(phone)

  if (normalizedEmail) {
    return {
      customerIdentity: `EMAIL|${normalizedEmail}`,
      customerKeyType: "email",
      customerKeyConfidence: "high",
      normalizedEmail,
      normalizedName,
      normalizedPhone,
    }
  }

  if (normalizedPhone) {
    return {
      customerIdentity: `PHONE|${normalizedPhone}`,
      customerKeyType: "phone",
      customerKeyConfidence: "medium",
      normalizedEmail,
      normalizedName,
      normalizedPhone,
    }
  }

  if (normalizedName) {
    return {
      customerIdentity: `NAME|${normalizedName}`,
      customerKeyType: "name",
      customerKeyConfidence: "low",
      normalizedEmail,
      normalizedName,
      normalizedPhone,
    }
  }

  return null
}

export const formatCustomerKey = (customerId) => {
  const numericId = Number(customerId)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error("Cannot generate a customer key without a persisted customer ID.")
  }

  return `CUST-${String(numericId).padStart(5, "0")}`
}

const getCourtCode = ({ court, courtType }) => {
  const normalizedType = normalizeWhitespace(courtType).toLowerCase()
  const normalizedCourt = normalizeWhitespace(court).toLowerCase()

  if (normalizedType === "basketball" || normalizedCourt.includes("basket")) return "BB"
  if (
    normalizedType === "mini_soccer" ||
    normalizedCourt.includes("mini soccer") ||
    normalizedCourt.includes("mini-soccer") ||
    normalizedCourt.includes("minisoccer")
  ) {
    return "MS"
  }

  const words = normalizeWhitespace(court)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)

  if (!words.length) {
    throw new Error("Cannot generate a booking event key without a valid court.")
  }

  return words.length > 1
    ? words.map((word) => word[0]).join("").slice(0, 6)
    : words[0].slice(0, 6)
}

const getCompactDate = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error("Cannot generate a booking event key without a valid play date.")
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("")
}

const getCompactStartTime = (value) => {
  const match = normalizeWhitespace(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    throw new Error("Cannot generate a booking event key without a valid play time.")
  }

  return `${String(Number(match[1])).padStart(2, "0")}${match[2]}`
}

export const buildBookingEventKey = ({
  customerKey,
  court,
  courtType,
  playDate,
  startHour,
}) => {
  const customerMatch = String(customerKey ?? "").match(/^CUST-(\d+)$/)
  const operationalMatch = String(customerKey ?? "").match(/^SYS-(.+)$/)
  if (!customerMatch && !operationalMatch) {
    throw new Error("Cannot generate a booking event key without a valid customer key.")
  }
  const identityComponent = customerMatch
    ? customerMatch[1].padStart(5, "0")
    : operationalMatch[1]

  return [
    "SES",
    identityComponent,
    getCourtCode({ court, courtType }),
    getCompactDate(playDate),
    getCompactStartTime(startHour),
  ].join("-")
}

export const buildBookingRangeKey = ({
  customerKey,
  court,
  courtType,
  playDate,
  startHour,
  endHour,
}) =>
  [
    "RNG",
    String(customerKey ?? ""),
    getCourtCode({ court, courtType }),
    getCompactDate(playDate),
    getCompactStartTime(startHour),
    getCompactStartTime(endHour),
  ].join("-")

export const partitionUniqueBookingEvents = (transactions, existingKeys = []) => {
  const seen = new Set(existingKeys)
  const accepted = []
  const duplicates = []

  transactions.forEach((transaction) => {
    if (seen.has(transaction.bookingEventKey)) {
      duplicates.push(transaction)
      return
    }

    seen.add(transaction.bookingEventKey)
    accepted.push(transaction)
  })

  return { accepted, duplicates }
}
