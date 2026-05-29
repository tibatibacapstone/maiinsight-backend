import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { apiRouter } from "./routes/index.js";
import metaRoutes from "./routes/meta.routes.js";

export const app = express();

app.use(helmet());

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

if (env.nodeEnv !== "test") {
  app.use(morgan("dev"));
}

app.get("/", (req, res) => {
  res.json({
    message: "MaiinSight API is running",
  });
});

// Meta API routes
app.use("/api/meta", metaRoutes);

// Existing API routes
app.use("/api", apiRouter);

// 404 dan error handler harus paling bawah
app.use(notFound);
app.use(errorHandler);
