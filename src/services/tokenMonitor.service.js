import { prisma } from "../config/prisma.js"
import { buildConfigSnapshot, APP_SETTING_KEYS, writeAppSettings } from "./appConfig.service.js"
import { createNotificationsForRoles } from "./notification.service.js"
import { sendBulkRoleEmail } from "./email.service.js"

const IT_SUPPORT_ROLE = "it_support"

const buildDaysRemaining = (expiresAt) => {
  const diff = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.floor(diff / 86400000))
}

const checkMetaToken = async () => {
  const config = await buildConfigSnapshot()

  if (!config.metaAccessToken || !config.metaEnabled) {
    return { status: "not_configured", expiresAt: null, daysRemaining: null }
  }

  try {
    const baseUrl = process.env.META_API_BASE_URL || "https://graph.facebook.com"
    const version = config.metaGraphVersion || "v25.0"
    const debugUrl = `${baseUrl.replace(/\/$/, "")}/${version}/debug_token?input_token=${config.metaAccessToken}&access_token=${config.metaAccessToken}`
    const res = await fetch(debugUrl)
    const data = await res.json()

    if (!res.ok || data.error) {
      return { status: "error", expiresAt: null, daysRemaining: null, error: data.error?.message }
    }

    const expiresAt = data.data?.data_access_expires_at
      ? new Date(data.data.data_access_expires_at * 1000).toISOString()
      : null

    if (!expiresAt) {
      return { status: "unknown", expiresAt: null, daysRemaining: null }
    }

    const daysRemaining = buildDaysRemaining(expiresAt)

    if (daysRemaining <= 0) {
      return { status: "expired", expiresAt, daysRemaining: 0 }
    }

    if (daysRemaining <= 7) {
      return { status: "critical", expiresAt, daysRemaining }
    }

    if (daysRemaining <= 30) {
      return { status: "warning", expiresAt, daysRemaining }
    }

    return { status: "valid", expiresAt, daysRemaining }
  } catch (error) {
    return { status: "error", expiresAt: null, daysRemaining: null, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

const checkGeminiKey = async () => {
  const config = await buildConfigSnapshot()

  if (!config.geminiApiKey || !config.geminiEnabled) {
    return { status: "not_configured" }
  }

  try {
    const { GoogleGenAI } = await import("@google/genai")
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
    const model = config.geminiModel || "gemini-1.5-flash"

    const response = await ai.models.generateContent({
      model,
      contents: "respond with the word OK",
      config: {
        maxOutputTokens: 10,
        temperature: 0,
      },
    })

    const text = typeof response?.text === "string" ? response.text : ""
    if (text.trim()) {
      return { status: "valid" }
    }

    return { status: "error", error: "Gemini returned an empty response" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    if (message.includes("API_KEY_INVALID") || message.includes("not found") || message.includes("401") || message.includes("403")) {
      return { status: "invalid", error: message }
    }
    return { status: "error", error: message }
  }
}

const checkGeminiUsage = async () => {
  const config = await buildConfigSnapshot()
  const dailyLimit = Number(config.geminiDailyLimit) || 0
  const monthlyLimit = Number(config.geminiMonthlyLimit) || 0

  if (!dailyLimit && !monthlyLimit) {
    return { warnings: [] }
  }

  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [dayAgg, monthAgg] = await Promise.all([
    prisma.geminiUsageLog.aggregate({
      _sum: { totalTokens: true },
      where: { createdAt: { gte: startOfDay } },
    }),
    prisma.geminiUsageLog.aggregate({
      _sum: { totalTokens: true },
      where: { createdAt: { gte: startOfMonth } },
    }),
  ])

  const dayUsed = dayAgg._sum.totalTokens || 0
  const monthUsed = monthAgg._sum.totalTokens || 0

  const warnings = []

  if (dailyLimit > 0) {
    const dayPct = Math.round((dayUsed / dailyLimit) * 100)
    if (dayPct >= 100) {
      warnings.push({
        title: "Gemini Daily Limit Reached",
        message: `Gemini API has used ${dayUsed.toLocaleString()} of ${dailyLimit.toLocaleString()} daily tokens (100%). The AI strategy feature may be throttled by Google.`,
        level: "critical",
      })
    } else if (dayPct >= 80) {
      warnings.push({
        title: "Gemini Daily Limit Nearly Reached",
        message: `Gemini API has used ${dayUsed.toLocaleString()} of ${dailyLimit.toLocaleString()} daily tokens (${dayPct}%). Consider reducing usage.`,
        level: "warning",
      })
    }
  }

  if (monthlyLimit > 0) {
    const monthPct = Math.round((monthUsed / monthlyLimit) * 100)
    if (monthPct >= 100) {
      warnings.push({
        title: "Gemini Monthly Limit Reached",
        message: `Gemini API has used ${monthUsed.toLocaleString()} of ${monthlyLimit.toLocaleString()} monthly tokens (100%). The AI strategy feature may be throttled by Google.`,
        level: "critical",
      })
    } else if (monthPct >= 80) {
      warnings.push({
        title: "Gemini Monthly Limit Nearly Reached",
        message: `Gemini API has used ${monthUsed.toLocaleString()} of ${monthlyLimit.toLocaleString()} monthly tokens (${monthPct}%). Consider reducing usage.`,
        level: "warning",
      })
    }
  }

  return { warnings }
}

export const checkTokens = async () => {
  const [meta, gemini, usage] = await Promise.all([checkMetaToken(), checkGeminiKey(), checkGeminiUsage()])

  await writeAppSettings({
    [APP_SETTING_KEYS.LAST_TOKEN_CHECK]: new Date().toISOString(),
  })

  const notifications = []
  const emailNotifications = []

  if (meta.status === "critical") {
    notifications.push({
      title: "Meta Token Expiring Soon",
      message: `Meta access token will expire in ${meta.daysRemaining} day(s) on ${new Date(meta.expiresAt).toLocaleDateString("en-GB")}. Update it in System Settings > Integrations.`,
    })
    emailNotifications.push({
      subject: "[MaiinSight] Meta Token Expiring Soon",
      html: `<p>Hi {{name}},</p><p>The Meta access token will expire in <strong>${meta.daysRemaining} day(s)</strong> on <strong>${new Date(meta.expiresAt).toLocaleDateString("en-GB")}</strong>.</p><p>Please update it in <strong>System Settings &gt; Integrations</strong>.</p><p>— MaiinSight</p>`,
    })
  } else if (meta.status === "expired") {
    notifications.push({
      title: "Meta Token Expired",
      message: "Meta access token has expired. Instagram data sync will fail until a new token is configured in System Settings > Integrations.",
    })
    emailNotifications.push({
      subject: "[MaiinSight] Meta Token Expired",
      html: `<p>Hi {{name}},</p><p>The Meta access token has <strong>expired</strong>.</p><p>Instagram data sync will fail until a new token is generated and configured in <strong>System Settings &gt; Integrations</strong>.</p><p>— MaiinSight</p>`,
    })
  } else if (meta.status === "warning") {
    notifications.push({
      title: "Meta Token Expiring Soon",
      message: `Meta access token will expire in ${meta.daysRemaining} day(s) on ${new Date(meta.expiresAt).toLocaleDateString("en-GB")}. Prepare a replacement.`,
    })
    emailNotifications.push({
      subject: "[MaiinSight] Meta Token Expiring Soon",
      html: `<p>Hi {{name}},</p><p>The Meta access token will expire in <strong>${meta.daysRemaining} day(s)</strong> on <strong>${new Date(meta.expiresAt).toLocaleDateString("en-GB")}</strong>.</p><p>Please prepare a replacement token.</p><p>— MaiinSight</p>`,
    })
  }

  if (gemini.status === "invalid") {
    notifications.push({
      title: "Gemini API Key Invalid",
      message: `Gemini API key is invalid or expired. The AI strategy feature will not work. Update it in System Settings > Integrations.`,
    })
    emailNotifications.push({
      subject: "[MaiinSight] Gemini API Key Invalid",
      html: `<p>Hi {{name}},</p><p>The Gemini API key is <strong>invalid or expired</strong>.</p><p>The AI strategy feature will not work. Please update it in <strong>System Settings &gt; Integrations</strong>.</p><p>— MaiinSight</p>`,
    })
  }

  for (const warn of usage.warnings) {
    if (warn.level === "critical") {
      notifications.push({ title: warn.title, message: warn.message })
      emailNotifications.push({
        subject: `[MaiinSight] ${warn.title}`,
        html: `<p>Hi {{name}},</p><p>${warn.message}</p><p>— MaiinSight</p>`,
      })
    } else {
      notifications.push({ title: warn.title, message: warn.message })
    }
  }

  for (const notif of notifications) {
    try {
      await createNotificationsForRoles(prisma, [IT_SUPPORT_ROLE], notif)
    } catch (_) {
      /* non-critical */
    }
  }

  for (const email of emailNotifications) {
    try {
      await sendBulkRoleEmail({
        roles: [IT_SUPPORT_ROLE],
        subject: email.subject,
        html: email.html,
      })
    } catch (_) {
      /* non-critical */
    }
  }

  return { meta, gemini, usage, notificationsSent: notifications.length, emailsSent: emailNotifications.length }
}
