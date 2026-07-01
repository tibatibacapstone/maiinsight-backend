import { Router } from "express"

import { authenticate, authorize } from "../middleware/auth.js"
import {
  getLowOccupancySessions,
  getRecommendedCustomers,
} from "../services/lowOccupancyTargeting.service.js"
import {
  validateLowOccupancySessionInput,
  validateRecommendedCustomersInput,
} from "../services/lowOccupancyTargetingValidation.service.js"

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
