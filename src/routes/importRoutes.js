import { Router } from "express";
import multer from "multer";
import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logItSupportActivity } from "../services/activityLog.service.js";
import {
  buildCourtHourUsageEntries,
  mapFacilityTransactionToCanonicalUpdate,
  mapRawRowToFacilityTransaction,
} from "../services/facilityTransactionMapper.js";
import { syncCustomersForTransactions } from "../services/customerCanonicalization.service.js";
import {
  buildFriendlyImportFailure,
  createImportError,
  IMPORT_UPLOAD_LIMIT_MESSAGE,
  isSupportedImportFile,
  parseUploadedTransactionFile,
  validateTransactionTemplate,
} from "../services/importFile.service.js";
import { EXCLUDED_IMPORT_BATCH_FILE_NAMES } from "../services/dashboardPeriod.service.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (isSupportedImportFile(file)) {
      cb(null, true);
      return;
    }

    cb(
      createImportError({
        errorCode: "UNSUPPORTED_FILE_TYPE",
        message: "MaiinSight only supports CSV and Excel transaction files.",
        suggestion: "Please upload a .csv, .xlsx, or .xls file.",
        technicalMessage: `Unsupported file: ${file.originalname} (${file.mimetype || "unknown mimetype"})`,
      })
    );
  },
});

const handleImportUpload = (req, res, next) => {
  upload.single("file")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(
        createImportError({
          errorCode: "IMPORT_FAILED",
          message: IMPORT_UPLOAD_LIMIT_MESSAGE,
          suggestion: "Please upload a smaller CSV or Excel transaction file.",
          technicalMessage: error.message,
        })
      );
      return;
    }

    next(error);
  });
};

const parseBatchId = (value) => {
  if (value === undefined || value === null || value === "") return null;

  const batchId = Number(value);
  return Number.isFinite(batchId) && batchId > 0 ? batchId : null;
};

const findExistingImportByFileName = async (fileName) => {
  if (!fileName) return null;

  return prisma.importBatch.findFirst({
    where: {
      fileName,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      fileName: true,
      status: true,
      createdAt: true,
    },
  });
};

const facilityTransactionSyncSelect = {
  id: true,
  batchId: true,
  playDate: true,
  startHour: true,
  endHour: true,
  durationHours: true,
  court: true,
  courtType: true,
  validBooking: true,
  netRevenue: true,
  customerKey: true,
  customerName: true,
  nama: true,
  normalizedEmail: true,
  email: true,
  normalizedPhone: true,
  noTelepon: true,
  customerProfile: true,
  customerKeyType: true,
  customerKeyConfidence: true,
};

const syncCourtHourUsageForTransactions = async (transactions, { replaceExisting = false } = {}) => {
  let createdCount = 0;

  for (const transaction of transactions) {
    if (!transaction?.id) continue;

    if (replaceExisting) {
      await prisma.courtHourUsage.deleteMany({
        where: {
          transactionId: transaction.id,
        },
      });
    }

    const entries = buildCourtHourUsageEntries(transaction);

    if (!entries.length) continue;

    const result = await prisma.courtHourUsage.createMany({
      data: entries,
      skipDuplicates: true,
    });

    createdCount += result.count;
  }

  return createdCount;
};

const syncCanonicalDataForTransactions = async (transactions, options = {}) => {
  const transactionIds = transactions
    .map((transaction) => transaction?.id)
    .filter((transactionId) => Number.isFinite(transactionId));

  if (!transactionIds.length) {
    return {
      customerCount: 0,
      linkedTransactionCount: 0,
      courtHoursCreated: 0,
    };
  }

  const customerSyncSummary = await syncCustomersForTransactions(prisma, transactions);

  const refreshedTransactions = await prisma.facilityTransaction.findMany({
    where: {
      id: {
        in: transactionIds,
      },
    },
    select: facilityTransactionSyncSelect,
  });

  const courtHoursCreated = await syncCourtHourUsageForTransactions(
    refreshedTransactions,
    options
  );

  return {
    ...customerSyncSummary,
    courtHoursCreated,
  };
};

// Semua route import wajib login
router.use(authenticate);

// Admin + IT boleh lihat history jobs
router.get("/jobs", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const jobs = await prisma.importBatch.findMany({
      where: {
        fileName: {
          notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        fileName: true,
        rowCount: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      message: "Import jobs fetched successfully.",
      data: jobs,
    });
  } catch (error) {
    next(error);
  }
});

