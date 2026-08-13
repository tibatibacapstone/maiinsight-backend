const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const TRANSACTION_ROW_CATEGORIES = {
  CUSTOMER: "customer",
  OPERATIONAL: "operational",
  EXCLUDED: "excluded",
}

export const DASHBOARD_TRANSACTION_GROUPS = {
  ALL: "all",
  GELORA_APP_BOOKING: "GeloraApp Booking",
  MANUAL_WALK_IN: "Manual/Walk-in",
  INTERNAL: "Internal",
  TUTUP_MAINTENANCE: "Tutup/Maintenance",
  EXCLUDED: "excluded",
}

export const CANONICAL_TRANSACTION_STATUSES = {
  PAYMENT_COMPLETED: "Payment Completed",
  MANUAL_WALK_IN: "Manual/Walk-in",
  INTERNAL: "Internal",
  TUTUP_MAINTENANCE: "Tutup/Maintenance",
}

const normalizeStatusToken = (value) =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\s*[/\\-]\s*/g, "/")

const STATUS_DEFINITIONS = new Map([
  [
    "payment completed",
    {
      canonicalStatus: CANONICAL_TRANSACTION_STATUSES.PAYMENT_COMPLETED,
      category: TRANSACTION_ROW_CATEGORIES.CUSTOMER,
      bookingType: "GeloraApp Booking",
    },
  ],
  ...["manual/walk/in", "manual/walkin", "manual walk/in", "manual walkin", "manual booking"].map(
    (alias) => [
      alias,
      {
        canonicalStatus: CANONICAL_TRANSACTION_STATUSES.MANUAL_WALK_IN,
        category: TRANSACTION_ROW_CATEGORIES.CUSTOMER,
        bookingType: "Manual/Walk-in",
      },
    ]
  ),
  [
    "internal",
    {
      canonicalStatus: CANONICAL_TRANSACTION_STATUSES.INTERNAL,
      category: TRANSACTION_ROW_CATEGORIES.OPERATIONAL,
      bookingType: "Internal",
      operationalCode: "INTERNAL",
    },
  ],
  ...["tutup/maintenance", "closed/maintenance", "tutup", "maintenance"].map((alias) => [
    alias,
    {
      canonicalStatus: CANONICAL_TRANSACTION_STATUSES.TUTUP_MAINTENANCE,
      category: TRANSACTION_ROW_CATEGORIES.OPERATIONAL,
      bookingType: "Tutup/Maintenance",
      operationalCode: "TUTUP_MAINTENANCE",
    },
  ]),
])

export const classifyTransactionStatus = (value) => {
  const normalizedStatus = normalizeStatusToken(value)
  const definition = STATUS_DEFINITIONS.get(normalizedStatus)

  if (definition) {
    return {
      ...definition,
      normalizedStatus,
      customerIdentity:
        definition.category === TRANSACTION_ROW_CATEGORIES.OPERATIONAL
          ? `STATUS|${definition.operationalCode}`
          : null,
      customerKey:
        definition.category === TRANSACTION_ROW_CATEGORIES.OPERATIONAL
          ? `SYS-${definition.operationalCode.replaceAll("_", "-")}`
          : null,
    }
  }

  return {
    canonicalStatus: normalizeWhitespace(value) || null,
    normalizedStatus,
    category: TRANSACTION_ROW_CATEGORIES.EXCLUDED,
    bookingType: null,
    operationalCode: null,
    customerIdentity: null,
    customerKey: null,
  }
}

export const isEligibleCustomerStatus = (value) =>
  classifyTransactionStatus(value).category === TRANSACTION_ROW_CATEGORIES.CUSTOMER

export const getDashboardTransactionGroup = (value) => {
  const classification = classifyTransactionStatus(value)

  if (classification.category === TRANSACTION_ROW_CATEGORIES.EXCLUDED) {
    return DASHBOARD_TRANSACTION_GROUPS.EXCLUDED
  }

  return classification.bookingType || DASHBOARD_TRANSACTION_GROUPS.EXCLUDED
}

export const normalizeDashboardTransactionGroup = (value) => {
  const normalized = normalizeWhitespace(value).toLowerCase().replace(/[\s-]+/g, "_")

  if (!normalized || normalized === "all" || normalized === "all_type") {
    return DASHBOARD_TRANSACTION_GROUPS.ALL
  }

  if (
    normalized === "geloraapp_booking" ||
    normalized === "gelora_app_booking" ||
    normalized === "geloraappbooking" ||
    normalized === "gelora" ||
    normalized === "payment_completed" ||
    normalized === "non_membership" ||
    normalized === "non_member"
  ) {
    return DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING
  }

  if (
    normalized === "manual/walk_in" ||
    normalized === "manual_walk_in" ||
    normalized === "manual" ||
    normalized === "walk_in" ||
    normalized === "walkin" ||
    normalized === "manual_booking" ||
    normalized === "membership" ||
    normalized === "member"
  ) {
    return DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN
  }

  if (normalized === "internal" || normalized === "operational") {
    return DASHBOARD_TRANSACTION_GROUPS.INTERNAL
  }

  if (
    normalized === "tutup/maintenance" ||
    normalized === "tutup_maintenance" ||
    normalized === "tutup" ||
    normalized === "maintenance" ||
    normalized === "closed/maintenance" ||
    normalized === "closed_maintenance" ||
    normalized === "blocked"
  ) {
    return DASHBOARD_TRANSACTION_GROUPS.TUTUP_MAINTENANCE
  }

  return null
}

export const parseTransactionAmount = (value, { emptyValue = null } = {}) => {
  if (value === null || value === undefined || normalizeWhitespace(value) === "") {
    return {
      valid: emptyValue !== null,
      value: emptyValue,
    }
  }

  const cleaned = normalizeWhitespace(value)
    .replace(/rp/gi, "")
    .replace(/\s+/g, "")
    .trim()

  if (!/\d/.test(cleaned) || /[^0-9,.-]/.test(cleaned)) {
    return { valid: false, value: null }
  }

  const normalized = cleaned
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".")
  const numericValue = Number(normalized)

  return Number.isFinite(numericValue)
    ? { valid: true, value: numericValue }
    : { valid: false, value: null }
}

export const classifyTransactionRevenue = ({ baseRevenue, addOnRevenue, category }) => {
  const base = parseTransactionAmount(baseRevenue, {
    emptyValue: category === TRANSACTION_ROW_CATEGORIES.OPERATIONAL ? 0 : null,
  })
  const addOn = parseTransactionAmount(addOnRevenue, { emptyValue: 0 })

  if (category === TRANSACTION_ROW_CATEGORIES.OPERATIONAL) {
    return {
      valid: true,
      baseRevenue: base.valid ? base.value : 0,
      addOnRevenue: addOn.valid ? addOn.value : 0,
      netRevenue: (base.valid ? base.value : 0) + (addOn.valid ? addOn.value : 0),
      shouldSkip: false,
    }
  }

  const valid = base.valid && addOn.valid
  const netRevenue = valid ? base.value + addOn.value : null

  return {
    valid,
    baseRevenue: base.value,
    addOnRevenue: addOn.value,
    netRevenue,
    shouldSkip: !valid || base.value <= 0 || netRevenue <= 0,
  }
}
