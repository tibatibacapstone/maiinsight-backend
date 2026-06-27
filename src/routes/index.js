import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { authRouter } from "./auth.routes.js";
import { dashboardRouter } from "./dashboard.routes.js";
import { aiStrategyRouter } from "./aiStrategyRoute.js";
import { importRouter } from "./importRoutes.js";
import { metaRouter } from "./meta.routes.js";
import { mlRouter } from "./ml.routes.js";
import { segmentationRouter } from "./segmentation.routes.js";
import { targetingRouter } from "./targeting.routes.js";
import { operationsRouter } from "./operations.routes.js";
import { systemRouter } from "./system.routes.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/dashboard", dashboardRouter);
apiRouter.use("/operations", operationsRouter);
apiRouter.use("/system", systemRouter);
apiRouter.use("/ai-strategy", aiStrategyRouter);
apiRouter.use("/imports", importRouter);
apiRouter.use("/meta", metaRouter);
apiRouter.use("/ml", mlRouter);
apiRouter.use("/segmentation", segmentationRouter);
apiRouter.use("/targeting", targetingRouter);

apiRouter.get("/", (req, res) => {
  res.json({
    name: "MaiinSight API",
    version: "1.0.0",
    status: "ready",
    database: "enabled",
    ai: "azure ai integration ready",
  });
});
