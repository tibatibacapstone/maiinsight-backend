import { GoogleGenAI } from "@google/genai"

import { buildConfigSnapshot } from "./appConfig.service.js"
import {
  SUPPORTED_RECOMMENDED_OFFER_KEYS,
  normalizeKey,
} from "../constants/aiStrategy.constants.js"

const UNSAFE_KEYS = new Set([
  "name", "customername", "nama", "email", "normalizedemail", "phone",
  "normalizedphone", "notelepon", "customerkey", "customeridentity", "customerid",
  "rawdata", "rawrow", "transactions", "facilitytransactions",
])
const UNSAFE_RESPONSE_KEYS = new Set(
  [...UNSAFE_KEYS].filter((key) => key !== "name")
)

export const GEMINI_GENERATION_CONFIG = Object.freeze({
  temperature: 0.3,
  maxOutputTokens: 1100,
  maxAttempts: 2,
  responseMimeType: "application/json",
})

export const STRATEGY_WORD_LIMITS = Object.freeze({
  campaignObjective: 18,
  suggestedOffer: 22,
  offerReasoning: 28,
  customerReasoning: 28,
  evidenceItem: 16,
  executionAction: 18,
  executionSuccessCondition: 16,
  followUpPlan: 22,
  stopCondition: 24,
  expectedBusinessImpact: 28,
  dataLimitation: 32,
  kpiDefinition: 18,
  whatsappMessage: 65,
})

const createAiServiceError = ({
  errorCode,
  message = "AI strategy could not be generated.",
  suggestion = "Please review the selected scope and try again.",
  technicalMessage,
  statusCode = 422,
}) => Object.assign(new Error(message), {
  errorCode,
  suggestion,
  technicalMessage,
  statusCode,
})

export const sanitizeGeminiContext = (value) => {
  if (Array.isArray(value)) return value.map(sanitizeGeminiContext)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSAFE_KEYS.has(normalizeKey(key).replaceAll("_", "")))
        .map(([key, nested]) => [key, sanitizeGeminiContext(nested)])
    )
  }
  return value
}

const strategySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "targetSegmentKey", "targetSegmentLabel", "targetVenueKey", "targetVenueLabel",
    "targetSessionKey", "targetSessionLabel", "targetDayKey", "targetDayLabel",
    "campaignObjective", "recommendedOfferKey",
    "recommendedOfferType", "suggestedOffer", "offerReasoning", "customerReasoning",
    "evidenceUsed", "executionPlan", "followUpPlan", "stopCondition", "whatsappMessage",
    "expectedBusinessImpact", "kpis", "dataLimitation",
  ],
  properties: {
    targetSegmentKey: { type: "string" },
    targetSegmentLabel: { type: "string" },
    targetVenueKey: { type: ["string", "null"] },
    targetVenueLabel: { type: ["string", "null"] },
    targetSessionKey: { type: ["string", "null"] },
    targetSessionLabel: { type: ["string", "null"] },
    targetDayKey: { type: ["string", "null"] },
    targetDayLabel: { type: ["string", "null"] },
    campaignObjective: { type: "string" },
    recommendedOfferKey: {
      type: "string",
      enum: [...SUPPORTED_RECOMMENDED_OFFER_KEYS],
    },
    recommendedOfferType: { type: "string" },
    suggestedOffer: { type: "string" },
    offerReasoning: { type: "string" },
    customerReasoning: { type: "string" },
    evidenceUsed: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    executionPlan: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["timing", "action", "successCondition"],
        properties: {
          timing: { type: "string" },
          action: { type: "string" },
          successCondition: { type: "string" },
        },
      },
    },
    followUpPlan: { type: "string" },
    stopCondition: { type: "string" },
    whatsappMessage: { type: "string" },
    expectedBusinessImpact: { type: "string" },
    kpis: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "definition", "targetDirection"],
        properties: {
          name: { type: "string" },
          definition: { type: "string" },
          targetDirection: { type: "string", enum: ["increase", "decrease", "maintain"] },
        },
      },
    },
    dataLimitation: { type: ["string", "null"] },
  },
}

