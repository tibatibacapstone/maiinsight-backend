import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import {
  getLowOccupancySessions,
  getRecommendedCustomers,
} from "../services/lowOccupancyTargeting.service.js"
import {
  validateGenerateOutreachMessageInput,
  validateLowOccupancySessionInput,
  validateRecommendedCustomersInput,
} from "../services/lowOccupancyTargetingValidation.service.js"
import { generateOutreachMessage, OUTREACH_MESSAGE_PLACEHOLDER } from "../services/aiProvider.service.js"

export const targetingRouter = Router()

targetingRouter.use(authenticate)
targetingRouter.use(authorize("operational", "it_support"))

targetingRouter.get("/low-occupancy-sessions", async (req, res, next) => {
  try {
    const input = validateLowOccupancySessionInput(req.query || {})
    const sessions = await getLowOccupancySessions(input)

    res.json({
      success: true,
      data: {
        sessions,
      },
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.get("/recommended-customers", async (req, res, next) => {
  try {
    const input = validateRecommendedCustomersInput(req.query || {})
    const result = await getRecommendedCustomers(input)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

targetingRouter.post("/generate-message", async (req, res, next) => {
  try {
    const { customerName, ...signals } = validateGenerateOutreachMessageInput(req.body || {})
    const result = await generateOutreachMessage(signals)
    const message = result.message.split(OUTREACH_MESSAGE_PLACEHOLDER).join(customerName)

    const usage = result.usage || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 }
    await prisma.aiUsageLog.create({
      data: {
        userId: req.user.userId,
        model: result.model,
        feature: "outreach_message_generation",
        promptTokens: Number(usage.promptTokens) || 0,
        candidatesTokens: Number(usage.candidatesTokens) || 0,
        totalTokens: Number(usage.totalTokens) || 0,
      },
    }).catch(() => null)

    res.json({
      success: true,
      data: {
        provider: result.provider,
        model: result.model,
        message,
      },
    })
  } catch (error) {
    next(error)
  }
})
