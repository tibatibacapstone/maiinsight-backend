import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logItSupportActivity } from "../services/activityLog.service.js";
import { processTransactionBatch } from "../services/transactionCleaning.service.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.originalname.toLowerCase().endsWith(".csv") ||
      file.originalname.toLowerCase().endsWith(".xlsx")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV or XLSX files are allowed."));
    }
  },
});

const parseUploadFile = (file) => {
  const originalName = file.originalname.toLowerCase();

  if (originalName.endsWith(".xlsx")) {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  }

  const csvText = file.buffer.toString("utf8");
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
};

// Semua route import wajib login
router.use(authenticate);

// Admin + IT boleh lihat history jobs
router.get("/jobs", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const jobs = await prisma.importBatch.findMany({
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

// Marketing owns imports; IT support may test/troubleshoot upload behavior.
router.post(
  "/upload-csv",
  authorize("marketing", "it_support"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "CSV or XLSX file is required.",
        });
      }

      const records = parseUploadFile(req.file);

      if (!records.length) {
        return res.status(400).json({
          success: false,
          message: "Uploaded file is empty or has no valid rows.",
        });
      }

      const headers = Object.keys(records[0]);

      const batch = await prisma.importBatch.create({
        data: {
          fileName: req.file.originalname,
          rowCount: records.length,
          headers,
          status: "uploaded",
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

      await logItSupportActivity(req, "IT_SUPPORT_IMPORT_UPLOAD", {
        batchId: batch.id,
        fileName: batch.fileName,
        rowCount: records.length,
      });

      res.status(201).json({
        success: true,
        message: "File uploaded successfully.",
        data: {
          batchId: batch.id,
          fileName: batch.fileName,
          rowCount: records.length,
          headers,
          status: batch.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post("/batches/:id/process", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const batchId = Number(req.params.id);

    if (!batchId || Number.isNaN(batchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid import batch ID.",
      });
    }

    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    const summary = await processTransactionBatch(batchId);

    await logItSupportActivity(req, "IT_SUPPORT_IMPORT_PROCESS", {
      batchId,
      fileName: batch.fileName,
      rowCount: batch.rowCount,
      summary,
    });

    return res.json({
      success: true,
      message: "Transaction batch processed successfully.",
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

// Admin + IT boleh lihat raw data
router.get("/batches/:id/rows", authorize("marketing", "it_support"), async (req, res, next) => {
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

// Marketing owns import deletion; IT support may test/troubleshoot deletion behavior.
router.delete("/jobs/:id", authorize("marketing", "it_support"), async (req, res, next) => {
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
