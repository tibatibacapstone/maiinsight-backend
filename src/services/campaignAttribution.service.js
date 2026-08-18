import crypto from "node:crypto"
import { GoogleGenAI } from "@google/genai"
import { prisma } from "../config/prisma.js"
import { buildConfigSnapshot } from "./appConfig.service.js"

export const STOP_WORDS = new Set(["promo", "promotion", "diskon", "discount", "dan", "di", "ke", "untuk"])
const PROMOTION_LABEL = "content_promotion"
const EXTRACTION_START = new Date("2022-01-01T00:00:00.000Z")
// Throttle between Gemini calls so a backlog batch (e.g. the 80+ posts that
// were never processed while the extraction loop was silently dying on its
// first uncaught error) doesn't immediately slam into rate limits again.
const GEMINI_CALL_THROTTLE_MS = 1500
const extractionSchema = { type: "object", additionalProperties: false, required: ["promoName", "startDate", "endDate"], properties: { promoName: { type: ["string", "null"] }, startDate: { type: ["string", "null"] }, endDate: { type: ["string", "null"] } } }
const insightSchema = { type: "object", additionalProperties: false, required: ["insights"], properties: { insights: { type: "array", items: { type: "object", additionalProperties: false, required: ["internalKey", "text"], properties: { internalKey: { type: "string" }, text: { type: "string" } } } } } }
const normalizeText = (value) => String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
export const tokenizePromo = (value) => normalizeText(value).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token))
const hashCaption = (caption) => crypto.createHash("sha256").update(String(caption || "")).digest("hex")
const parseJson = (response) => {
  const raw = typeof response?.text === "function" ? response.text() : response?.text || response?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("") || ""
  const fence = String.fromCharCode(96).repeat(3)
  return JSON.parse(String(raw || "").trim().replace(new RegExp("^" + fence + "json\\s*", "i"), "").replace(new RegExp(fence + "$"), "").trim())
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A 429 with a per-minute rate limit clears up within seconds, so a short
// retry is worth it. A 429 against the free-tier *daily* quota won't clear
// until the quota window rolls over — retrying it 3x with a 25s sleep each
// just burns minutes for a guaranteed second failure, and doing that for
// every remaining item in a large backlog can turn into hours of pointless
// waiting. Detect that case so the caller can stop the whole run early
// instead of grinding through every remaining item one by one.
const isDailyQuotaExhausted = (error) => {
  const message = String(error?.message || "")
  return error?.status === 429 && (message.includes("PerDay") || message.includes("free_tier_requests"))
}
const extractCaptionWithRetry = async (args) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await extractCaption(args) } catch (error) {
      if (error?.status !== 429 || attempt === 3 || isDailyQuotaExhausted(error)) throw error
      await sleep(25000)
    }
  }
}
const validDate = (value) => {
  if (!value) return null
  const date = new Date(String(value).slice(0, 10) + "T00:00:00.000Z")
  return Number.isNaN(date.getTime()) ? null : date
}
// Built with the RegExp(string) constructor on purpose: inside a *string*,
// "\\d" is required to produce a real "\d" digit escape in the resulting
// pattern. (The previous version used regex *literals* with "\\d", which in
// literal syntax means a literal backslash followed by the letter d — never
// present in a real caption — so this guard silently discarded every
// explicit date Gemini correctly extracted. Keep constructing these via
// RegExp(string) so double-backslash stays correct here.)
const MONTH_NAMES = "(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|september|october|december)"
const RANGE_CONNECTOR = "(?:-|–|—|s\\/d|sampai dengan|sampai|hingga|sd|to)"
const MONTH_TO_MONTH_RANGE = new RegExp(`\\d{1,2}\\s+${MONTH_NAMES}\\s*${RANGE_CONNECTOR}\\s*\\d{1,2}\\s+${MONTH_NAMES}`, "i")
const SHARED_MONTH_RANGE = new RegExp(`\\d{1,2}\\s*${RANGE_CONNECTOR}\\s*\\d{1,2}\\s+${MONTH_NAMES}`, "i")
const NUMERIC_RANGE = new RegExp(`\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}\\s*${RANGE_CONNECTOR}\\s*\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}`, "i")
const hasExplicitPeriod = (caption) => {
  const text = String(caption || "").toLowerCase()
  return MONTH_TO_MONTH_RANGE.test(text) || SHARED_MONTH_RANGE.test(text) || NUMERIC_RANGE.test(text)
}
const buildInternalKey = (name, start, end) => name.trim() + " " + (start.getUTCMonth() + 1) + (end.getUTCMonth() + 1) + String(start.getUTCFullYear()).slice(-2)
const cleanName = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 255)
const isGenericMatchingName = (matchingName) => tokenizePromo(matchingName).length === 0

