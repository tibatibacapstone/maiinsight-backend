import { recalculateCustomerTypes } from "./customerType.service.js"

const isPersistentSystemCustomer = (customer) =>
  customer.customerKeyType === "operational" || String(customer.customerKey).startsWith("SYS-")

const resolveBatchCustomerImpact = async (database, batchId) => {
  const affectedCustomers = await database.facilityTransaction.findMany({
    where: {
      batchId,
      customerId: { not: null },
    },
    select: { customerId: true },
    distinct: ["customerId"],
  })
  const affectedCustomerIds = affectedCustomers.map(({ customerId }) => customerId)

  if (!affectedCustomerIds.length) {
    return { affectedCustomerIds, orphanCustomerIds: [], retainedCustomerIds: [] }
  }

  const [affectedCustomerRecords, remainingTransactions] = await Promise.all([
    database.customer.findMany({
      where: { id: { in: affectedCustomerIds } },
      select: { id: true, customerKey: true, customerKeyType: true },
    }),
    database.facilityTransaction.groupBy({
      by: ["customerId"],
      where: {
        customerId: { in: affectedCustomerIds },
        batchId: { not: batchId },
      },
      _count: { _all: true },
    }),
  ])

  const customerIdsWithRemainingTransactions = new Set(
    remainingTransactions.filter((row) => row._count._all > 0).map((row) => row.customerId)
  )
  const orphanCustomerIds = affectedCustomerRecords
    .filter(
      (customer) =>
        !customerIdsWithRemainingTransactions.has(customer.id) &&
        !isPersistentSystemCustomer(customer)
    )
    .map((customer) => customer.id)
  const retainedCustomerIds = affectedCustomerRecords
    .filter((customer) => !orphanCustomerIds.includes(customer.id))
    .map((customer) => customer.id)

  return { affectedCustomerIds, orphanCustomerIds, retainedCustomerIds }
}

export const getImportBatchImpact = async (database, batchId) => {
  const [facilityTransactionCount, courtHourUsageCount, rawTransactionCount, customerImpact] =
    await Promise.all([
      database.facilityTransaction.count({ where: { batchId } }),
      database.courtHourUsage.count({ where: { batchId } }),
      database.rawTransactionTable.count({ where: { batchId } }),
      resolveBatchCustomerImpact(database, batchId),
    ])

  return {
    facilityTransactionCount,
    courtHourUsageCount,
    rawTransactionCount,
    orphanCustomerCount: customerImpact.orphanCustomerIds.length,
    retainedCustomerCount: customerImpact.retainedCustomerIds.length,
  }
}

export const deleteImportBatchData = async (database, batchId) =>
  database.$transaction(async (transaction) => {
    const { orphanCustomerIds, retainedCustomerIds } = await resolveBatchCustomerImpact(
      transaction,
      batchId
    )

    const deletedCourtHours = await transaction.courtHourUsage.deleteMany({ where: { batchId } })
    const deletedTransactions = await transaction.facilityTransaction.deleteMany({ where: { batchId } })
    const deletedRawRows = await transaction.rawTransactionTable.deleteMany({ where: { batchId } })
    await transaction.importBatch.delete({ where: { id: batchId } })

    const deletedCustomers = orphanCustomerIds.length
      ? await transaction.customer.deleteMany({ where: { id: { in: orphanCustomerIds } } })
      : { count: 0 }
    const recalculatedCustomers = await recalculateCustomerTypes(
      transaction,
      retainedCustomerIds
    )

    return {
      deletedCourtHourCount: deletedCourtHours.count,
      deletedTransactionCount: deletedTransactions.count,
      deletedRawRowCount: deletedRawRows.count,
      deletedOrphanCustomerCount: deletedCustomers.count,
      retainedCustomerCount: recalculatedCustomers.length,
    }
  })