export const buildPrompt = (strategyContext, correction = null) => {
  const safeContext = sanitizeGeminiContext(strategyContext)
  return `You are an AI marketing decision-support assistant for Maiin Gandaria.
The selected_scope is mandatory. The selected segment must always remain the target.
Never replace it with the overall top, largest, highest-revenue, or highest-frequency segment.
Follow the selected segment, venue, session, objective, offer framework, campaign date, channel, and message tone.
Use only supplied aggregated evidence. Never invent counts, preferences, percentages, prices,
discounts, availability, occupancy, revenue, results, response rates, membership composition, or historical facts.
When evidence is unavailable, state it in dataLimitation. Never include names, emails, phone numbers,
customer keys, customer IDs, or other personal identifiers.
Use an opportunity metric only when its available field is true, and never cite unavailable metrics
as evidence. Promotion usage is not promotion conversion, campaign attribution, customer response,
or campaign success. Revenue and occupancy are supporting business evidence; the selected segment
lifecycle and business_opportunity_summary.primaryOpportunity remain mandatory. Explain how the offer
addresses the primary lifecycle opportunity and any available supporting occupancy or revenue opportunity.
Every General Strategy recommendation must use analysis_period and only facts calculated inside that
exact historical range. Mention the selected period when relevant, such as "berdasarkan data 3 bulan terakhir".
Use selected-period revenue_history, occupancy_history, off_peak_opportunity, promotion usage,
and preferred venue/session. Never cite data from outside the selected period.
General Strategy contains historical empty court hours, not future available slots. Never claim future
slot availability, future remaining court hours, or a future booking date in General Strategy.
Never invent revenue targets, revenue gaps, discount percentages, conversion rates, or response rates.

Lifecycle boundaries:
- Prime: retention, loyalty, and premium value.
- Routine: increase customer value and revenue per visit through a premium match experience.
  Do not prioritize membership conversion, recurring packages, or weekly packages.
  Its only premium add-ons are Photographer, Premium Ball, Match Highlight Video, and Referee Package.
- Growth: next booking, recurring or weekly booking packages, repeat-booking conversion, and habit formation.
- Re-Engagement: win-back, reactivation, comeback offers, and churn recovery.

Strategy decision matrix:
- Reason from selected segment + campaign objective + historical behavior + membership composition
  + venue/session preferences + promotion usage + business opportunity summary before choosing an offer.
- The campaign objective changes the treatment but never replaces the selected segment lifecycle.
- For drive_revenue_growth, Routine should select one or a justified combination of its allowed premium add-ons.
- For maximize_off_peak_occupancy, Routine should attach allowed premium add-ons to the verified
  lowest-occupancy window when available.
- For boost_social_media_conversion, Routine should prefer Photographer or Match Highlight Video
  because these create naturally shareable visual content; never use a recurring package.
- For customer_reactivation_and_retention, prefer loyalty benefits, exclusive experiences,
  premium service, or priority booking while respecting the selected segment lifecycle.
- If supplied historical evidence does not support a treatment, choose another treatment allowed
  for the same segment and objective. Do not invent supporting evidence.

When offerFrameworkKey is ai_recommended, choose one supported recommendedOfferKey and connect it
to supplied evidence. When a specific framework is selected, use that exact framework.
Never return membership_conversion or membership_trial unless membership_opportunity.eligible is true.
When campaignObjectiveKey is maximize_off_peak_occupancy and off_peak_opportunity.available is true:
- Set targetDayKey/targetDayLabel and targetSessionKey/targetSessionLabel to the supplied primary window.
- Name that exact day and session in campaignObjective, suggestedOffer, offerReasoning,
  executionPlan, and whatsappMessage. Never give only a generic off-peak recommendation.
- Use no other day/session window and never invent occupancy, capacity, or available hours.
The selected customer segment and its lifecycle treatment remain mandatory.
Never invent a discount amount. Exact percentages or currency discounts are prohibited when
offer_constraints.exactDiscountAllowed is false; recommend a category, value-added benefit,
or an offer within separately approved promotion limits.

Mandatory language and style:
- Write every user-facing value in clear, natural, professional Bahasa Indonesia.
- English is allowed only for canonical keys and established terms such as WhatsApp, KPI, segment labels,
  Mini Soccer, and Basketball. Keep canonical keys and targetDirection values unchanged.
- State the recommendation directly. Avoid academic language, introductions, repetition, and generic reasoning.
- Each field must serve a distinct purpose: campaignObjective states the goal; suggestedOffer states the offer;
  offerReasoning connects the offer to evidence; customerReasoning explains the selected audience;
  evidenceUsed contains only supplied facts; expectedBusinessImpact states potential, not guaranteed, impact.

Strict word limits:
- campaignObjective: 18; suggestedOffer: 22; offerReasoning: 28; customerReasoning: 28.
- Each evidenceUsed item: 16, with no more than 5 items.
- Each executionPlan action: 18; each successCondition: 16.
- followUpPlan: 22; stopCondition: 24; expectedBusinessImpact: 28; dataLimitation: 32.
- Each KPI definition: 18; whatsappMessage: 65.
Use one sentence unless two short sentences are explicitly useful. Shorter is preferred. Do not repeat
the same fact across reasoning, evidence, and impact.

All three executionPlan entries must use concise Indonesian timing, action, and successCondition values.
Use only observable conditions supported by the supplied context. All three KPI names and definitions
must be Indonesian and measurable in MaiinSight. Keep targetDirection as increase, decrease, or maintain.
Do not use offer redemption, WhatsApp/customer response, campaign conversion, or campaign attribution
as evidence, a KPI, or a stop condition when its availability flag is not true. Do not invent thresholds.
The whatsappMessage must be concise, persuasive, ready to send, and in Bahasa Indonesia.
Combine related unavailable data into one concise dataLimitation statement.

Keep business reasoning concise and professional.
Describe expected or potential impact and recommended KPIs; never guarantee campaign impact.
Return exactly three executionPlan items and exactly three kpis.
${correction ? `Previous output failed validation. Correct only this issue while preserving the exact selected scope and factual evidence: ${correction}` : ""}

Aggregated decision context:
${JSON.stringify(safeContext, null, 2)}`
}

