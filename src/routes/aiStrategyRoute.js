import { Router } from "express";

import { generateMaiinStrategy } from "../services/geminiService.js";

export const aiStrategyRouter = Router();

aiStrategyRouter.post("/generate", async (req, res, next) => {
  try {
    const strategyContext = req.body;

    if (!strategyContext || Object.keys(strategyContext).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Request body tidak boleh kosong.",
      });
    }

    const result = await generateMaiinStrategy(strategyContext);

    return res.status(200).json({
      success: true,
      message: "AI strategy generated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});