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

export const isAzureAiConfigured = () =>
  Boolean(
    env.azureOpenAiEndpoint &&
      env.azureOpenAiApiKey &&
      env.azureOpenAiDeployment &&
      env.azureOpenAiApiVersion
  );

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

const buildStrategyPrompt = (strategyContext) => {
  const safeContext = redactSensitiveFields(strategyContext);

  return {
    system: `You are MaiinSight AI Strategy Assistant for Maiin Gandaria.
You help business users create practical marketing strategies from summarized operational data.
Never ask for credentials. Never expose technical provider details. Never include personal customer data.
Use only the provided summarized context. If context is incomplete, mention the limitation in caveats.
Return valid JSON only.`,
    user: `Create exactly one structured business strategy JSON object with these keys:
{
  "campaignObjective": "",
  "targetCustomerGroup": "",
  "suggestedOfferPromo": "",
  "messageAngle": "",
  "recommendedChannel": "",
  "followUpAction": "",
  "expectedBusinessImpact": "",
  "caveats": ["", ""],
  "outreachMessage": "",
  "followUpScript": ""
}

Business context:
${JSON.stringify(safeContext, null, 2)}

Rules:
- Keep each field business-friendly and concise.
- If workspace mode implies low occupancy outreach, make the outreachMessage and followUpScript directly usable.
- Recommended channel must be specific, such as WhatsApp broadcast, Instagram Story, Instagram Feed, or direct outbound follow-up.
- Expected business impact should describe likely occupancy/revenue outcome, not guaranteed results.
- Caveats must be an array with 1 to 3 realistic limitations.
- Do not wrap the JSON in markdown fences.`,
  };
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

export async function generateMaiinStrategy(strategyContext) {
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

  const prompt = buildStrategyPrompt(strategyContext);
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
        max_tokens: 900,
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

  const content = parseAzureContent(payload);

  try {
    const parsed = JSON.parse(content);

    return {
      provider: "azure_openai",
      strategy: {
        campaignObjective: String(parsed.campaignObjective || "Data unavailable"),
        targetCustomerGroup: String(parsed.targetCustomerGroup || "Data unavailable"),
        suggestedOfferPromo: String(parsed.suggestedOfferPromo || "Data unavailable"),
        messageAngle: String(parsed.messageAngle || "Data unavailable"),
        recommendedChannel: String(parsed.recommendedChannel || "Data unavailable"),
        followUpAction: String(parsed.followUpAction || "Data unavailable"),
        expectedBusinessImpact: String(parsed.expectedBusinessImpact || "Data unavailable"),
        caveats: Array.isArray(parsed.caveats)
          ? parsed.caveats.map((item) => String(item)).filter(Boolean).slice(0, 3)
          : ["Generated response did not include caveats."],
        outreachMessage: String(parsed.outreachMessage || ""),
        followUpScript: String(parsed.followUpScript || ""),
      },
    };
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_GENERATION_FAILED",
      message: "AI strategy could not be generated.",
      suggestion: "Please try again or contact IT Support if the issue continues.",
      technicalMessage:
        error instanceof Error
          ? `Azure OpenAI returned invalid JSON: ${error.message}`
          : "Azure OpenAI returned invalid JSON.",
    });
  }
}
