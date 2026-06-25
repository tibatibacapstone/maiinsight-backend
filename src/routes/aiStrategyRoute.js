import { Router } from "express";

import { authenticate, authorize } from "../middleware/auth.js";
import { logItSupportActivity } from "../services/activityLog.service.js";
import { generateMaiinStrategy } from "../services/geminiService.js";

export const aiStrategyRouter = Router();

aiStrategyRouter.post("/generate", authenticate, authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const strategyContext = req.body;

    if (!strategyContext || Object.keys(strategyContext).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Request body tidak boleh kosong.",
      });
    }

    const result = await generateMaiinStrategy(strategyContext);

    await logItSupportActivity(req, "IT_SUPPORT_AI_STRATEGY_GENERATE", {
      selectedFilters: strategyContext.selected_filters || null,
    });

    return res.status(200).json({
      success: true,
      message: "AI strategy generated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
