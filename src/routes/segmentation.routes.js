import { Router } from "express"
import { logActivity } from "../services/activityLog.service.js"

import { authenticate, authorize } from "../middleware/auth.js"
import {
  getLatestSegmentationResult,
  getSegmentationCustomers,
  getSegmentationSummary,
  runRfmSegmentation,
} from "../services/rfmSegmentation.service.js"
import {
  validateSegmentationCustomerInput,
  validateSegmentationLookupInput,
  validateSegmentationRunInput,
} from "../services/segmentationValidation.service.js"

export const segmentationRouter = Router()

segmentationRouter.use(authenticate)

segmentationRouter.post(
  "/run",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateSegmentationRunInput(req.body || {})
      const result = await runRfmSegmentation(input)

      await logActivity(req, "SEGMENTATION_UPDATED", {
        jobName: "Customer Value Segmentation Run",
        status: "success",
        totalCustomers: result.run?.totalCustomers || 0,
        selectedK: result.selectedK,
        method: "RFM_KMEANS",
        completedAt: new Date().toISOString(),
      })

      res.json({
        success: true,
        message: "Segmentation run completed",
        data: {
          run: result.run,
          selectedK: result.selectedK,
          optimalK: result.optimalK,
          bestSilhouetteK: result.bestSilhouetteK,
          elbowK: result.elbowK,
          silhouetteScore: result.silhouetteScore,
          kEvaluation: result.kEvaluation,
          selectionReason: result.selectionReason,
          clusters: result.clusters,
          summary: result.summary,
        },
      })
    } catch (error) {
      await logActivity(req, "SEGMENTATION_FAILED", {
        jobName: "Customer Value Segmentation Run",
        status: "failed",
        technicalMessage:
          error instanceof Error ? error.message : "Segmentation run failed.",
        completedAt: new Date().toISOString(),
      }).catch(() => null)

      next(error)
    }
  }
)

segmentationRouter.get(
  "/latest",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateSegmentationCustomerInput(req.query || {})
      const result = await getLatestSegmentationResult(input)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

segmentationRouter.get(
  "/summary",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateSegmentationLookupInput(req.query || {})
      const result = await getSegmentationSummary(input)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

segmentationRouter.get(
  "/customers",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const input = validateSegmentationCustomerInput({
        includeCustomers: true,
        ...(req.query || {}),
      })
      const result = await getSegmentationCustomers(input)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)