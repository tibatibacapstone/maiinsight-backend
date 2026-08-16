import { createHash } from "node:crypto"

import {
  buildBookingEventKey,
  buildBookingRangeKey,
  formatCustomerKey,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from "./transactionFeatureEngineering.service.js"
import { recalculateCustomerTypes } from "./customerType.service.js"

const scoreCandidate = (candidate) => {
  let score = 0
  if (candidate.name) score += 2
  if (candidate.email) score += 3
  if (candidate.phone) score += 3
  if (candidate.customerProfile) score += 1
  return score
}

const normalizeProfileValue = (value) => {
  if (value === undefined || value === null || value === "") return null
  return value
}

const normalizeConfidenceValue = (value) => {
  const normalized = String(value || "").toLowerCase().trim()
  if (normalized === "high") return 1
  if (normalized === "system") return 1
  if (normalized === "medium") return 0.7
  if (normalized === "low") return 0.4
  return 0
}

export const buildCustomerUpsertCandidates = (transactions = []) => {
  const candidateByIdentity = new Map()

  transactions.forEach((transaction) => {
    if (!transaction?.customerIdentity) return

    const isSystemIdentity = String(transaction.customerKey).startsWith("SYS-")

    const candidate = {
      customerIdentity: transaction.customerIdentity,
      preferredCustomerKey: isSystemIdentity ? transaction.customerKey : null,
      name: transaction.customerName || transaction.nama || null,
      email: transaction.normalizedEmail || transaction.email || null,
      phone: transaction.normalizedPhone || transaction.noTelepon || null,
      customerProfile: normalizeProfileValue(transaction.customerProfile),
      customerKeyType: transaction.customerKeyType || "unknown",
      customerKeyConfidence: normalizeConfidenceValue(transaction.customerKeyConfidence),
    }
    const existing = candidateByIdentity.get(candidate.customerIdentity)

    if (!existing || scoreCandidate(candidate) >= scoreCandidate(existing)) {
      candidateByIdentity.set(candidate.customerIdentity, candidate)
    }
  })

  return [...candidateByIdentity.values()]
}

const createIdentityError = ({ errorCode, rowNumber, column, message, suggestion }) => {
  const error = new Error(message)
  error.errorCode = errorCode
  error.suggestion = suggestion
  error.technicalMessage = `${errorCode} at source row ${rowNumber}.`
  error.validationErrors = [{ rowNumber, column, message }]
  return error
}

const identityConflict = (rowNumber) =>
  createIdentityError({
    errorCode: "CUSTOMER_IDENTITY_CONFLICT",
    rowNumber,
    column: "Email, Phone",
    message:
      "Customer identity could not be resolved because the email and phone number match different customer records.",
    suggestion: "Please verify the email and phone number in the source transaction file.",
  })

const ambiguousName = (rowNumber) =>
  createIdentityError({
    errorCode: "CUSTOMER_NAME_AMBIGUOUS",
    rowNumber,
    column: "Customer Name",
    message: "Customer identity could not be resolved because the name matches multiple customer records.",
    suggestion: "Please add a verified email address or phone number to the source transaction row.",
  })

const addToIndex = (index, value, customer) => {
  if (!value) return
  const matches = index.get(value) || []
  if (!matches.includes(customer)) matches.push(customer)
  index.set(value, matches)
}

const removeFromIndex = (index, value, customer) => {
  if (!value) return
  const matches = index.get(value)
  if (!matches) return
  const remainingMatches = matches.filter((match) => match !== customer)
  if (remainingMatches.length) {
    index.set(value, remainingMatches)
  } else {
    index.delete(value)
  }
}

const oneMatch = (index, value) => {
  if (!value) return null
  const matches = index.get(value) || []
  if (!matches.length) return null
  return matches.length === 1 ? matches[0] : matches
}

const fillEmptyProfileFields = (customer, incoming, nameIndex, skipPhone = false) => {
  const changed = {}

  if (!customer.normalizedName && incoming.name && incoming.normalizedName) {
    const previousNormalizedName = customer.normalizedName
    customer.name = incoming.name
    customer.normalizedName = incoming.normalizedName
    changed.name = incoming.name

    if (previousNormalizedName !== customer.normalizedName) {
      removeFromIndex(nameIndex, previousNormalizedName, customer)
    }
    addToIndex(nameIndex, customer.normalizedName, customer)
  }

  for (const field of ["email", "phone", "customerProfile"]) {
    if (skipPhone && field === "phone") continue
    if (!customer[field] && incoming[field]) {
      customer[field] = incoming[field]
      changed[field] = incoming[field]
    }
  }
  Object.assign(customer.pendingUpdate, changed)
}

const resolveCustomer = async (database, candidate) => {
  const { preferredCustomerKey, pendingUpdate } = candidate
  const customerData = {
    customerIdentity: candidate.customerIdentity,
    name: candidate.name || null,
    email: candidate.email || null,
    phone: candidate.phone || null,
    customerProfile: candidate.customerProfile || null,
    customerKeyType: candidate.customerKeyType,
    customerKeyConfidence: candidate.customerKeyConfidence,
  }
  const pendingCustomerKey = `PENDING-${createHash("sha256")
    .update(candidate.customerIdentity)
    .digest("hex")
    .slice(0, 32)}`
  const customer = await database.customer.upsert({
    where: {
      customerIdentity: candidate.customerIdentity,
    },
    update: {
      ...pendingUpdate,
    },
    create: {
      ...customerData,
      // Replaced immediately after the auto-increment ID is known.
      customerKey: preferredCustomerKey || pendingCustomerKey,
    },
  })

  const permanentCustomerKey = preferredCustomerKey || formatCustomerKey(customer.id)
  if (customer.customerKey === permanentCustomerKey) return customer

  return database.customer.update({
    where: {
      id: customer.id,
    },
    data: {
      customerKey: permanentCustomerKey,
    },
  })
}

export const resolveCustomersForTransactions = async (database, transactions = []) => {
  const storedCustomers = await database.customer.findMany()
  const emailIndex = new Map()
  const phoneIndex = new Map()
  const nameIndex = new Map()
  const workingCustomers = storedCustomers.map((customer) => ({
    ...customer,
    email: normalizeCustomerEmail(customer.email),
    phone: normalizeCustomerPhone(customer.phone),
    normalizedName: normalizeCustomerName(customer.name),
    pendingUpdate: {},
    isNew: false,
  }))

  for (const customer of workingCustomers) {
    addToIndex(emailIndex, customer.email, customer)
    addToIndex(phoneIndex, customer.phone, customer)
    addToIndex(nameIndex, customer.normalizedName, customer)
  }

  const resolutionByTransaction = new Map()
  for (const transaction of transactions) {
    if (String(transaction.customerKey).startsWith("SYS-")) {
      let customer = workingCustomers.find(
        (item) => item.customerIdentity === transaction.customerIdentity
      )
      if (!customer) {
        customer = {
          ...buildCustomerUpsertCandidates([transaction])[0],
          pendingUpdate: {},
          isNew: true,
        }
        workingCustomers.push(customer)
      }
      resolutionByTransaction.set(transaction, customer)
      continue
    }

    const email = normalizeCustomerEmail(transaction.normalizedEmail ?? transaction.email)
    const phone = normalizeCustomerPhone(transaction.normalizedPhone ?? transaction.noTelepon)
    const normalizedName = normalizeCustomerName(
      transaction.normalizedName ?? transaction.customerName ?? transaction.nama
    )
    const emailMatch = oneMatch(emailIndex, email)
    const phoneMatch = oneMatch(phoneIndex, phone)

    if (Array.isArray(emailMatch) || Array.isArray(phoneMatch)) {
      throw identityConflict(transaction.rowNumber)
    }

    let customer = emailMatch || phoneMatch
    if (!customer && !email && !phone && normalizedName) {
      const nameMatches = nameIndex.get(normalizedName) || []
      if (nameMatches.length > 1) throw ambiguousName(transaction.rowNumber)
      customer = nameMatches[0] || null
    }

    const incoming = {
      customerIdentity: transaction.customerIdentity,
      preferredCustomerKey: null,
      name: transaction.customerName || transaction.nama || null,
      email,
      phone,
      normalizedName,
      customerProfile: normalizeProfileValue(transaction.customerProfile),
      customerKeyType: transaction.customerKeyType || "unknown",
      customerKeyConfidence: normalizeConfidenceValue(transaction.customerKeyConfidence),
    }

    if (!customer) {
      customer = { ...incoming, pendingUpdate: {}, isNew: true }
      workingCustomers.push(customer)
      addToIndex(emailIndex, email, customer)
      addToIndex(phoneIndex, phone, customer)
      addToIndex(nameIndex, normalizedName, customer)
    } else {
      const skipPhone = Boolean(emailMatch && phoneMatch && emailMatch !== phoneMatch)
      fillEmptyProfileFields(customer, incoming, nameIndex, skipPhone)
      addToIndex(emailIndex, customer.email, customer)
      addToIndex(phoneIndex, customer.phone, customer)
      addToIndex(nameIndex, customer.normalizedName, customer)
    }
    resolutionByTransaction.set(transaction, customer)
  }

  const persistedByWorkingCustomer = new Map()
  for (const candidate of new Set(resolutionByTransaction.values())) {
    const persisted = await resolveCustomer(database, candidate)
    persistedByWorkingCustomer.set(candidate, persisted)
  }

  const enrichedTransactions = transactions.map((transaction) => {
    const workingCustomer = resolutionByTransaction.get(transaction)
    const customer = persistedByWorkingCustomer.get(workingCustomer)
    if (!customer) {
      throw new Error(`Customer identity could not be persisted for row ${transaction.rowNumber}.`)
    }

    const bookingEventKey = buildBookingEventKey({
      customerKey: customer.customerKey,
      court: transaction.court,
      courtType: transaction.courtType,
      playDate: transaction.playDate,
      startHour: transaction.startHour,
    })

    return {
      ...transaction,
      customerId: customer.id,
      customerKey: customer.customerKey,
      customerIdentity: customer.customerIdentity,
      bookingEventKey,
      bookingRangeKey: buildBookingRangeKey({
        customerKey: customer.customerKey,
        court: transaction.court,
        courtType: transaction.courtType,
        playDate: transaction.playDate,
        startHour: transaction.startHour,
        endHour: transaction.endHour,
      }),
    }
  })

  return {
    customers: [...persistedByWorkingCustomer.values()],
    transactions: enrichedTransactions,
  }
}

export const syncCustomersForTransactions = async (database, transactions = []) => {
  const { customers, transactions: enrichedTransactions } =
    await resolveCustomersForTransactions(database, transactions)

  const transactionIdsByCustomerId = new Map()
  enrichedTransactions.forEach((transaction) => {
    if (!transaction.id || !transaction.customerId) return
    const ids = transactionIdsByCustomerId.get(transaction.customerId) || []
    ids.push(transaction.id)
    transactionIdsByCustomerId.set(transaction.customerId, ids)
  })

  for (const [customerId, transactionIds] of transactionIdsByCustomerId.entries()) {
    const transaction = enrichedTransactions.find((item) => item.customerId === customerId)
    await database.facilityTransaction.updateMany({
      where: {
        id: {
          in: transactionIds,
        },
      },
      data: {
        customerId,
        customerKey: transaction.customerKey,
      },
    })
  }

  const customerTypeUpdates = await recalculateCustomerTypes(
    database,
    customers.map((customer) => customer.id)
  )

  return {
    customerCount: customers.length,
    customerTypeUpdatedCount: customerTypeUpdates.length,
    linkedTransactionCount: enrichedTransactions.filter(
      (transaction) => transaction.id && transaction.customerId
    ).length,
  }
}
