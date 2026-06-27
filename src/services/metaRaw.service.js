import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

const GRAPH_VERSION = env.metaApiVersion;
const ACCESS_TOKEN = env.metaAccessToken;

function sanitizeParams(params) {
  const cleanParams = { ...params };
  delete cleanParams.access_token;
  return cleanParams;
}

export async function metaGet(endpoint, params = {}) {
  if (!ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is not configured.");
  }

  const cleanEndpoint = endpoint.replace(/^\//, "");
  const baseUrl = env.metaApiBaseUrl || "https://graph.facebook.com";
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${GRAPH_VERSION}/${cleanEndpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  url.searchParams.set("access_token", ACCESS_TOKEN);

  try {
    const response = await fetch(url);
    const data = await response.json();

    await prisma.metaRawResponse.create({
      data: {
        source: "META_INSTAGRAM_API",
        endpoint: `/${cleanEndpoint}`,
        method: "GET",
        params: sanitizeParams(params),
        responseJson: data,
        status: response.ok && !data.error ? "SUCCESS" : "FAILED",
        errorMessage: data.error?.message || null,
      },
    });

    if (!response.ok || data.error) {
      throw new Error(data.error?.message || "Meta API request failed");
    }

    return data;
  } catch (error) {
    await prisma.metaRawResponse.create({
      data: {
        source: "META_INSTAGRAM_API",
        endpoint: `/${cleanEndpoint}`,
        method: "GET",
        params: sanitizeParams(params),
        responseJson: null,
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Meta API request failed",
      },
    });

    throw error;
  }
}
