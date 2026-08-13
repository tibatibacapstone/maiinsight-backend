const RECOGNIZED_CUSTOMER_BOOKING_TYPES = [
  "Manual/Walk-in",
  "GeloraApp Booking",
  "Internal",
]

const emptyCounts = () => ({
  membershipTransactionCount: 0,
  nonMembershipTransactionCount: 0,
  internalTransactionCount: 0,
})

export const classifyCustomerType = ({
  membershipTransactionCount = 0,
  nonMembershipTransactionCount = 0,
  internalTransactionCount = 0,
  isOperationalIdentity = false,
} = {}) => {
  if (membershipTransactionCount > 0) return "membership"
  if (nonMembershipTransactionCount > 0) return "non_membership"
  if (isOperationalIdentity && internalTransactionCount > 0) return "internal"
  return "unknown"
}

export const buildCustomerTypeSummary = (rows = [], { isOperationalIdentity = false } = {}) => {
  const counts = emptyCounts()

  rows.forEach((row) => {
    const count = Number(row?._count?._all || 0)
    if (row?.bookingType === "Manual/Walk-in") {
      counts.membershipTransactionCount += count
    } else if (row?.bookingType === "GeloraApp Booking") {
      counts.nonMembershipTransactionCount += count
    } else if (row?.bookingType === "Internal") {
      counts.internalTransactionCount += count
    }
  })

  return {
    ...counts,
    customerType: classifyCustomerType({
      ...counts,
      isOperationalIdentity,
    }),
  }
}

export const recalculateCustomerTypes = async (
  database,
  customerIds,
  { calculatedAt = new Date() } = {}
) => {
  const uniqueCustomerIds = [
    ...new Set((customerIds || []).map(Number).filter(Number.isInteger)),
  ]
  if (!uniqueCustomerIds.length) return []

  const [customers, groupedTransactions] = await Promise.all([
    database.customer.findMany({
      where: { id: { in: uniqueCustomerIds } },
      select: {
        id: true,
        customerKey: true,
        customerKeyType: true,
      },
    }),
    database.facilityTransaction.groupBy({
      by: ["customerId", "bookingType"],
      where: {
        customerId: { in: uniqueCustomerIds },
        validBooking: true,
        bookingType: { in: RECOGNIZED_CUSTOMER_BOOKING_TYPES },
      },
      _count: { _all: true },
    }),
  ])

  const rowsByCustomerId = new Map()
  groupedTransactions.forEach((row) => {
    const rows = rowsByCustomerId.get(row.customerId) || []
    rows.push(row)
    rowsByCustomerId.set(row.customerId, rows)
  })

  const results = []
  for (const customer of customers) {
    const isOperationalIdentity =
      customer.customerKeyType === "operational" ||
      String(customer.customerKey).startsWith("SYS-")
    const summary = buildCustomerTypeSummary(
      rowsByCustomerId.get(customer.id) || [],
      { isOperationalIdentity }
    )
    const updatedCustomer = await database.customer.update({
      where: { id: customer.id },
      data: {
        ...summary,
        customerTypeCalculatedAt: calculatedAt,
      },
    })
    results.push(updatedCustomer)
  }

  return results
}
