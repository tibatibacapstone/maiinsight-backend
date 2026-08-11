import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

export const APP_SETTING_KEYS = {
  GEMINI_API_KEY: "GEMINI_API_KEY",
  GEMINI_MODEL: "GEMINI_MODEL",
  GEMINI_ENABLED: "GEMINI_ENABLED",
  META_IG_USER_ID: "META_IG_USER_ID",
  META_ACCESS_TOKEN: "META_ACCESS_TOKEN",
  META_GRAPH_VERSION: "META_GRAPH_VERSION",
  META_ENABLED: "META_ENABLED",
  GEMINI_DAILY_LIMIT: "GEMINI_DAILY_LIMIT",
  GEMINI_MONTHLY_LIMIT: "GEMINI_MONTHLY_LIMIT",
  LAST_TOKEN_CHECK: "LAST_TOKEN_CHECK",
};

const normalizeValue = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

export const readAppSettings = async (keys) => {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
  });

  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return keys.reduce((acc, key) => {
    acc[key] = map[key];
    return acc;
  }, {});
};

export const writeAppSettings = async (entries) => {
  const items = Object.entries(entries).map(([key, value]) =>
    prisma.appSetting.upsert({
      where: { key },
      update: { value: normalizeValue(value) },
      create: { key, value: normalizeValue(value) },
    })
  );

  return prisma.$transaction(items);
};

export const buildConfigSnapshot = async () => {
  const settings = await readAppSettings(Object.values(APP_SETTING_KEYS));
  return {
    geminiApiKey: settings[APP_SETTING_KEYS.GEMINI_API_KEY] || env.geminiApiKey,
    geminiModel: settings[APP_SETTING_KEYS.GEMINI_MODEL] || env.geminiModel || "gemini-1.5-flash",
    geminiEnabled: (settings[APP_SETTING_KEYS.GEMINI_ENABLED] || "true") === "true",
    metaIgUserId: settings[APP_SETTING_KEYS.META_IG_USER_ID] || env.metaIgUserId,
    metaAccessToken: settings[APP_SETTING_KEYS.META_ACCESS_TOKEN] || env.metaAccessToken,
    metaGraphVersion: settings[APP_SETTING_KEYS.META_GRAPH_VERSION] || env.metaApiVersion || "v25.0",
    metaEnabled: (settings[APP_SETTING_KEYS.META_ENABLED] || "true") === "true",
    geminiDailyLimit: settings[APP_SETTING_KEYS.GEMINI_DAILY_LIMIT] || "",
    geminiMonthlyLimit: settings[APP_SETTING_KEYS.GEMINI_MONTHLY_LIMIT] || "",
    lastTokenCheck: settings[APP_SETTING_KEYS.LAST_TOKEN_CHECK] || "",
  };
};

export const parseDatabaseName = (databaseUrl) => {
  try {
    if (!databaseUrl) return "";
    const url = new URL(databaseUrl);
    return url.pathname.replace(/^\//, "");
  } catch {
    return "";
  }
};