const parseJsonResponse = (text) => {
  if (!String(text || "").trim()) {
    throw createAiServiceError({
      errorCode: "AI_EMPTY_RESPONSE",
      technicalMessage: "Gemini returned an empty response.",
    })
  }
  try {
    return JSON.parse(String(text).trim())
  } catch (error) {
    throw createAiServiceError({
      errorCode: "AI_INVALID_JSON",
      technicalMessage: error instanceof Error ? error.message : "Gemini returned invalid JSON.",
    })
  }
}

const hasPersonalDataKey = (value) => {
  if (Array.isArray(value)) return value.some(hasPersonalDataKey)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, nested]) =>
      UNSAFE_RESPONSE_KEYS.has(normalizeKey(key).replaceAll("_", "")) || hasPersonalDataKey(nested)
  )
}

const requireText = (value, field) => {
  if (typeof value !== "string" || !value.trim()) {
    throw createAiServiceError({
      errorCode: "AI_INVALID_RESPONSE",
      technicalMessage: `${field} must be a non-empty string.`,
    })
  }
}

const countWords = (value) =>
  String(value || "").match(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu)?.length || 0

const throwVerboseResponse = (field, limit, actual) => {
  throw createAiServiceError({
    errorCode: "AI_RESPONSE_TOO_VERBOSE",
    technicalMessage: `${field} contains ${actual} words; maximum is ${limit}.`,
  })
}

const validateWordLimit = (value, field, limit) => {
  if (value == null) return
  const actual = countWords(value)
  if (actual > limit) throwVerboseResponse(field, limit, actual)
}

const INDONESIAN_MARKERS = new Set([
  "agar", "akan", "atau", "bagi", "booking", "dalam", "dan", "dapat", "data",
  "dengan", "dihentikan", "dipilih", "hari", "hingga", "ini", "jam", "jika",
  "kembali", "kepada", "lebih", "melalui", "memiliki", "meningkatkan", "pada",
  "pelanggan", "pemesanan", "penawaran", "periode", "potensi", "sampai", "segmen",
  "setelah", "strategi", "target", "tersedia", "tidak", "untuk", "yang",
])
const ENGLISH_MARKERS = new Set([
  "and", "are", "because", "booking", "campaign", "customers", "data", "for",
  "from", "has", "have", "increase", "is", "offer", "selected", "send", "strategy",
  "the", "this", "through", "to", "until", "when", "with",
])

const isClearlyEnglish = (values) => {
  const words = values
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.toLowerCase().match(/\p{L}+/gu) || [])
  const indonesianCount = words.filter((word) => INDONESIAN_MARKERS.has(word)).length
  const englishCount = words.filter((word) => ENGLISH_MARKERS.has(word)).length
  return englishCount >= 4 && (indonesianCount === 0 || englishCount > indonesianCount * 2)
}