const extractCaption = async ({ ai, model, caption, postedAt }) => {
  const prompt = "Extract the Instagram promotion from this Maiin Gandaria caption. Return JSON only. promoName must be the clean public name without dates, hashtags, venue boilerplate, or internal suffix. startDate and endDate must be YYYY-MM-DD only when an explicit validity period is clear. If either boundary is unclear return null for both dates. Use post date only to resolve an omitted year when month/day is explicit; never invent a date. Post date: " + (postedAt ? new Date(postedAt).toISOString().slice(0, 10) : "unknown") + ". Caption:\n" + caption
  const response = await ai.models.generateContent({ model, contents: prompt, config: { temperature: 0, maxOutputTokens: 300, responseMimeType: "application/json", responseJsonSchema: extractionSchema, thinkingConfig: { thinkingBudget: 0 } } })
  const result = parseJson(response)
  const startDate = validDate(result?.startDate)
  const endDate = validDate(result?.endDate)
  const gate = hasExplicitPeriod(caption)
  return {
    extracted: { name: cleanName(result?.promoName), startDate: gate ? startDate : null, endDate: gate ? endDate : null },
    raw: { promoName: result?.promoName ?? null, startDate: result?.startDate ?? null, endDate: result?.endDate ?? null, hasExplicitPeriodGate: gate },
  }
}

const logExtraction = async ({ mediaId, campaignId, status, caption, geminiResponse, errorMessage }) => {
  try {
    await prisma.campaignAttributionExtractionLog.create({
      data: {
        mediaId,
        campaignId: campaignId || null,
        status,
        caption: caption || "",
        geminiResponse: geminiResponse ? JSON.stringify(geminiResponse) : null,
        errorMessage: errorMessage || null,
      },
    })
  } catch (logError) {
    // Logging must never take down the batch itself.
    console.error("[campaign-attribution] Failed to persist extraction log.", logError)
  }
}

// Shared per-item pipeline used by both the scheduled batch and the
// period_unavailable backfill. `skipUnchanged` controls whether an
// already-linked item with an unchanged caption hash is left untouched
// (normal scheduled runs) or force-reprocessed (backfill).
const processMediaItem = async ({ ai, model, item, skipUnchanged }) => {
  const captionHash = hashCaption(item.caption)
  const existingLink = await prisma.campaignAttributionContent.findUnique({ where: { mediaId: item.id } })
  if (skipUnchanged && existingLink?.captionHash === captionHash) {
    return { outcome: "skipped_unchanged" }
  }

  let extracted
  let raw
  try {
    const result = await extractCaptionWithRetry({ ai, model, caption: item.caption, postedAt: item.postedAt })
    extracted = result.extracted
    raw = result.raw
  } catch (error) {
    const status = error?.status ? `[HTTP ${error.status}] ` : ""
    const logStatus = isDailyQuotaExhausted(error) ? "quota_exhausted" : "error"
    await logExtraction({ mediaId: item.id, campaignId: existingLink?.campaignId, status: logStatus, caption: item.caption, errorMessage: status + (error?.message || String(error)) })
    return { outcome: logStatus, error }
  }

  if (!extracted.name) {
    await logExtraction({ mediaId: item.id, campaignId: existingLink?.campaignId, status: "skipped_no_promo", caption: item.caption, geminiResponse: raw })
    return { outcome: "skipped_no_promo", raw }
  }

  const matchingName = normalizeText(extracted.name)
  const hasPeriod = Boolean(extracted.startDate && extracted.endDate && extracted.startDate <= extracted.endDate)
  const isGeneric = isGenericMatchingName(matchingName)
  const status = isGeneric ? "needs_review" : hasPeriod ? "active" : "period_unavailable"

  let campaign = isGeneric
    ? await prisma.campaignAttribution.findFirst({ where: { matchingName, status: "needs_review" } })
    : hasPeriod
      ? await prisma.campaignAttribution.findFirst({ where: { matchingName, startDate: extracted.startDate, endDate: extracted.endDate } })
      : await prisma.campaignAttribution.findFirst({ where: { matchingName, status: "period_unavailable" } })

  if (!campaign) {
    const baseInternalKey = isGeneric
      ? extracted.name + " needs-review"
      : hasPeriod
        ? buildInternalKey(extracted.name, extracted.startDate, extracted.endDate)
        : extracted.name + " unavailable"
    let internalKey = baseInternalKey
    let suffix = 2
    let sameKey = await prisma.campaignAttribution.findUnique({ where: { internalKey } })
    if (sameKey && sameKey.status === status && sameKey.startDate?.getTime() === extracted.startDate?.getTime() && sameKey.endDate?.getTime() === extracted.endDate?.getTime()) campaign = sameKey
    while (!campaign && sameKey) {
      internalKey = baseInternalKey + "-" + suffix
      suffix += 1
      sameKey = await prisma.campaignAttribution.findUnique({ where: { internalKey } })
    }
    if (!campaign) campaign = await prisma.campaignAttribution.create({ data: { displayName: extracted.name, matchingName, internalKey, startDate: hasPeriod ? extracted.startDate : null, endDate: hasPeriod ? extracted.endDate : null, status } })
  }

  if (existingLink) await prisma.campaignAttributionContent.update({ where: { mediaId: item.id }, data: { campaignId: campaign.id, captionHash, extractedAt: new Date() } })
  else await prisma.campaignAttributionContent.create({ data: { campaignId: campaign.id, mediaId: item.id, captionHash } })

  await logExtraction({ mediaId: item.id, campaignId: campaign.id, status: isGeneric ? "needs_review" : hasPeriod ? "extracted_with_period" : "extracted_no_period", caption: item.caption, geminiResponse: raw })

  return { outcome: "processed", campaign, hasPeriod, isGeneric, raw }
}

