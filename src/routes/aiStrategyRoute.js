import { Router } from "express";

import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity, logItSupportActivity } from "../services/activityLog.service.js";
import { generateStrategy, getAiProviderStatus } from "../services/aiProvider.service.js";
import { createNotificationsForRoles } from "../services/notification.service.js";

export const aiStrategyRouter = Router();

aiStrategyRouter.get(
  "/status",
  authenticate,
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const providerStatus = getAiProviderStatus();
      const latestGeneration = await prisma.activityLog.findFirst({
        where: {
          action: "AI_STRATEGY_GENERATED",
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          createdAt: true,
        },
      });

      return res.json({
        success: true,
        data: {
          configured: providerStatus.configured,
          provider: providerStatus.provider,
          providerLabel: providerStatus.providerLabel,
          model: providerStatus.model,
          latestGenerationAt: latestGeneration?.createdAt || null,
          setupMessage: providerStatus.setupMessage,
          suggestion: providerStatus.suggestion,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

aiStrategyRouter.post(
  ["/generate", "/strategy"],
  authenticate,
  authorize("operational", "it_support"),
  async (req, res, next) => {
    const strategyContext = req.body || {};

    try {
      if (!strategyContext || Object.keys(strategyContext).length === 0) {
        return res.status(400).json({
          success: false,
          errorCode: "INVALID_AI_INPUT",
          message: "Campaign inputs are still empty.",
          suggestion:
            "Please choose campaign filters or outreach context before generating a strategy.",
        });
      }

      const result = await generateStrategy(strategyContext);
      const generatedAt = new Date().toISOString();

      await logActivity(req, "AI_STRATEGY_GENERATED", {
        selectedFilters: strategyContext.selected_filters || null,
        workspaceMode: strategyContext.selected_filters?.mode || "general",
        status: "success",
        provider: result.provider,
        model: result.model,
      });
      await logItSupportActivity(req, "IT_SUPPORT_AI_STRATEGY_GENERATE", {
        selectedFilters: strategyContext.selected_filters || null,
        provider: result.provider,
        model: result.model,
      });
      await createNotificationsForRoles(prisma, ["operational", "it_support"], {
        title: "AI Strategy Generated",
        message: "A new AI strategy draft is ready in GenAI Workspace.",
      });

      return res.status(200).json({
        success: true,
        message: "AI strategy generated successfully.",
        provider: result.provider,
        model: result.model,
        generatedAt,
        strategy: result.strategy,
        rawText: result.rawText || null,
        data: {
          provider: result.provider,
          model: result.model,
          generatedAt,
          strategy: result.strategy,
          rawText: result.rawText || null,
        },
      });
    } catch (error) {
      const providerStatus = getAiProviderStatus();

      await logActivity(req, "AI_STRATEGY_FAILED", {
        selectedFilters: strategyContext.selected_filters || null,
        workspaceMode: strategyContext.selected_filters?.mode || "general",
        status: "failed",
        provider: providerStatus.provider,
        technicalMessage: error instanceof Error ? error.message : "AI strategy failed.",
      }).catch(() => null);
      await logItSupportActivity(req, "IT_SUPPORT_AI_STRATEGY_FAILED", {
        selectedFilters: strategyContext.selected_filters || null,
        provider: providerStatus.provider,
        technicalMessage: error instanceof Error ? error.message : "AI strategy failed.",
      }).catch(() => null);
      await createNotificationsForRoles(prisma, ["operational", "it_support"], {
        title: "AI Strategy Failed",
        message: "AI strategy could not be generated.",
      }).catch(() => null);

      if (error?.errorCode && error?.message) {
        return res.status(error.statusCode || 500).json({
          success: false,
          errorCode: error.errorCode,
          message: error.message,
          suggestion:
            error.suggestion ||
            "Please try again or contact IT Support if the issue continues.",
          technicalMessage: error.technicalMessage,
        });
      }

      return res.status(500).json({
        success: false,
        errorCode: "AI_GENERATION_FAILED",
        message: "AI strategy could not be generated.",
        suggestion: "Please try again or contact IT Support if the issue continues.",
        technicalMessage: error instanceof Error ? error.message : "AI strategy failed.",
      });
    }
  }
);