const validateConciseIndonesian = (result) => {
  const limits = [
    ["campaignObjective", result.campaignObjective, STRATEGY_WORD_LIMITS.campaignObjective],
    ["suggestedOffer", result.suggestedOffer, STRATEGY_WORD_LIMITS.suggestedOffer],
    ["offerReasoning", result.offerReasoning, STRATEGY_WORD_LIMITS.offerReasoning],
    ["customerReasoning", result.customerReasoning, STRATEGY_WORD_LIMITS.customerReasoning],
    ["followUpPlan", result.followUpPlan, STRATEGY_WORD_LIMITS.followUpPlan],
    ["stopCondition", result.stopCondition, STRATEGY_WORD_LIMITS.stopCondition],
    ["expectedBusinessImpact", result.expectedBusinessImpact, STRATEGY_WORD_LIMITS.expectedBusinessImpact],
    ["dataLimitation", result.dataLimitation, STRATEGY_WORD_LIMITS.dataLimitation],
    ["whatsappMessage", result.whatsappMessage, STRATEGY_WORD_LIMITS.whatsappMessage],
  ]
  limits.forEach(([field, value, limit]) => validateWordLimit(value, field, limit))

  if (result.evidenceUsed.length > 5) {
    throwVerboseResponse("evidenceUsed", 5, result.evidenceUsed.length)
  }
  result.evidenceUsed.forEach((item, index) =>
    validateWordLimit(item, `evidenceUsed[${index}]`, STRATEGY_WORD_LIMITS.evidenceItem)
  )
  result.executionPlan.forEach((step, index) => {
    validateWordLimit(step?.action, `executionPlan[${index}].action`, STRATEGY_WORD_LIMITS.executionAction)
    validateWordLimit(
      step?.successCondition,
      `executionPlan[${index}].successCondition`,
      STRATEGY_WORD_LIMITS.executionSuccessCondition
    )
  })
  result.kpis.forEach((kpi, index) =>
    validateWordLimit(kpi?.definition, `kpis[${index}].definition`, STRATEGY_WORD_LIMITS.kpiDefinition)
  )

  const primaryFields = [
    result.campaignObjective, result.suggestedOffer, result.offerReasoning,
    result.customerReasoning, result.followUpPlan, result.stopCondition,
    result.expectedBusinessImpact, result.dataLimitation, result.whatsappMessage,
  ]
  if (isClearlyEnglish(primaryFields)) {
    throw createAiServiceError({
      errorCode: "AI_RESPONSE_LANGUAGE_MISMATCH",
      technicalMessage: "Primary user-facing fields must be written in Bahasa Indonesia.",
    })
  }
}

const unsupportedMetricRules = [
  {
    flag: "promotionConversionAvailable",
    pattern: /\b(promotion conversion|konversi promosi)\b/i,
    label: "promotion conversion",
  },
  {
    flag: "campaignAttributionAvailable",
    pattern: /\b(campaign attribution|atribusi kampanye|atribusi campaign)\b/i,
    label: "campaign attribution",
  },
  {
    flag: "customerResponseRateAvailable",
    pattern: /\b(whatsapp response|customer response|response rate|tingkat respons|respons whatsapp)\b/i,
    label: "customer response rate",
  },
  {
    flag: "campaignConversionHistoryAvailable",
    pattern: /\b(campaign conversion|konversi kampanye|offer redemption|redemption rate|tingkat penukaran)\b/i,
    label: "campaign conversion or redemption",
  },
]

const validateObservableClaims = (result, context) => {
  const availability = context.data_availability || {}
  const evidence = result.evidenceUsed.map(String)
  const operationalClaims = [
    result.stopCondition,
    ...result.kpis.flatMap((kpi) => [kpi?.name, kpi?.definition]),
  ].map(String)

  for (const rule of unsupportedMetricRules) {
    if (availability[rule.flag] === true) continue
    if ([...evidence, ...operationalClaims].some((value) => rule.pattern.test(value))) {
      throw createAiServiceError({
        errorCode: "AI_INVALID_RESPONSE",
        technicalMessage: `${rule.label} is unavailable and cannot be used as evidence, a KPI, or a stop condition.`,
      })
    }
  }
}

