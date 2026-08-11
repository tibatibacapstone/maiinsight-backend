import { Router } from "express";
import multer from "multer";
import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity, logItSupportActivity } from "../services/activityLog.service.js";
import {
  buildCourtHourUsageEntries,
  mapFacilityTransactionToCanonicalUpdate,
  mapRawRowToFacilityTransactionResult,
} from "../services/facilityTransactionMapper.js";
import {
  resolveCustomersForTransactions,
  syncCustomersForTransactions,
} from "../services/customerCanonicalization.service.js";
import { deleteImportBatchData } from "../services/importBatchDeletion.service.js";
import {
  buildFriendlyImportFailure,
  createImportError,
  IMPORT_UPLOAD_LIMIT_MESSAGE,
  isSupportedImportFile,
  parseUploadedTransactionFile,
  validateTransactionTemplate,
  validateTransactionRows,
} from "../services/importFile.service.js";
import { EXCLUDED_IMPORT_BATCH_FILE_NAMES } from "../services/dashboardPeriod.service.js";
import { partitionUniqueBookingEvents } from "../services/transactionFeatureEngineering.service.js";
import {
  buildTransformedBatchColumns,
  buildTransformedBatchCsv,
  buildTransformedBatchRows,
  IMPORT_BATCH_PREVIEW_LIMIT,
} from "../services/importBatchExport.service.js";

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
const createFailedImportHistory = async ({
  fileName,
  rowCount = 0,
  headers = [],
  message,
  performedByUserId = null,
}) => {
  if (!fileName) return null;

  return prisma.importBatch.create({
    data: {
      fileName,
      rowCount,
      headers,
      status: "failed",
      errorMessage: message || "Import failed.",
      performedByUserId,
    },
  });
};

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

