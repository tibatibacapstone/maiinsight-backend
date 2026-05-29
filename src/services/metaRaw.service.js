import { prisma } from "../config/prisma.js";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

function sanitizeParams(params) {
  const cleanParams = { ...params };
  delete cleanParams.access_token;
  return cleanParams;
}

export async function metaGet(endpoint, params = {}) {
  const cleanEndpoint = endpoint.replace(/^\//, "");
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${cleanEndpoint}`);

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
        errorMessage: error.message,
      },
    });

    throw error;
  }
}