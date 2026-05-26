import { Router } from "express";

import { healthRouter } from "./health.routes.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);

apiRouter.get("/", (req, res) => {
  res.json({
    name: "MaiinSight API",
    version: "1.0.0",
    status: "ready",
  });
});
