import { APP_SETTING_KEYS } from "./appConfig.service.js"

const hasText = (value) => Boolean(String(value || "").trim())

export const buildSafeIntegrationStatus = ({ config, aiProviderStatus }) => ({
  gemini: {
    configured: Boolean(config.geminiApiKey),
    enabled: config.geminiEnabled,
    connected: Boolean(aiProviderStatus.configured),
    provider: aiProviderStatus.provider,
    providerLabel: aiProviderStatus.providerLabel,
    model: aiProviderStatus.model,
  },
  meta: {
    configured: Boolean(config.metaAccessToken && config.metaIgUserId),
    enabled: config.metaEnabled,
    connected: Boolean(config.metaAccessToken && config.metaIgUserId) && config.metaEnabled,
    graphVersion: config.metaGraphVersion,
  },
})

export const buildSafeIntegrationConfig = (config) => ({
  geminiApiKeyConfigured: Boolean(config.geminiApiKey),
  geminiModel: config.geminiModel,
  geminiEnabled: config.geminiEnabled,
  metaAccessTokenConfigured: Boolean(config.metaAccessToken),
  metaIgUserId: config.metaIgUserId,
  metaGraphVersion: config.metaGraphVersion,
  metaEnabled: config.metaEnabled,
})

export const buildIntegrationSettingsUpdate = (input, currentConfig) => {
  const entries = {
    [APP_SETTING_KEYS.GEMINI_MODEL]:
      input.geminiModel ?? currentConfig.geminiModel,
    [APP_SETTING_KEYS.GEMINI_ENABLED]:
      input.geminiEnabled === true || input.geminiEnabled === "true"
        ? "true"
        : input.geminiEnabled === false || input.geminiEnabled === "false"
          ? "false"
          : currentConfig.geminiEnabled
            ? "true"
            : "false",
    [APP_SETTING_KEYS.META_IG_USER_ID]:
      input.metaIgUserId ?? currentConfig.metaIgUserId,
    [APP_SETTING_KEYS.META_GRAPH_VERSION]:
      input.metaGraphVersion ?? currentConfig.metaGraphVersion,
    [APP_SETTING_KEYS.META_ENABLED]:
      input.metaEnabled === true || input.metaEnabled === "true"
        ? "true"
        : input.metaEnabled === false || input.metaEnabled === "false"
          ? "false"
          : currentConfig.metaEnabled
            ? "true"
            : "false",
  }

  if (hasText(input.geminiApiKey)) {
    entries[APP_SETTING_KEYS.GEMINI_API_KEY] = String(input.geminiApiKey).trim()
  }
  if (hasText(input.metaAccessToken)) {
    entries[APP_SETTING_KEYS.META_ACCESS_TOKEN] = String(input.metaAccessToken).trim()
  }
  return entries
}
