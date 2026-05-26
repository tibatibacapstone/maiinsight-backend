import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { aiStrategyRouter } from "./aiStrategyRoute.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/ai-strategy", aiStrategyRouter);

// Temporary disabled because Prisma/database is not configured yet
// import { authRouter } from "./auth.routes.js";
// import { dashboardRouter } from "./dashboard.routes.js";
// apiRouter.use("/auth", authRouter);
// apiRouter.use("/dashboard", dashboardRouter);

apiRouter.get("/", (req, res) => {
  res.json({
    name: "MaiinSight API",
    version: "1.0.0",
    status: "ready",
    database: "disabled temporarily",
    ai: "gemini enabled",
  });
});
