import { env } from "../config/env.js";

const isSafeClientError = (error) => {
  if (!error || typeof error !== "object") return false;

  if (typeof error.errorCode === "string" && error.errorCode.length > 0) return true;

  return Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
};

export const errorHandler = (error, req, res, next) => {
  void req;
  void next;

  const statusCode = error.statusCode || error.status || 500;
  const technicalMessage =
    error.technicalMessage ||
    (error instanceof Error ? error.message : "Internal server error");

  if (statusCode >= 500) {
    console.error(`[ErrorHandler] ${statusCode}: ${technicalMessage}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }

  const userMessage =
    isSafeClientError(error) && error.message
      ? error.message
      : "Internal server error. Please try again.";

  res.status(statusCode).json({
    success: false,
    errorCode: error.errorCode,
    message: userMessage,
    suggestion: error.suggestion,
    technicalMessage: env.nodeEnv === "production" ? undefined : technicalMessage,
    details: error.details,
    stack: env.nodeEnv === "production" ? undefined : error.stack,
  });
};