const validateGeneralStrategyPeriodClaims = (result, context) => {
  if (normalizeKey(context.selected_scope?.workspaceModeKey) !== "general_strategy") return
  const allUserText = [
    result.campaignObjective,
    result.suggestedOffer,
    result.offerReasoning,
    ...result.evidenceUsed,
    ...result.executionPlan.flatMap((step) => [step.action, step.successCondition]),
    result.followUpPlan,
    result.stopCondition,
    result.expectedBusinessImpact,
    ...result.kpis.flatMap((kpi) => [kpi.name, kpi.definition]),
  ].join(" ")
  if (
    /\b(future slot|slot masa depan|slot mendatang|remaining future|jam lapangan masa depan|ketersediaan mendatang)\b/i
      .test(allUserText)
  ) {
    throw createAiServiceError({
      errorCode: "AI_FUTURE_AVAILABILITY_UNSUPPORTED",
      technicalMessage:
        "General Strategy may reference historical empty hours, not future slot availability.",
    })
  }
  if (
    context.revenue_target_context?.available !== true &&
    /\b(revenue target|target revenue|revenue gap|kesenjangan revenue|pencapaian revenue)\b/i
      .test(allUserText)
  ) {
    throw createAiServiceError({
      errorCode: "AI_UNAVAILABLE_METRIC_REFERENCE",
      technicalMessage: "Revenue target metrics are unavailable for this analysis period.",
    })
  }
  const analysisPeriod = context.analysis_period
  if (analysisPeriod?.startDate && analysisPeriod?.endDateExclusive) {
    const referencedIsoDates = allUserText.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []
    if (
      referencedIsoDates.some(
        (date) =>
          date < analysisPeriod.startDate ||
          date >= analysisPeriod.endDateExclusive
      )
    ) {
      throw createAiServiceError({
        errorCode: "AI_ANALYSIS_PERIOD_MISMATCH",
        technicalMessage:
          "The response references a date outside the selected analysis period.",
      })
    }
  }
}