const findCompletedImportByFileName = async (fileName) => {
  if (!fileName) return null;

  return prisma.importBatch.findFirst({
    where: {
      fileName,
      status: "completed",
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
  customerIdentity: true,
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
  bookingEventKey: true,
};

const rawBatchRowSelect = {
  id: true,
  batchId: true,
  rowNumber: true,
  data: true,
  status: true,
  errorMessage: true,
  createdAt: true,
};

const getTransformedBatchRows = async (batchId, { take } = {}) => {
  const rows = await prisma.rawTransactionTable.findMany({
    where: { batchId },
    orderBy: { rowNumber: "asc" },
    ...(take ? { take } : {}),
    select: rawBatchRowSelect,
  });
  const generatedTransactions = rows.length
    ? await prisma.facilityTransaction.findMany({
        where: {
          batchId,
          rawRowId: { in: rows.map((row) => row.id) },
        },
        orderBy: { rowNumber: "asc" },
      })
    : [];

  return buildTransformedBatchRows(rows, generatedTransactions);
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

router.post(
  "/manual-sync",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const activity = await logActivity(req, "DATA_CENTER_DATABASE_REFRESH", {
        jobName: "MaiinSight Database Sync",
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      return res.json({
        success: true,
        message: "MaiinSight Database refreshed successfully.",
        data: { activityId: activity?.id || null },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Admin + IT boleh lihat history jobs
router.get("/jobs", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const actorSelect = { id: true, name: true, email: true };
    const [
      imports,
      metaSyncs,
      segmentationRuns,
      aiStrategies,
      failedAiJobs,
      databaseRefreshJobs,
    ] = await Promise.all([
      prisma.importBatch.findMany({
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
        errorMessage: true,
        performedBy: { select: actorSelect },
      },
      }),
      prisma.metaSyncLog.findMany({
        orderBy: { startedAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          message: true,
          startedAt: true,
          finishedAt: true,
          performedBy: { select: actorSelect },
        },
      }),
      prisma.segmentationRun.findMany({
        orderBy: { runDate: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          errorMessage: true,
          totalCustomers: true,
          runDate: true,
          updatedAt: true,
          performedBy: { select: actorSelect },
        },
      }),
      prisma.aiStrategy.findMany({
        orderBy: { generatedAt: "desc" },
        take: 20,
        select: {
          id: true,
          generatedAt: true,
          performedBy: { select: actorSelect },
        },
      }),
      prisma.activityLog.findMany({
        where: { action: "AI_STRATEGY_FAILED" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          metadata: true,
          createdAt: true,
          user: { select: actorSelect },
        },
      }),
      prisma.activityLog.findMany({
        where: { action: "DATA_CENTER_DATABASE_REFRESH" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          user: { select: actorSelect },
        },
      }),
    ]);

    const jobs = [
      ...imports.map((job) => ({
        id: `import-${job.id}`,
        sourceRecordId: job.id,
        name: job.fileName,
        type: "file",
        status: job.status,
        records: job.rowCount,
        startedAt: job.createdAt,
        completedAt: job.status === "completed" ? job.updatedAt : null,
        error: job.errorMessage,
        performedBy: job.performedBy,
      })),
      ...metaSyncs.map((job) => ({
        id: `meta-${job.id}`,
        sourceRecordId: job.id,
        name: "Meta Graph API Sync",
        type: "api",
        status: job.status,
        records: 0,
        startedAt: job.startedAt,
        completedAt: job.finishedAt,
        error: job.status === "FAILED" ? job.message : null,
        performedBy: job.performedBy,
      })),
      ...segmentationRuns.map((job) => ({
        id: `segmentation-${job.id}`,
        sourceRecordId: job.id,
        name: "K-Means++ Segmentation Run",
        type: "api",
        status: job.status,
        records: job.totalCustomers,
        startedAt: job.runDate,
        completedAt: job.status === "running" ? null : job.updatedAt,
        error: job.errorMessage,
        performedBy: job.performedBy,
      })),
      ...aiStrategies.map((job) => ({
        id: `ai-${job.id}`,
        sourceRecordId: job.id,
        name: "AI Strategy Engine Sync",
        type: "api",
        status: "completed",
        records: 1,
        startedAt: job.generatedAt,
        completedAt: job.generatedAt,
        error: null,
        performedBy: job.performedBy,
      })),
      ...failedAiJobs.map((job) => ({
        id: `ai-failed-${job.id}`,
        sourceRecordId: job.id,
        name: "AI Strategy Engine Sync",
        type: "api",
        status: "failed",
        records: 0,
        startedAt: job.createdAt,
        completedAt: null,
        error: job.metadata?.errorCode || "AI strategy generation failed.",
        performedBy: job.user,
      })),
      ...databaseRefreshJobs.map((job) => ({
        id: `database-${job.id}`,
        sourceRecordId: job.id,
        name: "MaiinSight Database Sync",
        type: "api",
        status: "completed",
        records: 0,
        startedAt: job.createdAt,
        completedAt: job.createdAt,
        error: null,
        performedBy: job.user,
      })),
    ]
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt))
      .slice(0, 20);

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
let parsedRecords = [];
let parsedHeaders = [];

try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          errorCode: "IMPORT_FAILED",
          message: "No transaction file was uploaded.",
          suggestion: "Please upload a CSV or Excel transaction file and try again.",
        });
      }

      const existingBatch = await findCompletedImportByFileName(req.file.originalname);

      if (existingBatch) {
        throw createImportError({
          statusCode: 409,
          errorCode: "DUPLICATE_IMPORT_FILE",
          message: "A transaction file with the same name has already been successfully imported.",
          suggestion:
            "Rename the file before uploading, or delete the earlier completed import batch if this is a corrected replacement.",
          technicalMessage: `Existing completed batch ${existingBatch.id} already uses file name ${existingBatch.fileName}.`,
        });
      }

      // Persist the authenticated actor before parsing or row validation can fail.
      batch = await prisma.importBatch.create({
        data: {
          fileName: req.file.originalname,
          rowCount: 0,
          headers: [],
          status: "processing",
          performedByUserId: req.user.userId,
        },
      });

      parsedRecords = parseUploadedTransactionFile(req.file);
      parsedHeaders = validateTransactionTemplate(parsedRecords);
      validateTransactionRows(parsedRecords);

      const records = parsedRecords;
      const headers = parsedHeaders;

      batch = await prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          rowCount: records.length,
          headers,
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
      let skippedRows = 0;
      let zeroRevenueSkippedRows = 0;
      let excludedStatusRows = 0;
      let operationalRows = 0;
      rawRows.forEach((rawRow) => {
  try {
    const mappingResult = mapRawRowToFacilityTransactionResult(
      rawRow.data,
      batch.id,
      rawRow.rowNumber,
      rawRow.id
    );

    if (mappingResult.outcome === "skipped") {
      skippedRows += 1;
      if (mappingResult.reason === "non_positive_or_invalid_customer_revenue") {
        zeroRevenueSkippedRows += 1;
      } else if (mappingResult.reason === "excluded_status") {
        excludedStatusRows += 1;
      }
      return;
    }

    if (mappingResult.outcome === "operational") {
      operationalRows += 1;
    }

    facilityTransactions.push(mappingResult.payload);
  } catch (error) {
    rowErrors.push({
      rowNumber: rawRow.rowNumber,
      message: error instanceof Error ? error.message : "Failed to map row.",
    });
  }
});

      let insertableTransactions = facilityTransactions;

      if (facilityTransactions.length) {
        const resolved = await resolveCustomersForTransactions(prisma, facilityTransactions);
        const existingBookingEvents = await prisma.facilityTransaction.findMany({
          where: {
            bookingEventKey: {
              in: resolved.transactions.map((transaction) => transaction.bookingEventKey),
            },
          },
          select: {
            bookingEventKey: true,
          },
        });
        const partitioned = partitionUniqueBookingEvents(
          resolved.transactions,
          existingBookingEvents.map((transaction) => transaction.bookingEventKey)
        );

        partitioned.duplicates.forEach((transaction) => {
          rowErrors.push({
            rowNumber: transaction.rowNumber,
            message: `Duplicate booking event: ${transaction.bookingEventKey}.`,
          });
        });
        insertableTransactions = partitioned.accepted;
      }

      if (insertableTransactions.length) {
        const successfullyInserted = [];

        for (const transaction of insertableTransactions) {
          try {
            await prisma.facilityTransaction.create({
              data: transaction,
            });
            successfullyInserted.push(transaction);
          } catch (error) {
            if (error?.code !== "P2002") throw error;

            rowErrors.push({
              rowNumber: transaction.rowNumber,
              message: `Duplicate booking event: ${transaction.bookingEventKey}.`,
            });
          }
        }

        insertableTransactions = successfullyInserted;
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
        skippedRows,
        zeroRevenueSkippedRows,
        excludedStatusRows,
        operationalRows,
        facilityTransactionCount: insertableTransactions.length,
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
          facilityTransactionCount: insertableTransactions.length,
          skippedRows,
          zeroRevenueSkippedRows,
          excludedStatusRows,
          operationalRows,
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
            rowCount: parsedRecords.length || batch.rowCount,
            headers: parsedHeaders.length ? parsedHeaders : batch.headers,
            status: "failed",
            errorMessage: friendlyFailure.message,
          },
        }).catch(() => null);
        friendlyFailure.batchId = batch.id;
      } else if (req.file?.originalname) {
        const failedBatch = await createFailedImportHistory({
          fileName: req.file.originalname,
          rowCount: parsedRecords.length || 0,
          headers: parsedHeaders || [],
          message: friendlyFailure.message,
          performedByUserId: req.user.userId,
        }).catch(() => null);
        if (failedBatch?.id) friendlyFailure.batchId = failedBatch.id;
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
      const mappedTransactions = [];

      for (const transaction of transactions) {
        try {
          const updatePayload = mapFacilityTransactionToCanonicalUpdate(transaction);
          if (!updatePayload) {
            summary.skippedRows += 1;
            continue;
          }
          mappedTransactions.push({
            id: transaction.id,
            ...updatePayload,
          });
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

      if (mappedTransactions.length) {
        const resolved = await resolveCustomersForTransactions(prisma, mappedTransactions);
        const seenBookingEventKeys = new Set();

        for (const transaction of resolved.transactions) {
          if (seenBookingEventKeys.has(transaction.bookingEventKey)) {
            summary.skippedRows += 1;
            summary.errors.push({
              transactionId: transaction.id,
              rowNumber: transaction.rowNumber,
              batchId: transaction.batchId,
              message: `Duplicate booking event: ${transaction.bookingEventKey}.`,
            });
            continue;
          }

          seenBookingEventKeys.add(transaction.bookingEventKey);

          try {
            const { id, ...data } = transaction;
            const updatedTransaction = await prisma.facilityTransaction.update({
              where: {
                id,
              },
              data,
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
  select: {
    id: true,
    fileName: true,
    rowCount: true,
    headers: true,
    status: true,
    createdAt: true,
  },
});

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    const rowsWithGeneratedFeatures = await getTransformedBatchRows(batchId, {
      take: IMPORT_BATCH_PREVIEW_LIMIT,
    });
    const columns = buildTransformedBatchColumns();

    await logItSupportActivity(req, "IT_SUPPORT_RAW_IMPORT_VIEW", {
      batchId,
      rowCount: rowsWithGeneratedFeatures.length,
    });

    return res.json({
      success: true,
      message: "Raw transaction rows fetched successfully.",
      data: {
        batch,
        columns,
        rows: rowsWithGeneratedFeatures,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/batches/:id/export", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const batchId = parseBatchId(req.params.id);
    if (!batchId) {
      return res.status(400).json({ success: false, message: "Invalid import batch ID." });
    }

    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { id: true, fileName: true, headers: true },
    });
    if (!batch) {
      return res.status(404).json({ success: false, message: "Import batch not found." });
    }

    const rows = await getTransformedBatchRows(batchId);
    const columns = buildTransformedBatchColumns();
    const csv = buildTransformedBatchCsv(columns, rows);
    const baseName = batch.fileName.replace(/\.(?:csv|xlsx|xls)$/i, "").replace(/[^a-z0-9._-]+/gi, "-");

    await logItSupportActivity(req, "IT_SUPPORT_TRANSFORMED_IMPORT_EXPORT", {
      batchId,
      rowCount: rows.length,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${baseName || `batch-${batchId}`}_transformed.csv"`
    );
    return res.send(`\uFEFF${csv}`);
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

    const deletionSummary = await deleteImportBatchData(prisma, batchId);

    await logItSupportActivity(req, "IT_SUPPORT_IMPORT_DELETE", {
      batchId,
      fileName: existingBatch.fileName,
      rowCount: existingBatch.rowCount,
      ...deletionSummary,
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






