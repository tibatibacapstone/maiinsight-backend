import { Router } from "express";

import { prisma } from "../config/prisma.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logActivity, logItSupportActivity } from "../services/activityLog.service.js";
import { generateStrategy, getAiProviderStatus } from "../services/aiProvider.service.js";
import { buildAiStrategyContext } from "../services/aiStrategyContext.service.js";
import { createNotificationsForRoles } from "../services/notification.service.js";

export const aiStrategyRouter = Router();

const normalizeStoredStrategy = (strategy = {}) => ({
  ...strategy,
  targetSegmentKey: strategy.targetSegmentKey || null,
  targetSegmentLabel: strategy.targetSegmentLabel || strategy.targetCustomerGroup || null,
  targetVenueKey: strategy.targetVenueKey || null,
  targetSessionKey: strategy.targetSessionKey || null,
  targetDayKey: strategy.targetDayKey || null,
  targetDayLabel: strategy.targetDayLabel || null,
  recommendedOfferType: strategy.recommendedOfferType || null,
  offerReasoning: strategy.offerReasoning || strategy.customerReasoning || null,
  evidenceUsed: Array.isArray(strategy.evidenceUsed) ? strategy.evidenceUsed : [],
  executionPlan: Array.isArray(strategy.executionPlan) ? strategy.executionPlan : [],
  kpis: Array.isArray(strategy.kpis) ? strategy.kpis : [],
  followUpPlan: strategy.followUpPlan || null,
  stopCondition: strategy.stopCondition || null,
  dataLimitation: strategy.dataLimitation || null,
})

aiStrategyRouter.get(
  "/status",
  authenticate,
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const providerStatus = await getAiProviderStatus();
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
      return res.status(500).json({
        success: false,
        errorCode: "AI_PROVIDER_STATUS_FAILED",
        message: "AI provider status could not be loaded.",
        suggestion: "Please try again or contact IT Support if the issue continues.",
        technicalMessage: error instanceof Error ? error.message : "AI provider status failed.",
      });
    }
  }
);

aiStrategyRouter.get(
  "/latest",
  authenticate,
  authorize("operational", "management", "it_support"),
  async (_req, res) => {
    try {
      const stored = await prisma.aiStrategy.findFirst({ orderBy: { generatedAt: "desc" } })
      return res.json({
        success: true,
        data: stored
          ? {
              id: stored.id,
              provider: stored.provider,
              model: stored.model,
              generatedAt: stored.generatedAt,
              strategy: normalizeStoredStrategy(stored.strategy),
            }
          : null,
      })
    } catch (error) {
      return res.status(500).json({
        success: false,
        errorCode: "AI_STRATEGY_HISTORY_FAILED",
        message: "AI strategy history could not be loaded.",
        technicalMessage: error instanceof Error ? error.message : "Strategy history failed.",
      })
    }
  }
)

aiStrategyRouter.post(
  "/context",
  authenticate,
  authorize("operational", "management", "it_support"),
  async (req, res) => {
    try {
      const context = await buildAiStrategyContext(req.body || {})
      return res.json({ success: true, data: context })
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        success: false,
        errorCode: error?.errorCode || "AI_CONTEXT_FAILED",
        message: error instanceof Error ? error.message : "Selected segment context could not be loaded.",
      })
    }
  }
)

aiStrategyRouter.post(
  ["/generate", "/strategy"],
  authenticate,
  authorize("operational", "it_support"),
  async (req, res) => {
    const strategyContext = req.body || {};

    try {
      if (!strategyContext || Object.keys(strategyContext).length === 0) {
        await logActivity(req, "AI_STRATEGY_FAILED", {
          jobName: "AI Strategy Engine Sync",
          errorCode: "INVALID_AI_INPUT",
          status: "failed",
          completedAt: new Date().toISOString(),
        }).catch(() => null);
        return res.status(400).json({
          success: false,
          errorCode: "INVALID_AI_INPUT",
          message: "Campaign inputs are still empty.",
          suggestion:
            "Please choose campaign filters or outreach context before generating a strategy.",
        });
      }

      const structuredContext = await buildAiStrategyContext(strategyContext);
      const result = await generateStrategy(structuredContext);
      const generatedAt = new Date().toISOString();
      const storedStrategy = await prisma.aiStrategy.create({
        data: {
          provider: result.provider,
          model: result.model,
          targetSegmentKey: structuredContext.selected_scope.segmentKey,
          targetVenueKey:
            structuredContext.selected_scope.venueKey === "all"
              ? null
              : structuredContext.selected_scope.venueKey,
          targetSessionKey:
            structuredContext.selected_scope.sessionKey === "all"
              ? null
              : structuredContext.selected_scope.sessionKey,
          campaignObjectiveKey: structuredContext.selected_scope.campaignObjectiveKey || null,
          offerFrameworkKey: structuredContext.selected_scope.offerFrameworkKey || null,
          strategy: result.strategy,
          generatedAt: new Date(generatedAt),
          performedByUserId: req.user.userId,
        },
      })
      const usage = result.usage || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 }
      await prisma.aiUsageLog.create({
        data: {
          userId: req.user.userId,
          model: result.model,
          feature: "strategy_generation",
          promptTokens: Number(usage.promptTokens) || 0,
          candidatesTokens: Number(usage.candidatesTokens) || 0,
          totalTokens: Number(usage.totalTokens) || 0,
        },
      })
      const safeMetadata = {
        segmentKey: structuredContext.selected_scope.segmentKey,
        venueKey: structuredContext.selected_scope.venueKey,
        sessionKey: structuredContext.selected_scope.sessionKey,
        campaignObjectiveKey: structuredContext.selected_scope.campaignObjectiveKey,
        offerFrameworkKey: structuredContext.selected_scope.offerFrameworkKey,
      }

      await logActivity(req, "AI_STRATEGY_GENERATED", {
        jobName: "AI Strategy Engine Sync",
        ...safeMetadata,
        strategyId: storedStrategy.id,
        status: "success",
        records: 1,
        provider: result.provider,
        model: result.model,
        completedAt: generatedAt,
      })
      await logItSupportActivity(req, "IT_SUPPORT_AI_STRATEGY_GENERATE", {
        ...safeMetadata,
        strategyId: storedStrategy.id,
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
        strategyId: storedStrategy.id,
        strategy: result.strategy,
        context: structuredContext,
        data: {
          provider: result.provider,
          model: result.model,
          generatedAt,
          strategyId: storedStrategy.id,
          strategy: result.strategy,
          context: structuredContext,
        },
      });
    } catch (error) {
      const providerStatus = await getAiProviderStatus();

      await logActivity(req, "AI_STRATEGY_FAILED", {
        jobName: "AI Strategy Engine Sync",
        segmentKey: strategyContext.selected_scope?.segmentKey || strategyContext.selected_filters?.segmentName || null,
        venueKey: strategyContext.selected_scope?.venueKey || strategyContext.selected_filters?.venue || null,
        sessionKey: strategyContext.selected_scope?.sessionKey || strategyContext.selected_filters?.sessionName || null,
        campaignObjectiveKey: strategyContext.selected_scope?.campaignObjectiveKey || null,
        offerFrameworkKey: strategyContext.selected_scope?.offerFrameworkKey || null,
        errorCode: error?.errorCode || "AI_GENERATION_FAILED",
        status: "failed",
        provider: providerStatus.provider,
        completedAt: new Date().toISOString(),
      }).catch(() => null);
      await logItSupportActivity(req, "IT_SUPPORT_AI_STRATEGY_FAILED", {
        provider: providerStatus.provider,
        errorCode: error?.errorCode || "AI_GENERATION_FAILED",
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
