import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { runPlaytimeClustering } from "../services/ml.service.js"

export const mlRouter = Router()

mlRouter.use(authenticate)

mlRouter.post(
  "/playtime/run",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const result = await runPlaytimeClustering()

      res.json({
        success: true,
        message: "Playtime clustering completed successfully.",
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

mlRouter.get("/playtime/latest", async (req, res, next) => {
  try {
    const latestRun = await prisma.playtimeMlRun.findFirst({
      orderBy: {
        createdAt: "desc",
      },
      include: {
        segmentSummaries: true,
        customerSegments: {
          take: 100,
          orderBy: {
            totalSesi: "desc",
          },
        },
      },
    })

    if (!latestRun) {
      return res.status(404).json({
        success: false,
        message: "No playtime ML result found.",
      })
    }

    res.json({
      success: true,
      message: "Latest playtime ML result retrieved successfully.",
      data: latestRun,
    })
  } catch (error) {
    next(error)
  }
})