// Marketing Operational and IT support can upload import files.
router.post(
  ["/upload-csv", "/upload-file"],
  authorize("operational", "it_support"),
  handleImportUpload,
  async (req, res) => {
    let batch = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          errorCode: "IMPORT_FAILED",
          message: "No transaction file was uploaded.",
          suggestion: "Please upload a CSV or Excel transaction file and try again.",
        });
      }

      const existingBatch = await findExistingImportByFileName(req.file.originalname);

      if (existingBatch) {
        return res.status(409).json({
          success: false,
          errorCode: "DUPLICATE_IMPORT_FILE",
          message: "A transaction file with the same name has already been imported.",
          suggestion:
            "Rename the file before uploading, or delete the earlier import batch if this is a corrected replacement.",
          technicalMessage: `Existing batch ${existingBatch.id} already uses file name ${existingBatch.fileName}.`,
        });
      }

      const records = parseUploadedTransactionFile(req.file);
      const headers = validateTransactionTemplate(records);

      batch = await prisma.importBatch.create({
        data: {
          fileName: req.file.originalname,
          rowCount: records.length,
          headers,
          status: "processing",
        },
      });

      await prisma.rawTransactionTable.createMany({
        data: records.map((row, index) => ({
          batchId: batch.id,
          rowNumber: index + 1,
          data: row,
          status: "raw",
        })),
      });

      const rawRows = await prisma.rawTransactionTable.findMany({
        where: {
          batchId: batch.id,
        },
        orderBy: {
          rowNumber: "asc",
        },
        select: {
          id: true,
          rowNumber: true,
          data: true,
        },
      });

      const facilityTransactions = [];
      const rowErrors = [];

      rawRows.forEach((rawRow) => {
        try {
          facilityTransactions.push(
            mapRawRowToFacilityTransaction(
              rawRow.data,
              batch.id,
              rawRow.rowNumber,
              rawRow.id
            )
          );
        } catch (error) {
          rowErrors.push({
            rowNumber: rawRow.rowNumber,
            message: error instanceof Error ? error.message : "Failed to map row.",
          });
        }
      });

      if (facilityTransactions.length) {
        await prisma.facilityTransaction.createMany({
          data: facilityTransactions,
        });
      }

      if (rowErrors.length) {
        await Promise.all(
          rowErrors.map((item) =>
            prisma.rawTransactionTable.updateMany({
              where: {
                batchId: batch.id,
                rowNumber: item.rowNumber,
              },
              data: {
                status: "failed",
                errorMessage: item.message,
              },
            })
          )
        );
      }

      const createdTransactions = await prisma.facilityTransaction.findMany({
        where: {
          batchId: batch.id,
        },
        orderBy: {
          rowNumber: "asc",
        },
        select: facilityTransactionSyncSelect,
      });

      const syncSummary = await syncCanonicalDataForTransactions(createdTransactions);

      const updatedBatch = await prisma.importBatch.update({
        where: {
          id: batch.id,
        },
        data: {
          status: rowErrors.length === records.length ? "failed" : "completed",
          errorMessage: rowErrors.length
            ? `${rowErrors.length} row(s) could not be mapped.`
            : null,
        },
      });

      await logItSupportActivity(req, "IT_SUPPORT_IMPORT_UPLOAD", {
        batchId: updatedBatch.id,
        fileName: updatedBatch.fileName,
        rowCount: records.length,
        facilityTransactionCount: facilityTransactions.length,
        customerCount: syncSummary.customerCount,
        linkedTransactionCount: syncSummary.linkedTransactionCount,
        courtHoursCreated: syncSummary.courtHoursCreated,
        rowErrors: rowErrors.length,
      });

      res.status(201).json({
        success: true,
        message: rowErrors.length
          ? "Transaction file uploaded with partial row mapping errors."
          : "Transaction file uploaded successfully.",
        data: {
          batchId: updatedBatch.id,
          fileName: updatedBatch.fileName,
          rowCount: records.length,
          headers,
          status: updatedBatch.status,
          facilityTransactionCount: facilityTransactions.length,
          customerCount: syncSummary.customerCount,
          linkedTransactionCount: syncSummary.linkedTransactionCount,
          courtHoursCreated: syncSummary.courtHoursCreated,
          rowErrors,
        },
      });
    } catch (error) {
      const friendlyFailure = buildFriendlyImportFailure(error);

      if (batch?.id) {
        await prisma.importBatch.update({
          where: {
            id: batch.id,
          },
          data: {
            status: "failed",
            errorMessage: friendlyFailure.message,
          },
        }).catch(() => null);
      }

      if (
        friendlyFailure.technicalMessage?.includes("customerKeyConfidence") ||
        friendlyFailure.technicalMessage?.includes("Prisma")
      ) {
        friendlyFailure.message = "The uploaded file could not be processed.";
        friendlyFailure.suggestion =
          "Please make sure the file follows the required MaiinSight transaction template, then try again.";
      }

      const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : friendlyFailure.errorCode === "INVALID_TEMPLATE" ||
            friendlyFailure.errorCode === "UNSUPPORTED_FILE_TYPE"
          ? 400
          : 500;

      return res.status(statusCode).json(friendlyFailure);
    }
  },
);

