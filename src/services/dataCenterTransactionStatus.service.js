import { EXCLUDED_IMPORT_BATCH_FILE_NAMES } from "./dashboardPeriod.service.js";

export const getLatestTransactionDate = async (prismaClient) => {
  const result = await prismaClient.facilityTransaction.aggregate({
    where: {
      transactionDate: { not: null },
      batch: {
        fileName: { notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES },
      },
    },
    _max: { transactionDate: true },
  });

  return result?._max?.transactionDate || null;
};
