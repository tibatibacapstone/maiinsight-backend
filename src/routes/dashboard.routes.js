import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

dashboardRouter.get("/overview", authorize("marketing", "management", "it_support"), async (req, res, next) => {
  try {
    const totalUsers = await prisma.user.count();
    const activityCount = await prisma.activityLog.count();
    const notifications = await prisma.notification.findMany({ where: { role: req.user.role } });

    res.json({
      overview: {
        totalUsers,
        activityCount,
        notificationsCount: notifications.length,
        role: req.user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/activity", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const logs = await prisma.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/notifications", authorize("marketing", "management", "it_support"), async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { role: req.user.role },
      orderBy: { createdAt: "desc" },
    });

    res.json({ notifications });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/data-center", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const [
      importBatchCount,
      latestImportBatch,
      metaRawCount,
      latestMetaRawResponse,
      aiStrategyCount,
      latestAiStrategyLog,
      recentActivities,
      totalNotifications,
    ] = await Promise.all([
      prisma.importBatch.count(),
      prisma.importBatch.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { rowCount: true, updatedAt: true, createdAt: true },
      }),
      prisma.metaRawResponse.count(),
      prisma.metaRawResponse.findFirst({
        orderBy: { fetchedAt: "desc" },
        select: { fetchedAt: true },
      }),
      prisma.activityLog.count({
        where: { action: "IT_SUPPORT_AI_STRATEGY_GENERATE" },
      }),
      prisma.activityLog.findFirst({
        where: { action: "IT_SUPPORT_AI_STRATEGY_GENERATE" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.activityLog.findMany({ take: 10, orderBy: { createdAt: "desc" } }),
      prisma.notification.count(),
    ]);

    const formatSyncValue = (dateValue) => {
      if (!dateValue) return "Not synced yet";
      return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(dateValue));
    };

    res.json({
      dataCenter: {
        sources: [
          {
            id: "1",
            name: "MaiinSight Database",
            type: "database",
            status: "connected",
            lastSync: formatSyncValue(latestImportBatch?.updatedAt || latestImportBatch?.createdAt),
            records: importBatchCount,
          },
          {
            id: "2",
            name: "Meta Graph API",
            type: "api",
            status: "connected",
            lastSync: formatSyncValue(latestMetaRawResponse?.fetchedAt),
            records: metaRawCount,
          },
          {
            id: "3",
            name: "AI Strategy Engine",
            type: "api",
            status: "connected",
            lastSync: formatSyncValue(latestAiStrategyLog?.createdAt),
            records: aiStrategyCount,
          },
        ],
        recentActivities,
        totalNotifications,
      },
    });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.post("/activity", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const { action, metadata } = req.body;
    const log = await prisma.activityLog.create({
      data: {
        userId: req.user.userId,
        action,
        metadata,
      },
    });

    res.status(201).json({ log });
  } catch (error) {
    next(error);
  }
});
