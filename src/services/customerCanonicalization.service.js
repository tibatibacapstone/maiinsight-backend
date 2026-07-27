import { createHash } from "node:crypto"

import {
  buildBookingEventKey,
  buildBookingRangeKey,
  formatCustomerKey,
} from "./transactionFeatureEngineering.service.js"

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
  if (normalized === "medium") return 0.7
  if (normalized === "low") return 0.4
  return 0
}

export const buildCustomerUpsertCandidates = (transactions = []) => {
  const candidateByIdentity = new Map()

  transactions.forEach((transaction) => {
    if (!transaction?.customerIdentity || String(transaction.customerKey).startsWith("SYS-")) return

    const candidate = {
      customerIdentity: transaction.customerIdentity,
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

const resolveCustomer = async (database, candidate) => {
  const pendingCustomerKey = `PENDING-${createHash("sha256")
    .update(candidate.customerIdentity)
    .digest("hex")
    .slice(0, 32)}`
  const customer = await database.customer.upsert({
    where: {
      customerIdentity: candidate.customerIdentity,
    },
    update: {
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      customerProfile: candidate.customerProfile,
      customerKeyType: candidate.customerKeyType,
      customerKeyConfidence: candidate.customerKeyConfidence,
    },
    create: {
      ...candidate,
      // Replaced immediately after the auto-increment ID is known.
      customerKey: pendingCustomerKey,
    },
  })

  const permanentCustomerKey = formatCustomerKey(customer.id)
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
  const candidates = buildCustomerUpsertCandidates(transactions)
  const customerByIdentity = new Map()

  for (const candidate of candidates) {
    const customer = await resolveCustomer(database, candidate)
    customerByIdentity.set(customer.customerIdentity, customer)
  }

  const enrichedTransactions = transactions.map((transaction) => {
    if (String(transaction.customerKey).startsWith("SYS-")) {
      const bookingEventKey = buildBookingEventKey({
        customerKey: transaction.customerKey,
        court: transaction.court,
        courtType: transaction.courtType,
        playDate: transaction.playDate,
        startHour: transaction.startHour,
      })

      return {
        ...transaction,
        customerId: null,
        bookingEventKey,
        bookingRangeKey: buildBookingRangeKey({
          customerKey: transaction.customerKey,
          court: transaction.court,
          courtType: transaction.courtType,
          playDate: transaction.playDate,
          startHour: transaction.startHour,
          endHour: transaction.endHour,
        }),
      }
    }

    const customer = customerByIdentity.get(transaction.customerIdentity)
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
    customers: [...customerByIdentity.values()],
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

  return {
    customerCount: customers.length,
    linkedTransactionCount: enrichedTransactions.filter(
      (transaction) => transaction.id && transaction.customerId
    ).length,
  }
}
