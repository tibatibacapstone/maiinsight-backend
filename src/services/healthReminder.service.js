import { env } from "../config/env.js"
import { prisma } from "../config/prisma.js"
import { checkMetaTokenHealth } from "./meta.service.js"
import { checkGeminiHealth } from "./aiProvider.service.js"
import { sendIntegrationReminderEmail } from "./reminderEmail.service.js"

const REMINDER_STATE_KEYS = {
  meta: "HEALTH_META_REMINDER_STATE",
  gemini: "HEALTH_GEMINI_REMINDER_STATE",
}

const DAY_MS = 24 * 60 * 60 * 1000

const stateRank = { ok: 0, warning: 1, critical: 2, expired: 3, error: 3 }

const formatCheckedAt = (date = new Date()) =>
  date.toLocaleString("en-GB", { timeZone: "Asia/Jakarta", hour12: false })

const getState = async (key) => {
  const row = await prisma.appSetting.findUnique({ where: { key } })
  if (!row?.value) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

const setState = async (key, value) => {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  })
}

const getRecipients = async () => {
  if (env.healthReminderRecipients.length) {
    return env.healthReminderRecipients.map((email) => ({ email, name: email }))
  }
  return prisma.user.findMany({
    where: { role: "it_support", isActive: true },
    select: { email: true, name: true },
  })
}

export const toIssue = (status, kind) => {
  if (kind === "meta") {
    if (status.status === "warning") {
      return {
        level: "warning",
        name: "Meta Access Token",
        label: "Warning",
        color: "#d97706",
        days: status.daysRemaining,
        detail: `Access token expires in ${status.daysRemaining} days (${new Date(status.expiresAt).toLocaleDateString("en-GB", { timeZone: "Asia/Jakarta" })}).`,
      }
    }
    if (status.status === "critical") {
      return {
        level: "critical",
        name: "Meta Access Token",
        label: "Critical",
        color: "#dc2626",
        days: status.daysRemaining,
        detail: `Access token expiring in ${status.daysRemaining} days (${new Date(status.expiresAt).toLocaleDateString("en-GB", { timeZone: "Asia/Jakarta" })}).`,
      }
    }
    if (status.status === "expired") {
      return {
        level: "expired",
        name: "Meta Access Token",
        label: "Expired",
        color: "#dc2626",
        detail: "The Meta access token has expired. Update it in Settings.",
      }
    }
    if (status.status === "error") {
      return {
        level: "error",
        name: "Meta API",
        label: "Unreachable",
        color: "#dc2626",
        detail: status.error || "Meta API health check failed.",
      }
    }
    return null
  }

  if (status.status === "error") {
    return {
      level: "error",
      name: "Gemini AI",
      label: "Unreachable",
      color: "#dc2626",
      detail: status.error || "Gemini API health check failed.",
    }
  }
  return null
}

export const shouldSend = (issue, state, now) => {
  if (!issue) return false
  if (!state) return true
  if (state.level !== issue.level) return true
  const lastSent = new Date(state.sentAt).getTime()
  return now - lastSent >= DAY_MS
}

