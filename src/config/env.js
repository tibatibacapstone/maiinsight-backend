import dotenv from "dotenv";

dotenv.config();

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: toNumber(process.env.PORT, 5000),
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "supersecretkey",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  metaApiBaseUrl: process.env.META_API_BASE_URL || "https://graph.facebook.com",
  metaAccessToken: process.env.META_ACCESS_TOKEN || "",
};
