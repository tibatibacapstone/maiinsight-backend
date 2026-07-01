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
  appUrl: process.env.APP_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "supersecretkey",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: toNumber(process.env.SMTP_PORT, 587),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@maiin.com",
  aiProvider: (process.env.AI_PROVIDER || "").trim().toLowerCase(),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "",
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
  metaApiBaseUrl: process.env.META_API_BASE_URL || "https://graph.facebook.com",
  metaApiVersion: process.env.META_API_VERSION || process.env.META_GRAPH_VERSION || "v25.0",
  metaAccessToken: process.env.META_ACCESS_TOKEN || "",
  metaIgUserId: process.env.META_IG_USER_ID || "",
  metaPageId: process.env.META_PAGE_ID || "",
};