export const runHealthReminder = async ({ now = Date.now(), logger = console } = {}) => {
  if (!env.healthReminderEnabled) {
    return { sent: [], skipped: [], reason: "disabled" }
  }

  const [metaHealth, geminiHealth] = await Promise.all([checkMetaTokenHealth(), checkGeminiHealth()])

  const metaState = await getState(REMINDER_STATE_KEYS.meta)
  const geminiState = await getState(REMINDER_STATE_KEYS.gemini)

  const metaIssue = toIssue(metaHealth, "meta")
  const geminiIssue = toIssue(geminiHealth, "gemini")

  const alerting = []
  const resolved = []
  const skipped = []

  if (metaIssue && shouldSend(metaIssue, metaState, now)) {
    alerting.push(metaIssue)
    await setState(REMINDER_STATE_KEYS.meta, { level: metaIssue.level, sentAt: new Date(now).toISOString() })
  } else if (!metaIssue && metaState && metaState.level !== "ok") {
    resolved.push("Meta Access Token")
    await setState(REMINDER_STATE_KEYS.meta, { level: "ok", sentAt: new Date(now).toISOString() })
  } else if (metaIssue) {
    skipped.push({ name: "Meta Access Token", level: metaIssue.level })
  }

  if (geminiIssue && shouldSend(geminiIssue, geminiState, now)) {
    alerting.push(geminiIssue)
    await setState(REMINDER_STATE_KEYS.gemini, { level: geminiIssue.level, sentAt: new Date(now).toISOString() })
  } else if (!geminiIssue && geminiState && geminiState.level !== "ok") {
    resolved.push("Gemini AI")
    await setState(REMINDER_STATE_KEYS.gemini, { level: "ok", sentAt: new Date(now).toISOString() })
  } else if (geminiIssue) {
    skipped.push({ name: "Gemini AI", level: geminiIssue.level })
  }

  if (!alerting.length && !resolved.length) {
    return { sent: [], skipped, reason: "all_clear" }
  }

  const recipients = await getRecipients()
  if (!recipients.length) {
    logger.warn("[mail] Reminder email skipped: no IT Support recipients configured.", { alerting, resolved })
    return { sent: [], skipped, reason: "no_recipients" }
  }

  const checkedAt = formatCheckedAt(new Date(now))
  const sent = []

  if (alerting.length) {
    const worst = alerting.reduce((a, b) =>
      stateRank[b.level] > stateRank[a.level] ? b : a,
    )
    const isCritical = ["critical", "expired", "error"].includes(worst.level)
    const severity = isCritical ? "critical" : "warning"
    const prefix = isCritical ? "[Critical]" : "[Warning]"

    let subject
    if (worst.level === "expired") {
      subject = `${prefix} MaiinSight — Meta Access Token Has Expired`
    } else if (worst.level === "critical") {
      subject = `${prefix} MaiinSight — Meta Access Token Expiring in ${worst.days} Days`
    } else if (worst.level === "warning") {
      subject = `${prefix} MaiinSight — Meta Access Token Expires in ${worst.days} Days`
    } else if (worst.name === "Gemini AI") {
      subject = `${prefix} MaiinSight — Gemini AI Integration Unreachable`
    } else {
      subject = `${prefix} MaiinSight — Integration Health Alert`
    }

    const intro = alerting.length === 1
      ? "MaiinSight detected an issue with one of your connected integrations during today's automated health check. Please review and take action."
      : `MaiinSight detected issues with ${alerting.length} of your connected integrations during today's automated health check. Please review and take action.`

    for (const recipient of recipients) {
      const result = await sendIntegrationReminderEmail({
        to: recipient.email,
        subject,
        severity,
        title: alerting.length === 1 ? "Integration Requires Your Attention" : "Multiple Integrations Require Attention",
        intro,
        rows: alerting,
        note: "Open MaiinSight and go to Settings for the latest status and next steps.",
        checkedAt,
      })
      if (result.skipped) {
        skipped.push({ name: "all", reason: "smtp_not_configured", to: recipient.email })
      } else {
        sent.push({ to: recipient.email, subject })
      }
    }
  }

  if (resolved.length) {
    const subject = "[Resolved] MaiinSight — Integration Health Restored"
    const intro = `MaiinSight confirms the following ${resolved.length === 1 ? "integration has" : "integrations have"} recovered and are healthy again:`
    const rows = resolved.map((name) => ({
      name,
      label: "Healthy",
      color: "#059669",
      detail: "Automated health check passed. No action needed.",
    }))

    for (const recipient of recipients) {
      const result = await sendIntegrationReminderEmail({
        to: recipient.email,
        subject,
        severity: "resolved",
        title: "Integration Health Restored",
        intro,
        rows,
        note: "Open MaiinSight and go to Settings for the latest status.",
        checkedAt,
      })
      if (result.skipped) {
        skipped.push({ name: "resolved", reason: "smtp_not_configured", to: recipient.email })
      } else {
        sent.push({ to: recipient.email, subject })
      }
    }
  }

  return { sent, skipped, reason: alerting.length ? "alert" : "resolved" }
}
