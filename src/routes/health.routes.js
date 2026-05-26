import { Router } from "express";

import { checkDatabaseConnection } from "../config/database.js";

export const healthRouter = Router();

healthRouter.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "maiinsight-backend",
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/database", async (req, res, next) => {
  try {
    const database = await checkDatabaseConnection();
    res.status(database.ok ? 200 : 503).json(database);
  } catch (error) {
    next(error);
  }
});
