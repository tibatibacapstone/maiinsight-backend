import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { buildConfigSnapshot } from "./appConfig.service.js";

const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 2000;

function sanitizeParams(params) {
  const cleanParams = { ...params };
  delete cleanParams.access_token;
  return cleanParams;
}

function isRateLimited(data) {
  return (
    data?.error?.code === 4 ||
    data?.error?.error_subcode === 4 ||
    data?.error?.message?.includes("rate limit") ||
    data?.error?.message?.includes("Rate limit")
  );
}

function isTokenExpired(data) {
  return (
    data?.error?.code === 190 ||
    data?.error?.error_subcode === 463 ||
    data?.error?.error_subcode === 467 ||
    data?.error?.message?.includes("OAuthException") ||
    data?.error?.message?.includes("expired") ||
    data?.error?.message?.includes("Session has expired")
  );
}

function isTransientError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("network")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function metaGet(endpoint, params = {}) {
  const config = await buildConfigSnapshot();
  const graphVersion = config.metaGraphVersion || env.metaApiVersion;
  const accessToken = config.metaAccessToken || env.metaAccessToken;

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN is not configured.");
  }

  const cleanEndpoint = endpoint.replace(/^\//, "");
  const baseUrl = env.metaApiBaseUrl || "https://graph.facebook.com";
  const fullUrl = `${baseUrl.replace(/\/$/, "")}/${graphVersion}/${cleanEndpoint}`;

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const url = new URL(fullUrl);

    Object.entries(params).forEach(([key, value]) => {
      if (key === "after" && (value === undefined || value === null || value === "")) return;
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    url.searchParams.set("access_token", accessToken);

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (response.ok && !data.error) {
        await prisma.metaRawResponse.create({
          data: {
            source: "META_INSTAGRAM_API",
            endpoint: `/${cleanEndpoint}`,
            method: "GET",
            params: sanitizeParams(params),
            responseJson: data,
            status: "SUCCESS",
            errorMessage: null,
          },
        }).catch(() => null);

        return data;
      }

      if (isTokenExpired(data)) {
        const msg = data.error?.message || "Meta access token has expired. Please update the token in Settings.";
        await logFailedResponse(cleanEndpoint, params, msg);
        throw new Error(msg);
      }

      if (isRateLimited(data) && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[metaGet] Rate limited on /${cleanEndpoint}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      const msg = data.error?.message || "Meta API request failed";
      await logFailedResponse(cleanEndpoint, params, msg);
      throw new Error(msg);
    } catch (error) {
      if (error.message?.includes("access token") || error.message?.includes("expired")) {
        throw error;
      }

      if (isTransientError(error.message) && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[metaGet] Transient error on /${cleanEndpoint}: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        lastError = error;
        continue;
      }

      if (attempt === MAX_RETRIES) {
        const msg = isTransientError(error.message)
          ? `Meta API unreachable after ${MAX_RETRIES + 1} attempts: ${error.message}`
          : error.message || "Meta API request failed";
        await logFailedResponse(cleanEndpoint, params, msg);
        throw new Error(msg);
      }

      lastError = error;
    }
  }

  const msg = lastError?.message || "Meta API request failed after retries";
  await logFailedResponse(cleanEndpoint, params, msg);
  throw new Error(msg);
}

async function logFailedResponse(endpoint, params, errorMessage) {
  await prisma.metaRawResponse.create({
    data: {
      source: "META_INSTAGRAM_API",
      endpoint: `/${endpoint}`,
      method: "GET",
      params: sanitizeParams(params),
      responseJson: null,
      status: "FAILED",
      errorMessage,
    },
  }).catch(() => null);
}
