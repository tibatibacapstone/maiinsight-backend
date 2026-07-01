import { env } from "../config/env.js";

export const errorHandler = (error, req, res, next) => {
  void req;
  void next;

  const statusCode = error.statusCode || error.status || 500;
  const technicalMessage =
    error.technicalMessage ||
    (error instanceof Error ? error.message : "Internal server error");

  res.status(statusCode).json({
    success: false,
    errorCode: error.errorCode,
    message: error.message || "Internal server error",
    suggestion: error.suggestion,
    technicalMessage: env.nodeEnv === "production" ? undefined : technicalMessage,
    details: error.details,
    stack: env.nodeEnv === "production" ? undefined : error.stack,
  });
};
