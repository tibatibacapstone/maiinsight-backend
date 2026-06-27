import { GoogleGenAI } from "@google/genai";

import { env } from "../config/env.js";

const REDACTED_KEYS = new Set([
  "customername",
  "customer_name",
  "email",
  "phone",
  "phonenumber",
  "no_telepon",
  "notelepon",
  "customerkey",
]);

const createAiServiceError = ({
  errorCode,
  message,
  suggestion,
  technicalMessage,
  statusCode = 500,
}) => {
  const error = new Error(message);
  error.errorCode = errorCode;
  error.suggestion = suggestion;
  error.technicalMessage = technicalMessage;
  error.statusCode = statusCode;
  return error;
};

const redactSensitiveFields = (value) => {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        if (REDACTED_KEYS.has(String(key).toLowerCase())) {
          return [key, "[REDACTED]"];
        }

        return [key, redactSensitiveFields(nestedValue)];
      })
    );
  }

  return value;
};

export const isGeminiConfigured = () => Boolean(env.geminiApiKey);

export const isAzureAiConfigured = () =>
  Boolean(
    env.azureOpenAiEndpoint &&
      env.azureOpenAiApiKey &&
      env.azureOpenAiDeployment &&
      env.azureOpenAiApiVersion
  );

const resolveSelectedProvider = () => {
  if (env.aiProvider === "azure") {
    return "azure";
  }

  if (env.aiProvider === "gemini") {
    return "gemini";
  }

  if (isGeminiConfigured()) {
    return "gemini";
  }

  return "gemini";
};

const getLanguagePreference = (strategyContext) =>
  strategyContext?.languagePreference ||
  strategyContext?.language ||
  strategyContext?.selected_filters?.language ||
  "Bahasa Indonesia";

const buildPrompt = (strategyContext) => {
  const safeContext = redactSensitiveFields(strategyContext);
  const languagePreference = getLanguagePreference(strategyContext);
  const workspaceMode = strategyContext?.selected_filters?.mode || "general_strategy";

  return {
    system: `You are MaiinSight AI Strategy Assistant for Maiin Gandaria.
You help Marketing Operational users create practical campaign recommendations from summarized business data.
Use only the data provided in the prompt. Never invent unavailable metrics. Never include personal customer data.
Keep the tone professional, concise, action-oriented, and suitable for a business dashboard.
Unless another language is explicitly requested, write the response in Bahasa Indonesia.
Return valid JSON only.`,
    user: `Create exactly one business strategy JSON object with this structure:
{
  "campaignObjective": "",
  "targetCustomerGroup": "",
  "customerReasoning": "",
  "suggestedOffer": "",
  "whatsappMessage": "",
  "followUpPlan": "",
  "expectedBusinessImpact": "",
  "dataLimitation": ""
}

Business context for Maiin Gandaria:
${JSON.stringify(safeContext, null, 2)}

Requirements:
- Language: ${languagePreference}.
- Workspace mode: ${workspaceMode}.
- Campaign objective must match the provided business context.
- Target customer group must mention the segment or outreach target if available.
- Customer behavior reasoning must explain why this group should be prioritized based on the provided context.
- Suggested offer must be realistic for a sports venue campaign.
- WhatsApp message must be ready to use, professional, concise, and not too pushy.
- Follow-up plan must be concrete and operationally actionable.
- Expected business impact must describe likely occupancy, conversion, or revenue effect without guarantees.
- Data limitation must clearly mention missing or weak data if any context is incomplete.
- If low occupancy outreach context exists, tailor the WhatsApp message and follow-up plan to that context.
- Every field in the JSON object must be a plain string. Do not return nested objects or arrays.
- Do not wrap the JSON in markdown fences.`,
  };
};

const toReadableText = (value) => {
  if (Array.isArray(value)) {
    return value.map(toReadableText).filter(Boolean).join(" ");
  }

  if (value && typeof value === "object") {
    if (typeof value.message === "string") {
      return value.message;
    }

    if (typeof value.description === "string") {
      return value.description;
    }

    return Object.entries(value)
      .map(([key, nestedValue]) => `${key}: ${toReadableText(nestedValue)}`)
      .join(" | ");
  }

  return value == null ? "" : String(value);
};