export const extractCampaignAttributions = async () => {
  const config = await buildConfigSnapshot()
  if (!config.geminiEnabled || !config.geminiApiKey) return { status: "skipped", reason: "Gemini is not configured.", processed: 0 }
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
  const model = config.geminiModel || "gemini-2.5-flash"
  const media = await prisma.instagramMedia.findMany({ where: { contentLabel: PROMOTION_LABEL, postedAt: { gte: EXTRACTION_START }, caption: { not: null } }, select: { id: true, caption: true, postedAt: true }, orderBy: { postedAt: "asc" } })

  let processed = 0
  let skippedUnchanged = 0
  let skippedNoPromo = 0
  let errors = 0
  let stoppedEarly = false
  let stoppedAtIndex = null

  for (let index = 0; index < media.length; index += 1) {
    const item = media[index]
    const result = await processMediaItem({ ai, model, item, skipUnchanged: true })
    if (result.outcome === "processed") processed += 1
    else if (result.outcome === "skipped_unchanged") skippedUnchanged += 1
    else if (result.outcome === "skipped_no_promo") skippedNoPromo += 1
    else if (result.outcome === "quota_exhausted") {
      // The free-tier daily quota is gone for the day — every remaining
      // item would fail identically, so stop here instead of grinding
      // through the rest of the backlog one 429 at a time.
      console.error("[campaign-attribution] Daily Gemini quota exhausted, stopping batch early.", { mediaId: item.id, remaining: media.length - index - 1 })
      stoppedEarly = true
      stoppedAtIndex = index
      break
    } else if (result.outcome === "error") {
      errors += 1
      // A single bad item (transient network error, malformed Gemini
      // response) must never take down the rest of the batch — log and
      // move on to the next item instead of letting this throw bubble up
      // and abort everything after it.
      console.error("[campaign-attribution] Item failed, continuing batch.", { mediaId: item.id, error: result.error?.message })
    }
    if (result.outcome !== "skipped_unchanged") await sleep(GEMINI_CALL_THROTTLE_MS)
  }

  return { status: stoppedEarly ? "stopped_quota_exhausted" : "completed", processed, skippedUnchanged, skippedNoPromo, errors, mediaCount: media.length, remaining: stoppedEarly ? media.length - stoppedAtIndex - 1 : 0 }
}

// Force-reprocesses every media item currently linked to a period_unavailable
// campaign (bypassing the caption-hash skip), using the fixed extraction
// pipeline. Items linked to active/needs_review campaigns are left alone.
export const backfillPeriodUnavailableCampaigns = async () => {
  const config = await buildConfigSnapshot()
  if (!config.geminiEnabled || !config.geminiApiKey) return { status: "skipped", reason: "Gemini is not configured.", results: [] }
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
  const model = config.geminiModel || "gemini-2.5-flash"

  const links = await prisma.campaignAttributionContent.findMany({
    where: { campaign: { status: "period_unavailable" } },
    include: { media: { select: { id: true, caption: true, postedAt: true } }, campaign: { select: { id: true, displayName: true, matchingName: true, status: true, startDate: true, endDate: true } } },
  })

  const results = []
  let stoppedEarly = false
  for (const link of links) {
    const item = link.media
    const before = { campaignId: link.campaignId, displayName: link.campaign.displayName, status: link.campaign.status }
    const result = await processMediaItem({ ai, model, item, skipUnchanged: false })
    const freshLink = await prisma.campaignAttributionContent.findUnique({ where: { mediaId: item.id }, include: { campaign: true } })
    results.push({
      mediaId: item.id,
      postedAt: item.postedAt,
      caption: item.caption,
      before,
      after: freshLink ? { campaignId: freshLink.campaignId, displayName: freshLink.campaign.displayName, status: freshLink.campaign.status, startDate: freshLink.campaign.startDate, endDate: freshLink.campaign.endDate } : null,
      outcome: result.outcome,
      geminiRaw: result.raw || null,
      error: result.error ? (result.error.message || String(result.error)) : null,
    })
    if (result.outcome === "quota_exhausted") {
      console.error("[campaign-attribution] Daily Gemini quota exhausted during backfill, stopping early.", { mediaId: item.id })
      stoppedEarly = true
      break
    }
    if (result.outcome !== "skipped_unchanged") await sleep(GEMINI_CALL_THROTTLE_MS)
  }

  return { status: stoppedEarly ? "stopped_quota_exhausted" : "completed", attempted: results.length, totalLinked: links.length, results }
}