router.post(
  "/backfill-canonical",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const scopedBatchId = parseBatchId(req.body?.batchId ?? req.query?.batchId);

      if ((req.body?.batchId || req.query?.batchId) && !scopedBatchId) {
        return res.status(400).json({
          success: false,
          message: "Invalid batch ID.",
        });
      }

      const transactions = await prisma.facilityTransaction.findMany({
        where: scopedBatchId
          ? {
              batchId: scopedBatchId,
            }
          : undefined,
        orderBy: [
          {
            batchId: "asc",
          },
          {
            rowNumber: "asc",
          },
          {
            id: "asc",
          },
        ],
      });

      const summary = {
        totalRows: transactions.length,
        updatedRows: 0,
        customerCount: 0,
        linkedTransactionCount: 0,
        courtHoursCreated: 0,
        skippedRows: 0,
        errors: [],
      };
      const updatedTransactions = [];

      for (const transaction of transactions) {
        try {
          const updatePayload = mapFacilityTransactionToCanonicalUpdate(transaction);

          const updatedTransaction = await prisma.facilityTransaction.update({
            where: {
              id: transaction.id,
            },
            data: updatePayload,
            select: facilityTransactionSyncSelect,
          });

          updatedTransactions.push(updatedTransaction);
          summary.updatedRows += 1;
        } catch (error) {
          summary.skippedRows += 1;
          summary.errors.push({
            transactionId: transaction.id,
            rowNumber: transaction.rowNumber,
            batchId: transaction.batchId,
            message: error instanceof Error ? error.message : "Backfill failed.",
          });
        }
      }

      if (updatedTransactions.length) {
        const syncSummary = await syncCanonicalDataForTransactions(updatedTransactions, {
          replaceExisting: true,
        });

        summary.customerCount = syncSummary.customerCount;
        summary.linkedTransactionCount = syncSummary.linkedTransactionCount;
        summary.courtHoursCreated = syncSummary.courtHoursCreated;
      }

      await logItSupportActivity(req, "IT_SUPPORT_IMPORT_BACKFILL", {
        batchId: scopedBatchId,
        ...summary,
        errorCount: summary.errors.length,
      });

      return res.json({
        success: true,
        message: "Canonical backfill completed.",
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Marketing Operational and IT support can view raw transaction rows for a specific import batch.
router.get("/batches/:id/rows", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const batchId = Number(req.params.id);

    if (!batchId || Number.isNaN(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid import batch ID.",
      });
    }

    const batch = await prisma.importBatch.findUnique({
      where: {
        id: batchId,
      },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    const rows = await prisma.rawTransactionTable.findMany({
      where: {
        batchId,
      },
      orderBy: {
        rowNumber: "asc",
      },
      take: 100,
      select: {
        id: true,
        batchId: true,
        rowNumber: true,
        data: true,
        status: true,
        errorMessage: true,
        createdAt: true,
      },
    });

    await logItSupportActivity(req, "IT_SUPPORT_RAW_IMPORT_VIEW", {
      batchId,
      rowCount: rows.length,
    });

    return res.json({
      success: true,
      message: "Raw transaction rows fetched successfully.",
      data: {
        batch,
        rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Marketing Operational and IT support can delete import batches.
router.delete("/jobs/:id", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const batchId = Number(req.params.id);

    if (!batchId || Number.isNaN(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid import batch ID.",
      });
    }

    const existingBatch = await prisma.importBatch.findUnique({
      where: {
        id: batchId,
      },
    });

    if (!existingBatch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    await prisma.$transaction([
      prisma.courtHourUsage.deleteMany({
        where: {
          batchId,
        },
      }),
      prisma.facilityTransaction.deleteMany({
        where: {
          batchId,
        },
      }),
      prisma.rawTransactionTable.deleteMany({
        where: {
          batchId,
        },
      }),
      prisma.importBatch.delete({
        where: {
          id: batchId,
        },
      }),
    ]);

    await logItSupportActivity(req, "IT_SUPPORT_IMPORT_DELETE", {
      batchId,
      fileName: existingBatch.fileName,
      rowCount: existingBatch.rowCount,
    });

    return res.json({
      success: true,
      message: "Import history and uploaded data deleted successfully.",
      data: {
        batchId,
      },
    });
  } catch (error) {
    next(error);
  }
});

export const importRouter = router;






