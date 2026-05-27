import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { authRouter } from "./auth.routes.js";
import { dashboardRouter } from "./dashboard.routes.js";
import { aiStrategyRouter } from "./aiStrategyRoute.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/dashboard", dashboardRouter);
apiRouter.use("/ai-strategy", aiStrategyRouter);

apiRouter.get("/", (req, res) => {
  res.json({
    name: "MaiinSight API",
    version: "1.0.0",
    status: "ready",
    database: "enabled",
    ai: "gemini enabled",
  });
});