const normalizeStrategy = (parsed) => ({
  campaignObjective: toReadableText(parsed?.campaignObjective) || "Data belum cukup untuk menyusun objective yang spesifik.",
  targetCustomerGroup: toReadableText(parsed?.targetCustomerGroup) || "Data target customer belum tersedia.",
  customerReasoning: toReadableText(parsed?.customerReasoning) || "Alasan prioritas customer belum dapat dijelaskan dari data yang tersedia.",
  suggestedOffer: toReadableText(parsed?.suggestedOffer) || "Belum ada usulan promo yang dapat disusun dari data saat ini.",
  whatsappMessage: toReadableText(parsed?.whatsappMessage) || "Belum ada draft pesan WhatsApp yang dapat dibuat dari data saat ini.",
  followUpPlan: toReadableText(parsed?.followUpPlan) || "Belum ada rencana tindak lanjut yang dapat disusun dari data saat ini.",
  expectedBusinessImpact: toReadableText(parsed?.expectedBusinessImpact) || "Dampak bisnis belum dapat diperkirakan karena konteks data masih terbatas.",
  dataLimitation: toReadableText(parsed?.dataLimitation) || "Beberapa data penting untuk strategi ini belum tersedia atau belum lengkap.",
});

const parseJsonResponse = (text, providerLabel) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage:
        error instanceof Error
          ? `${providerLabel} returned invalid JSON: ${error.message}`
          : `${providerLabel} returned invalid JSON.`,
    });
  }
};

const parseAzureContent = (payload) => {
  const rawContent = payload?.choices?.[0]?.message?.content;

  if (typeof rawContent === "string") {
    return rawContent;
  }

  if (Array.isArray(rawContent)) {
    return rawContent
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("\n")
      .trim();
  }

  return "";
};

const generateWithGemini = async (strategyContext) => {
  if (!isGeminiConfigured()) {
    throw createAiServiceError({
      errorCode: "GEMINI_NOT_CONFIGURED",
      message: "AI strategy generation is not configured yet.",
      suggestion:
        "Please ask IT Support to configure Gemini API credentials in the environment settings.",
      technicalMessage: "Missing GEMINI_API_KEY for Gemini provider.",
      statusCode: 503,
    });
  }

  const prompt = buildPrompt(strategyContext);
  const ai = new GoogleGenAI({
    apiKey: env.geminiApiKey,
  });

  let response;
  let rawText = "";

  try {
    response = await ai.models.generateContent({
      model: env.geminiModel,
      contents: `${prompt.system}\n\n${prompt.user}`,
      config: {
        temperature: 0.4,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    rawText =
      typeof response?.text === "function"
        ? await response.text()
        : typeof response?.text === "string"
          ? response.text
          : "";
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage: error instanceof Error ? error.message : "Gemini request failed.",
    });
  }

  const parsed = parseJsonResponse(rawText, "Gemini");

  return {
    provider: "gemini",
    model: env.geminiModel,
    strategy: normalizeStrategy(parsed),
    rawText,
  };
};

const generateWithAzure = async (strategyContext) => {
  if (!isAzureAiConfigured()) {
    throw createAiServiceError({
      errorCode: "AZURE_AI_NOT_CONFIGURED",
      message: "AI strategy generation is not configured yet.",
      suggestion:
        "Please ask IT Support to configure Azure AI credentials in the environment settings.",
      technicalMessage:
        "Missing one or more Azure OpenAI environment variables: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION.",
      statusCode: 503,
    });
  }

  const prompt = buildPrompt(strategyContext);
  const endpoint = `${env.azureOpenAiEndpoint.replace(/\/$/, "")}/openai/deployments/${env.azureOpenAiDeployment}/chat/completions?api-version=${encodeURIComponent(env.azureOpenAiApiVersion)}`;

  let response;
  let payload;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": env.azureOpenAiApiKey,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.4,
        max_tokens: 1200,
        response_format: {
          type: "json_object",
        },
      }),
    });

    payload = await response.json().catch(() => null);
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage: error instanceof Error ? error.message : "Azure OpenAI request failed.",
    });
  }

  if (!response?.ok) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage:
        payload?.error?.message || `Azure OpenAI request failed with status ${response?.status || "unknown"}.`,
    });
  }

  const rawText = parseAzureContent(payload);
  const parsed = parseJsonResponse(rawText, "Azure OpenAI");

  return {
    provider: "azure",
    model: env.azureOpenAiDeployment,
    strategy: normalizeStrategy(parsed),
    rawText,
  };
};

export const getAiProviderStatus = () => {
  const provider = resolveSelectedProvider();
  const configured = provider === "azure" ? isAzureAiConfigured() : isGeminiConfigured();

  return {
    provider,
    providerLabel: provider === "azure" ? "Azure OpenAI" : "Gemini",
    configured,
    model: provider === "azure" ? env.azureOpenAiDeployment || null : env.geminiModel || null,
    setupMessage: configured ? null : "AI strategy generation is not configured yet.",
    suggestion: configured
      ? null
      : provider === "azure"
        ? "Please ask IT Support to configure Azure AI credentials in the environment settings."
        : "Please ask IT Support to configure Gemini API credentials in the environment settings.",
  };
};

export const generateStrategy = async (strategyContext) => {
  const provider = resolveSelectedProvider();

  if (provider === "azure") {
    return generateWithAzure(strategyContext);
  }

  return generateWithGemini(strategyContext);
};