export const validateStrategyResponse = (result, context) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw createAiServiceError({ errorCode: "AI_INVALID_RESPONSE", technicalMessage: "Response is not an object." })
  }
  const scope = context.selected_scope
  if (normalizeKey(result.targetSegmentKey) !== normalizeKey(scope.segmentKey)) {
    throw createAiServiceError({
      errorCode: "AI_SCOPE_MISMATCH",
      technicalMessage: `targetSegmentKey must be ${scope.segmentKey}.`,
    })
  }
  if (scope.venueKey !== "all" && normalizeKey(result.targetVenueKey) !== normalizeKey(scope.venueKey)) {
    throw createAiServiceError({
      errorCode: "AI_VENUE_SCOPE_MISMATCH",
      technicalMessage: `targetVenueKey must be ${scope.venueKey}.`,
    })
  }
  if (scope.sessionKey !== "all" && normalizeKey(result.targetSessionKey) !== normalizeKey(scope.sessionKey)) {
    throw createAiServiceError({
      errorCode: "AI_SESSION_SCOPE_MISMATCH",
      technicalMessage: `targetSessionKey must be ${scope.sessionKey}.`,
    })
  }
  const isOffPeakObjective =
    normalizeKey(scope.campaignObjectiveKey) === "maximize_off_peak_occupancy"
  const primaryOffPeakWindow = context.off_peak_opportunity?.recommendedPrimaryWindow
  if (isOffPeakObjective && context.off_peak_opportunity?.available === true && primaryOffPeakWindow) {
    if (normalizeKey(result.targetDayKey) !== normalizeKey(primaryOffPeakWindow.dayKey)) {
      throw createAiServiceError({
        errorCode: "AI_OFF_PEAK_DAY_MISMATCH",
        technicalMessage: `targetDayKey must be ${primaryOffPeakWindow.dayKey}.`,
      })
    }
    if (normalizeKey(result.targetSessionKey) !== normalizeKey(primaryOffPeakWindow.sessionKey)) {
      throw createAiServiceError({
        errorCode: "AI_OFF_PEAK_SESSION_MISMATCH",
        technicalMessage: `targetSessionKey must be ${primaryOffPeakWindow.sessionKey}.`,
      })
    }
    const requiredWindowLabels = [
      primaryOffPeakWindow.dayLabel,
      primaryOffPeakWindow.sessionLabel,
    ].map((value) => String(value || "").toLowerCase())
    for (const [field, value] of [
      ["campaignObjective", result.campaignObjective],
      ["suggestedOffer", result.suggestedOffer],
    ]) {
      const normalizedValue = String(value || "").toLowerCase()
      if (requiredWindowLabels.some((label) => label && !normalizedValue.includes(label))) {
        throw createAiServiceError({
          errorCode: "AI_INVALID_RESPONSE",
          technicalMessage: `${field} must identify the calculated primary off-peak day and session.`,
        })
      }
    }
  }
  if (!Array.isArray(result.executionPlan) || result.executionPlan.length !== 3) {
    throw createAiServiceError({ errorCode: "AI_INVALID_EXECUTION_PLAN", technicalMessage: "executionPlan must contain exactly 3 entries." })
  }
  if (!Array.isArray(result.kpis) || result.kpis.length !== 3) {
    throw createAiServiceError({ errorCode: "AI_INVALID_KPI_LIST", technicalMessage: "kpis must contain exactly 3 entries." })
  }
  if (!Array.isArray(result.evidenceUsed)) {
    throw createAiServiceError({ errorCode: "AI_INVALID_RESPONSE", technicalMessage: "evidenceUsed must be an array." })
  }
  if (result.evidenceUsed.length > 5) {
    throw createAiServiceError({
      errorCode: "AI_RESPONSE_TOO_VERBOSE",
      technicalMessage: "evidenceUsed must contain no more than 5 entries.",
    })
  }
  const unsupportedEvidencePattern =
    /\b(promotion conversion|campaign attribution|customer response rate|whatsapp response|campaign conversion history|historically converts?|respond(?:s|ed)? strongly|guaranteed?|will increase (?:bookings|revenue|occupancy) by)\b/i
  if (result.evidenceUsed.some((evidence) => unsupportedEvidencePattern.test(String(evidence)))) {
    throw createAiServiceError({
      errorCode: "AI_INVALID_RESPONSE",
      technicalMessage:
        "evidenceUsed contains an unsupported conversion, attribution, response, or guaranteed-impact claim.",
    })
  }
  requireText(result.whatsappMessage, "whatsappMessage")
  requireText(result.offerReasoning, "offerReasoning")
  requireText(result.recommendedOfferKey, "recommendedOfferKey")
  if (result.kpis.some((kpi) => !["increase", "decrease", "maintain"].includes(kpi?.targetDirection))) {
    throw createAiServiceError({ errorCode: "AI_INVALID_KPI_LIST", technicalMessage: "A KPI targetDirection is invalid." })
  }
  if (!SUPPORTED_RECOMMENDED_OFFER_KEYS.has(normalizeKey(result.recommendedOfferKey))) {
    throw createAiServiceError({ errorCode: "AI_OFFER_FRAMEWORK_MISMATCH", technicalMessage: "The recommended offer type is unsupported." })
  }
  const membershipOffer = ["membership_conversion", "membership_trial"].includes(
    normalizeKey(result.recommendedOfferKey)
  )
  if (membershipOffer && context.membership_opportunity?.eligible !== true) {
    throw createAiServiceError({
      errorCode: "AI_INVALID_MEMBERSHIP_RECOMMENDATION",
      technicalMessage: "Membership conversion is not eligible for the selected segment.",
    })
  }
  const routineAiRecommended =
    normalizeKey(scope.segmentKey) === "routine" &&
    normalizeKey(scope.offerFrameworkKey) === "ai_recommended"
  const routineDisallowedOffer = [
    "membership_conversion",
    "membership_trial",
    "recurring_bundle",
  ].includes(normalizeKey(result.recommendedOfferKey))
  if (routineAiRecommended && routineDisallowedOffer) {
    throw createAiServiceError({
      errorCode: "AI_ROUTINE_STRATEGY_MISMATCH",
      technicalMessage:
        "AI-recommended Routine strategy must increase value per visit, not membership or recurring bookings.",
    })
  }
  const selectedOffer = scope.offerFrameworkKey
  if (selectedOffer !== "ai_recommended" && normalizeKey(result.recommendedOfferKey) !== selectedOffer) {
    throw createAiServiceError({
      errorCode: "AI_OFFER_FRAMEWORK_MISMATCH",
      technicalMessage: `recommendedOfferKey must be ${selectedOffer}.`,
    })
  }
  if (hasPersonalDataKey(result)) {
    throw createAiServiceError({
      errorCode: "AI_PRIVACY_VALIDATION_FAILED",
      technicalMessage: "Gemini response contains a personal-data field.",
    })
  }
  if (context.offer_constraints?.exactDiscountAllowed !== true) {
    const offerText = [
      result.recommendedOfferType,
      result.suggestedOffer,
      result.offerReasoning,
      result.whatsappMessage,
    ].join(" ")
    const unapprovedDiscount =
      /\b(?:diskon|potongan)\b[^.!?\n]{0,40}(?:\d+(?:[.,]\d+)?\s*%|rp\s*[\d.]+)/i
    if (unapprovedDiscount.test(offerText)) {
      throw createAiServiceError({
        errorCode: "AI_UNAPPROVED_DISCOUNT_VALUE",
        technicalMessage: "The response contains an exact discount value without an approved range.",
      })
    }
  }
  validateObservableClaims(result, context)
  validateGeneralStrategyPeriodClaims(result, context)
  validateConciseIndonesian(result)
  return result
}

