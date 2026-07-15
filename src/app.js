import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { apiRouter } from "./routes/index.js";

export const app = express();

app.use(helmet());

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  }),
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

if (env.nodeEnv !== "test") {
  app.use(morgan("dev"));
}

/**
 * Root endpoint
 */
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "MaiinSight API is running",
  });
});

/**
 * Health-check endpoint
 * Digunakan untuk memastikan backend aktif.
 */
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "MaiinSight API",
    status: "healthy",
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Application API routes
 */
app.use("/api", apiRouter);

// 404 dan error handler harus paling bawah.
app.use(notFound);
app.use(errorHandler);