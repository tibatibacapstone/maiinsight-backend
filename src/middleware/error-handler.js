import { env } from "../config/env.js";

export const errorHandler = (error, req, res, next) => {
  void req;
  void next;

  const statusCode = error.statusCode || error.status || 500;

  res.status(statusCode).json({
    message: error.message || "Internal server error",
    stack: env.nodeEnv === "production" ? undefined : error.stack,
  });
};