const responseText = async (response) =>
  typeof response?.text === "string"
    ? response.text
    : typeof response?.text === "function"
      ? await response.text()
      : response?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("") || ""

export const isGeminiConfigured = async () => Boolean((await buildConfigSnapshot()).geminiApiKey)

export const generateValidatedStrategy = async (strategyContext, generateResponse) => {
  let lastValidationError = null
  for (let attempt = 0; attempt < GEMINI_GENERATION_CONFIG.maxAttempts; attempt += 1) {
    const response = await generateResponse(
      buildPrompt(strategyContext, lastValidationError?.technicalMessage),
      attempt
    )
    try {
      const parsed = typeof response === "string" ? parseJsonResponse(response) : response
      return validateStrategyResponse(parsed, strategyContext)
    } catch (error) {
      lastValidationError = error
      if (attempt === GEMINI_GENERATION_CONFIG.maxAttempts - 1) throw error
    }
  }
  throw lastValidationError
}

const generateWithGemini = async (strategyContext) => {
  const config = await buildConfigSnapshot()
  const geminiApiKey = config.geminiApiKey
  const geminiModel = config.geminiModel || "gemini-2.5-flash"
  if (!geminiApiKey) {
    throw createAiServiceError({
      errorCode: "GEMINI_NOT_CONFIGURED",
      message: "AI strategy generation is not configured yet.",
      suggestion: "Please ask IT Support to configure Gemini API credentials.",
      technicalMessage: "Missing GEMINI_API_KEY.",
      statusCode: 503,
    })
  }
  const ai = new GoogleGenAI({ apiKey: geminiApiKey })
  const strategy = await generateValidatedStrategy(strategyContext, async (prompt) => {
    let response
    try {
      response = await ai.models.generateContent({
        model: geminiModel,
        contents: prompt,
        config: {
          temperature: GEMINI_GENERATION_CONFIG.temperature,
          maxOutputTokens: GEMINI_GENERATION_CONFIG.maxOutputTokens,
          responseMimeType: GEMINI_GENERATION_CONFIG.responseMimeType,
          responseJsonSchema: strategySchema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
    } catch (error) {
      throw createAiServiceError({
        errorCode: "AI_GENERATION_FAILED",
        technicalMessage: error instanceof Error ? error.message : "Gemini request failed.",
        statusCode: 500,
      })
    }
    return responseText(response)
  })
  return {
    provider: "gemini",
    model: geminiModel,
    strategy,
  }
}

export const getAiProviderStatus = async () => {
  const config = await buildConfigSnapshot()
  const configured = Boolean(config.geminiApiKey) && config.geminiEnabled
  return {
    provider: "gemini",
    providerLabel: "Gemini",
    configured,
    enabled: config.geminiEnabled,
    model: config.geminiModel || "gemini-2.5-flash",
    setupMessage: configured ? null : "AI strategy generation is not configured yet.",
    suggestion: configured ? null : "Please ask IT Support to configure Gemini API credentials.",
  }
}

export const generateStrategy = async (strategyContext) => {
  const config = await buildConfigSnapshot()
  if (!config.geminiEnabled) {
    throw createAiServiceError({
      errorCode: "AI_DISABLED",
      message: "AI strategy generation is currently disabled.",
      technicalMessage: "Gemini integration is disabled.",
      statusCode: 503,
    })
  }
  return generateWithGemini(strategyContext)
}
