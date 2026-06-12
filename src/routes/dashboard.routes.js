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
    const recentActivities = await prisma.activityLog.findMany({ take: 10, orderBy: { createdAt: "desc" } });
    const totalNotifications = await prisma.notification.count();

    res.json({
      dataCenter: {
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
