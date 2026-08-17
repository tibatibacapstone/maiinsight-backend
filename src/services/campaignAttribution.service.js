import crypto from "node:crypto"
import { GoogleGenAI } from "@google/genai"
import { prisma } from "../config/prisma.js"
import { buildConfigSnapshot } from "./appConfig.service.js"

export const STOP_WORDS = new Set(["promo", "promotion", "diskon", "discount", "dan", "di", "ke", "untuk"])
const PROMOTION_LABEL = "content_promotion"
const EXTRACTION_START = new Date("2022-01-01T00:00:00.000Z")
const extractionSchema = { type: "object", additionalProperties: false, required: ["promoName", "startDate", "endDate"], properties: { promoName: { type: ["string", "null"] }, startDate: { type: ["string", "null"] }, endDate: { type: ["string", "null"] } } }
const insightSchema = { type: "object", additionalProperties: false, required: ["insights"], properties: { insights: { type: "array", items: { type: "object", additionalProperties: false, required: ["internalKey", "text"], properties: { internalKey: { type: "string" }, text: { type: "string" } } } } } }
const normalizeText = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
export const tokenizePromo = (value) => normalizeText(value).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token))
const hashCaption = (caption) => crypto.createHash("sha256").update(String(caption || "")).digest("hex")
const parseJson = (response) => {
  const raw = typeof response?.text === "function" ? response.text() : response?.text || response?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("") || ""
  const fence = String.fromCharCode(96).repeat(3)
  return JSON.parse(String(raw || "").trim().replace(new RegExp("^" + fence + "json\\s*", "i"), "").replace(new RegExp(fence + "$"), "").trim())
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const extractCaptionWithRetry = async (args) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await extractCaption(args) } catch (error) {
      if (error?.status !== 429 || attempt === 3) throw error
      await sleep(25000)
    }
  }
}
const validDate = (value) => {
  if (!value) return null
  const date = new Date(String(value).slice(0, 10) + "T00:00:00.000Z")
  return Number.isNaN(date.getTime()) ? null : date
}
const hasExplicitPeriod = (caption) => {
  const text = String(caption || "").toLowerCase()
  const monthRange = /\\d{1,2}\\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|september|october|december)\\s+[^\\w]+\\s+\\d{1,2}\\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|september|october|december)/i
  const numericRange = /\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}\\s+[^\\w]+\\s+\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}/i
  return monthRange.test(text) || numericRange.test(text)
}
const buildInternalKey = (name, start, end) => name.trim() + " " + (start.getUTCMonth() + 1) + (end.getUTCMonth() + 1) + String(start.getUTCFullYear()).slice(-2)
const cleanName = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 255)

const extractCaption = async ({ ai, model, caption, postedAt }) => {
  const prompt = "Extract the Instagram promotion from this Maiin Gandaria caption. Return JSON only. promoName must be the clean public name without dates, hashtags, venue boilerplate, or internal suffix. startDate and endDate must be YYYY-MM-DD only when an explicit validity period is clear. If either boundary is unclear return null for both dates. Use post date only to resolve an omitted year when month/day is explicit; never invent a date. Post date: " + (postedAt ? new Date(postedAt).toISOString().slice(0, 10) : "unknown") + ". Caption:\n" + caption
  const response = await ai.models.generateContent({ model, contents: prompt, config: { temperature: 0, maxOutputTokens: 300, responseMimeType: "application/json", responseJsonSchema: extractionSchema, thinkingConfig: { thinkingBudget: 0 } } })
  const result = parseJson(response)
  const startDate = validDate(result?.startDate)
  const endDate = validDate(result?.endDate)
  return { name: cleanName(result?.promoName), startDate: hasExplicitPeriod(caption) ? startDate : null, endDate: hasExplicitPeriod(caption) ? endDate : null }
}

export const extractCampaignAttributions = async () => {
  const config = await buildConfigSnapshot()
  if (!config.geminiEnabled || !config.geminiApiKey) return { status: "skipped", reason: "Gemini is not configured.", processed: 0 }
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
  const model = config.geminiModel || "gemini-2.5-flash"
  const media = await prisma.instagramMedia.findMany({ where: { contentLabel: PROMOTION_LABEL, postedAt: { gte: EXTRACTION_START }, caption: { not: null } }, select: { id: true, caption: true, postedAt: true }, orderBy: { postedAt: "asc" } })
  let processed = 0
  for (const item of media) {
    const captionHash = hashCaption(item.caption)
    const existingLink = await prisma.campaignAttributionContent.findUnique({ where: { mediaId: item.id } })
    if (existingLink?.captionHash === captionHash) continue
    const extracted = await extractCaptionWithRetry({ ai, model, caption: item.caption, postedAt: item.postedAt })
    if (!extracted.name) continue
    const matchingName = normalizeText(extracted.name)
    const hasPeriod = Boolean(extracted.startDate && extracted.endDate && extracted.startDate <= extracted.endDate)
    const status = hasPeriod ? "active" : "period_unavailable"
    let campaign = hasPeriod ? await prisma.campaignAttribution.findFirst({ where: { matchingName, startDate: extracted.startDate, endDate: extracted.endDate } }) : await prisma.campaignAttribution.findFirst({ where: { matchingName, status: "period_unavailable" } })
    if (!campaign) {
      const baseInternalKey = hasPeriod ? buildInternalKey(extracted.name, extracted.startDate, extracted.endDate) : extracted.name + " unavailable"
      let internalKey = baseInternalKey
      let suffix = 2
      let sameKey = await prisma.campaignAttribution.findUnique({ where: { internalKey } })
      if (sameKey && sameKey.startDate?.getTime() === extracted.startDate?.getTime() && sameKey.endDate?.getTime() === extracted.endDate?.getTime()) campaign = sameKey
      while (!campaign && sameKey) {
        internalKey = baseInternalKey + "-" + suffix
        suffix += 1
        sameKey = await prisma.campaignAttribution.findUnique({ where: { internalKey } })
      }
      if (!campaign) campaign = await prisma.campaignAttribution.create({ data: { displayName: extracted.name, matchingName, internalKey, startDate: hasPeriod ? extracted.startDate : null, endDate: hasPeriod ? extracted.endDate : null, status } })
    }
    if (existingLink) await prisma.campaignAttributionContent.update({ where: { mediaId: item.id }, data: { campaignId: campaign.id, captionHash, extractedAt: new Date() } })
    else await prisma.campaignAttributionContent.create({ data: { campaignId: campaign.id, mediaId: item.id, captionHash } })
    processed += 1
  }
  return { status: "completed", processed, mediaCount: media.length }
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
