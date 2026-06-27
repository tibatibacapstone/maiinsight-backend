const CUSTOMER_SYNC_BATCH_SIZE = 100

const processInBatches = async (items, processor, batchSize = CUSTOMER_SYNC_BATCH_SIZE) => {
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize)
    await Promise.all(batch.map((item) => processor(item)))
  }
}

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
  const candidateByKey = new Map()

  transactions.forEach((transaction) => {
    if (!transaction?.customerKey) return

    const candidate = {
      customerKey: transaction.customerKey,
      name: transaction.customerName || transaction.nama || null,
      email: transaction.normalizedEmail || transaction.email || null,
      phone: transaction.normalizedPhone || transaction.noTelepon || null,
      customerProfile: normalizeProfileValue(transaction.customerProfile),
      customerKeyType: transaction.customerKeyType || "unknown",
      customerKeyConfidence: normalizeConfidenceValue(transaction.customerKeyConfidence),
    }

    const existingCandidate = candidateByKey.get(candidate.customerKey)

    if (!existingCandidate || scoreCandidate(candidate) >= scoreCandidate(existingCandidate)) {
      candidateByKey.set(candidate.customerKey, candidate)
    }
  })

  return [...candidateByKey.values()]
}

const updateFacilityTransactionsWithCustomers = async (
  prismaClient,
  transactions,
  customerByKey
) => {
  const transactionIdsByCustomerId = new Map()

  transactions.forEach((transaction) => {
    const customerId = customerByKey.get(transaction.customerKey)?.id

    if (!customerId || !transaction.id) return

    const transactionIds = transactionIdsByCustomerId.get(customerId) || []
    transactionIds.push(transaction.id)
    transactionIdsByCustomerId.set(customerId, transactionIds)
  })

  await processInBatches([...transactionIdsByCustomerId.entries()], ([customerId, transactionIds]) =>
    prismaClient.facilityTransaction.updateMany({
      where: {
        id: {
          in: transactionIds,
        },
      },
      data: {
        customerId,
      },
    })
  )
}

export const syncCustomersForTransactions = async (prismaClient, transactions = []) => {
  const candidates = buildCustomerUpsertCandidates(transactions)

  if (!candidates.length) {
    return {
      customerCount: 0,
      linkedTransactionCount: 0,
    }
  }

  await processInBatches(candidates, (candidate) =>
    prismaClient.customer.upsert({
      where: {
        customerKey: candidate.customerKey,
      },
      update: {
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        customerProfile: candidate.customerProfile,
        customerKeyType: candidate.customerKeyType,
        customerKeyConfidence: candidate.customerKeyConfidence,
      },
      create: candidate,
    })
  )

  const customers = await prismaClient.customer.findMany({
    where: {
      customerKey: {
        in: candidates.map((candidate) => candidate.customerKey),
      },
    },
    select: {
      id: true,
      customerKey: true,
    },
  })

  const customerByKey = new Map(customers.map((customer) => [customer.customerKey, customer]))

  await updateFacilityTransactionsWithCustomers(prismaClient, transactions, customerByKey)

  const linkedTransactionCount = transactions.filter(
    (transaction) => customerByKey.has(transaction.customerKey) && transaction.id
  ).length

  return {
    customerCount: customers.length,
    linkedTransactionCount,
  }
}