const tokenMatch = (campaignName, transactionName) => {
  const expected = new Set(tokenizePromo(campaignName))
  const actual = new Set(tokenizePromo(transactionName))
  return expected.size > 0 && [...expected].every((token) => actual.has(token))
}
const inRange = (date, start, end) => date && start && end && new Date(date) >= new Date(start) && new Date(date) <= new Date(end)
const customerIdentifier = (row) => row.customerId ?? row.customerKey ?? row.customerIdentity

export const buildCampaignAttribution = async ({ since, until }) => {
  const startDate = since ? new Date(since) : new Date("2022-01-01T00:00:00.000Z")
  const endDate = until ? new Date(until) : new Date()
  endDate.setHours(23, 59, 59, 999)
  const [campaigns, transactions, periodTransactions] = await Promise.all([
    prisma.campaignAttribution.findMany({ where: { status: "active", startDate: { not: null, lte: endDate }, endDate: { not: null, gte: startDate } }, include: { contentLinks: { select: { mediaId: true } } }, orderBy: [{ startDate: "asc" }, { displayName: "asc" }] }),
    prisma.facilityTransaction.findMany({ where: { validBooking: true, playDate: { not: null }, OR: [{ promoName: { not: null } }, { promosi: { not: null } }] }, select: { id: true, bookingEventKey: true, customerId: true, customerKey: true, customerIdentity: true, promoName: true, promosi: true, playDate: true, netRevenue: true } }),
    prisma.facilityTransaction.findMany({ where: { validBooking: true, playDate: { gte: startDate, lte: endDate } }, select: { customerId: true, customerKey: true, customerIdentity: true } }),
  ])
  const totalCustomers = new Set(periodTransactions.map(customerIdentifier).filter(Boolean)).size
  const campaignsResult = campaigns.map((campaign) => {
    const matches = transactions.filter((row) => tokenMatch(campaign.matchingName, row.promoName || row.promosi) && inRange(row.playDate, campaign.startDate, campaign.endDate))
    const bookingMap = new Map(matches.map((row) => [row.bookingEventKey || ("row-" + row.id), row]))
    const bookings = [...bookingMap.values()]
    const customers = new Set(bookings.map(customerIdentifier).filter(Boolean))
    const uniqueCustomerCount = customers.size
    return { internalKey: campaign.internalKey, promoName: campaign.displayName, startDate: campaign.startDate, endDate: campaign.endDate, contentCount: campaign.contentLinks.length, uniqueCustomerCount, totalBookingCount: bookings.length, revenue: bookings.reduce((sum, row) => sum + Number(row.netRevenue || 0), 0), customerSharePct: totalCustomers ? Number(((uniqueCustomerCount / totalCustomers) * 100).toFixed(1)) : null, totalCustomers }
  })
  return { campaigns: campaignsResult, period: { startDate: startDate.toISOString(), endDate: endDate.toISOString() }, totalCustomers }
}

export const generateCampaignAttributionInsights = async ({ campaigns, totalCustomers }) => {
  const config = await buildConfigSnapshot()
  if (!config.geminiEnabled || !config.geminiApiKey || !campaigns.length) return []
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
  const response = await ai.models.generateContent({ model: config.geminiModel || "gemini-2.5-flash", contents: "Write one short Indonesian observation for each promotion below. State correlation/identification only, never claim Instagram caused bookings or that customers are followers. Total customers in selected filter: " + totalCustomers + ". Data: " + JSON.stringify(campaigns.map(({ internalKey, promoName, customerSharePct, uniqueCustomerCount, totalBookingCount }) => ({ internalKey, promoName, customerSharePct, uniqueCustomerCount, totalBookingCount }))), config: { temperature: 0.2, maxOutputTokens: 700, responseMimeType: "application/json", responseJsonSchema: insightSchema, thinkingConfig: { thinkingBudget: 0 } } })
  const parsed = parseJson(response)
  return Array.isArray(parsed?.insights) ? parsed.insights : []
}
