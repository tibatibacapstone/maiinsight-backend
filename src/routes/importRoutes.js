import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.originalname.toLowerCase().endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed."));
    }
  },
});

// Semua route import wajib login
router.use(authenticate);

// Admin + IT boleh lihat history jobs
router.get("/jobs", authorize("admin", "it_support"), async (req, res, next) => {
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

// Admin only boleh upload CSV
router.post(
  "/upload-csv",
  authorize("admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "CSV file is required.",
        });
      }

      const csvText = req.file.buffer.toString("utf8");

      const records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });

      if (!records.length) {
        return res.status(400).json({
          success: false,
          message: "CSV file is empty or has no valid rows.",
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

      res.status(201).json({
        success: true,
        message: "CSV uploaded successfully.",
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

// Admin + IT boleh lihat raw data
router.get("/batches/:id/rows", authorize("admin", "it_support"), async (req, res, next) => {
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

// Admin only boleh delete history + raw data
router.delete("/jobs/:id", authorize("admin"), async (req, res, next) => {
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