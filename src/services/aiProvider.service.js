import { GoogleGenAI } from "@google/genai";

import { prisma } from "../config/prisma.js";
import { buildConfigSnapshot } from "./appConfig.service.js";

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

export const isGeminiConfigured = async () => {
  const config = await buildConfigSnapshot();
  return Boolean(config.geminiApiKey);
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
Keep strategy fields professional, concise, action-oriented, and suitable for a business dashboard. For WhatsApp copy, use a warm, friendly, natural admin tone. When the mode is overview_summary, ground the audience recommendation in the supplied business signals instead of generic assumptions.
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
- WhatsApp message must be ready to use, warm, friendly, conversational, concise, and not too pushy. Use a natural Indonesian admin tone with "Kak" when appropriate.
- If business_context.slotTimeLabel or business_context.sessionStartHour/sessionEndHour exists, whatsappMessage must clearly mention the exact slot time and date. Do not only say Morning/Afternoon/Evening/Night.
- Follow-up plan must be concrete and operationally actionable.
- Expected business impact must describe likely occupancy, conversion, or revenue effect without guarantees.
- Data limitation must clearly mention missing or weak data if any context is incomplete.
- If low occupancy outreach context exists, tailor the WhatsApp message and follow-up plan to that context.
- For overview_summary mode, use the provided planning_context, audience_context, transaction_signal_context, business_context, and customer_segment_summary to infer the best audience from real observed patterns. Frame it as next-month planning guidance, not a generic description of the current state.
- Do not claim a customer group such as "never tried night" unless the provided context explicitly supports that statement.
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

const isLowOccupancyOutreachContext = (strategyContext) =>
  strategyContext?.selected_filters?.mode === "low_occupancy_outreach" ||
  Boolean(strategyContext?.business_context?.lowOccupancyTargeting);

const getOutreachSlotLabel = (strategyContext) => {
  const businessContext = strategyContext?.business_context || {};

  if (businessContext.slotTimeLabel) {
    return String(businessContext.slotTimeLabel);
  }

  if (businessContext.sessionStartHour && businessContext.sessionEndHour) {
    return String(businessContext.sessionStartHour) + " - " + String(businessContext.sessionEndHour);
  }

  return null;
};

const ensureOutreachSlotInWhatsappMessage = (strategy, strategyContext) => {
  if (!isLowOccupancyOutreachContext(strategyContext)) return strategy;

  const slotLabel = getOutreachSlotLabel(strategyContext);
  if (!slotLabel) return strategy;

  const dateLabel = strategyContext?.business_context?.date
    ? String(strategyContext.business_context.date)
    : "tanggal yang dipilih";
  const currentMessage = toReadableText(strategy?.whatsappMessage).trim();
  const normalizedMessage = currentMessage.toLowerCase();
  const normalizedSlot = slotLabel.toLowerCase();
  const [slotStart, slotEnd] = slotLabel.split("-").map((value) => value.trim().toLowerCase());
  const alreadyMentionsSlot =
    normalizedMessage.includes(normalizedSlot) ||
    (slotStart && slotEnd && normalizedMessage.includes(slotStart) && normalizedMessage.includes(slotEnd));

  if (alreadyMentionsSlot) return strategy;

  const slotSentence = "Slot yang kami tawarkan: " + dateLabel + ", jam " + slotLabel + ".";
  const friendlyClose = "Kalau Kakak tertarik, kami bantu cek ketersediaannya ya.";

  return {
    ...strategy,
    whatsappMessage: currentMessage
      ? currentMessage + " " + slotSentence + " " + friendlyClose
      : "Halo Kak, kami dari Maiin Gandaria. " + slotSentence + " " + friendlyClose,
  };
};

const parseJsonResponse = (text, providerLabel) => {
  const trimmedText = typeof text === "string" ? text.trim() : "";

  if (!trimmedText) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage: `${providerLabel} returned an empty response.`,
    });
  }

  try {
    return JSON.parse(trimmedText);
  } catch (error) {
    const jsonMatch = trimmedText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to shared error below
      }
    }

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

const generateWithGemini = async (strategyContext) => {
  const config = await buildConfigSnapshot();
  const geminiApiKey = config.geminiApiKey;
  const geminiModel = config.geminiModel || "gemini-1.5-flash";

  if (!geminiApiKey) {
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
    apiKey: geminiApiKey,
  });

  let response;
  let rawText = "";

  try {
      response = await ai.models.generateContent({
      model: geminiModel,
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
      typeof response?.text === "string"
        ? response.text
        : typeof response?.text === "function"
          ? await response.text()
          : Array.isArray(response?.candidates?.[0]?.content?.parts)
            ? response.candidates[0].content.parts
                .map((part) => (typeof part?.text === "string" ? part.text : ""))
                .join("")
                .trim()
            : "";
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage: error instanceof Error ? error.message : "Gemini request failed.",
    });
  }

  try {
    const usage = response?.usageMetadata;
    if (usage) {
      await prisma.geminiUsageLog.create({
        data: {
          userId: strategyContext?.userId || null,
          model: geminiModel,
          feature: "generate_strategy",
          promptTokens: usage.promptTokenCount ?? 0,
          candidatesTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        },
      });
    }
  } catch (_) {
    /* non-critical */
  }

  const parsed = (() => {
    try {
      return parseJsonResponse(rawText, "Gemini");
    } catch {
      return null;
    }
  })();

  if (!parsed) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage: "Gemini returned invalid JSON.",
    });
  }

  return {
    provider: "gemini",
    model: geminiModel,
    strategy: ensureOutreachSlotInWhatsappMessage(normalizeStrategy(parsed), strategyContext),
    rawText,
  };
};

export const getAiProviderStatus = async () => {
  const config = await buildConfigSnapshot();
  const configured = Boolean(config.geminiApiKey) && config.geminiEnabled;

  return {
    provider: "gemini",
    providerLabel: "Gemini",
    configured,
    enabled: config.geminiEnabled,
    model: config.geminiModel || "gemini-1.5-flash",
    setupMessage: configured ? null : "AI strategy generation is not configured yet.",
    suggestion: configured
      ? null
      : "Please ask IT Support to configure Gemini API credentials in the environment settings.",
  };
};

export const generateStrategy = async (strategyContext) => {
  const config = await buildConfigSnapshot();
  if (!config.geminiEnabled) {
    throw createAiServiceError({
      errorCode: "AI_DISABLED",
      message: "AI strategy generation is currently disabled.",
      suggestion: "Please ask IT Support to enable the AI integration in System Settings.",
      technicalMessage: "Gemini integration is disabled via System Settings toggle.",
      statusCode: 503,
    });
  }
  return generateWithGemini(strategyContext);
};
