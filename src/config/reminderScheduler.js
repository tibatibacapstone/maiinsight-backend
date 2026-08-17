import cron from "node-cron"

import { env } from "./env.js"
import { runHealthReminder } from "../services/healthReminder.service.js"
import { extractCampaignAttributions } from "../services/campaignAttribution.service.js"

export const startReminderScheduler = () => {
  if (!env.healthReminderEnabled) {
    return null
  }

  if (!cron.validate(env.healthReminderCron)) {
    console.warn("[reminder] Invalid HEALTH_REMINDER_CRON, scheduler disabled.", {
      cron: env.healthReminderCron,
    })
    return null
  }

  const task = cron.schedule(
    env.healthReminderCron,
    async () => {
      try {
        const result = await runHealthReminder()
        console.log("[reminder] Automated health reminder run completed.", result)
      } catch (error) {
        console.error("[reminder] Automated health reminder run failed.", error)
      }
    },
    { timezone: "Asia/Jakarta" },
  )

  console.log(`[reminder] Scheduler started (${env.healthReminderCron}, Asia/Jakarta).`)
  return task
}


export const startCampaignAttributionScheduler = () => {
  if (!env.campaignAttributionEnabled) return null
  if (!cron.validate(env.campaignAttributionCron)) {
    console.warn("[campaign-attribution] Invalid CAMPAIGN_ATTRIBUTION_CRON, scheduler disabled.", { cron: env.campaignAttributionCron })
    return null
  }
  const task = cron.schedule(env.campaignAttributionCron, async () => {
    try {
      const result = await extractCampaignAttributions()
      console.log("[campaign-attribution] Extraction completed.", result)
    } catch (error) {
      console.error("[campaign-attribution] Extraction failed.", error)
    }
  }, { timezone: "Asia/Jakarta" })
  console.log("[campaign-attribution] Scheduler started (" + env.campaignAttributionCron + ", Asia/Jakarta).")
  return task
}
