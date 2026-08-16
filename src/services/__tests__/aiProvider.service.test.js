import test from "node:test"
import assert from "node:assert/strict"

import {
  ASK_AI_WORD_LIMIT,
  buildAskAiPrompt,
  buildPrompt,
  GEMINI_GENERATION_CONFIG,
  generateValidatedStrategy,
  sanitizeGeminiContext,
  STRATEGY_WORD_LIMITS,
  validateAskAiAnswer,
  validateStrategyResponse,
} from "../aiProvider.service.js"

const context = (overrides = {}) => ({
  selected_scope: {
    segmentKey: "re_engagement",
    venueKey: "mini_soccer",
    sessionKey: "night",
    offerFrameworkKey: "ai_recommended",
    ...overrides,
  },
  membership_opportunity: { eligible: false },
  data_availability: {
    promotionConversionAvailable: false,
    campaignAttributionAvailable: false,
    customerResponseRateAvailable: false,
    campaignConversionHistoryAvailable: false,
  },
})

const validResult = (overrides = {}) => ({
  targetSegmentKey: "re_engagement",
  targetSegmentLabel: "Re-Engagement Players",
  targetVenueKey: "mini_soccer",
  targetVenueLabel: "Mini Soccer",
  targetSessionKey: "night",
  targetSessionLabel: "Night",
  targetDayKey: null,
  targetDayLabel: null,
  campaignObjective: "Reactivate customers who have stopped booking.",
  recommendedOfferKey: "reactivation_offer",
  recommendedOfferType: "Comeback play package",
  suggestedOffer: "Add a welcome-back benefit to the next booking.",
  offerReasoning: "High recency supports a limited-time comeback offer.",
  customerReasoning: "Selected segment booked before but is now inactive.",
  evidenceUsed: ["Average recency for the segment is high."],
  executionPlan: Array.from({ length: 3 }, (_, index) => ({
    timing: `D-${index}`, action: "Send the offer via WhatsApp.", successCondition: "Campaign message is ready.",
  })),
  followUpPlan: "Send one reminder to customers who have not booked yet.",
  stopCondition: "Stop the campaign after the period ends.",
  whatsappMessage: "Hi, come back and play at Maiin Gandaria again.",
  expectedBusinessImpact: "May increase bookings from reactivated customers.",
  kpis: Array.from({ length: 3 }, (_, index) => ({
    name: `KPI ${index}`, definition: "Bookings from the target segment.", targetDirection: "increase",
  })),
  dataLimitation: "Campaign attribution data is not available.",
  ...overrides,
})

const offPeakContext = (overrides = {}) => ({
  ...context({
    campaignObjectiveKey: "maximize_off_peak_occupancy",
    sessionKey: "all",
  }),
  off_peak_opportunity: {
    available: true,
    recommendedPrimaryWindow: {
      dayKey: "tuesday",
      dayLabel: "Selasa",
      sessionKey: "afternoon",
      sessionLabel: "Siang",
    },
  },
  offer_constraints: {
    exactDiscountAllowed: false,
    approvedDiscountRangePct: null,
  },
  ...overrides,
})

const validOffPeakResult = (overrides = {}) =>
  validResult({
    targetDayKey: "tuesday",
    targetDayLabel: "Selasa",
    targetSessionKey: "afternoon",
    targetSessionLabel: "Siang",
    campaignObjective: "Increase Tuesday (Selasa) afternoon (Siang) session occupancy.",
    suggestedOffer: "Add a benefit to Tuesday (Selasa) afternoon (Siang) bookings.",
    offerReasoning: "Tuesday (Selasa) afternoon (Siang) has the lowest historical occupancy.",
    whatsappMessage: "Book Tuesday (Selasa) afternoon (Siang) with an extra benefit from Maiin Gandaria.",
    ...overrides,
  })

test("prompt requires concise English and compact structured output", () => {
  const prompt = buildPrompt(context())
  assert.match(prompt, /professional English/)
  assert.match(prompt, /campaignObjective: 18/)
  assert.match(prompt, /whatsappMessage: 65/)
  assert.match(prompt, /Do not repeat/)
  assert.match(prompt, /offer redemption/)
  assert.match(prompt, /selected segment \+ campaign objective/i)
  assert.match(prompt, /Routine: increase customer value and revenue per visit/i)
  assert.match(prompt, /Photographer, Premium Ball, Match Highlight Video, and Referee Package/i)
  assert.match(prompt, /boost_social_media_conversion[\s\S]*Photographer or Match Highlight Video/i)
  assert.match(prompt, /drive_revenue_growth[\s\S]*allowed premium add-ons/i)
  assert.match(prompt, /maximize_off_peak_occupancy[\s\S]*lowest-occupancy window/i)
  assert.match(prompt, /Growth: next booking, recurring or weekly booking packages/i)
  assert.match(prompt, /Every General Strategy recommendation must use analysis_period/i)
  assert.match(prompt, /historical empty court hours, not future available slots/i)
  assert.match(prompt, /Quote at least two specific figures in offerReasoning and evidenceUsed/i)
  assert.match(prompt, /Avoid hedge words such as "consider"/i)
  assert.equal(GEMINI_GENERATION_CONFIG.temperature, 0.3)
  assert.equal(GEMINI_GENERATION_CONFIG.maxOutputTokens, 1100)
  assert.equal(GEMINI_GENERATION_CONFIG.maxAttempts, 2)
  assert.equal(GEMINI_GENERATION_CONFIG.responseMimeType, "application/json")
  assert.equal(STRATEGY_WORD_LIMITS.evidenceItem, 16)
})

test("user notes are appended as the highest-priority instruction", () => {
  const withNotes = buildPrompt(context(), null, "Focus on the Friday evening slot and premium add-ons.")
  const withoutNotes = buildPrompt(context())
  assert.match(withNotes, /Additional user instructions \(highest priority/)
  assert.match(withNotes, /Focus on the Friday evening slot and premium add-ons\./)
  assert.doesNotMatch(withoutNotes, /Additional user instructions/)

  const corrected = buildPrompt(context(), "AI_RESPONSE_TOO_VERBOSE", "Keep it shorter.")
  assert.match(corrected, /Additional user instructions/)
  assert.match(corrected, /preserving the exact selected scope/)
})

test("concise English response is accepted and canonical keys remain valid", () => {
  const result = validateStrategyResponse(validResult(), context())
  assert.equal(result.targetSegmentKey, "re_engagement")
  assert.equal(result.kpis[0].targetDirection, "increase")
})

test("clearly Indonesian explanatory content is rejected", () => {
  assert.throws(
    () => validateStrategyResponse(validResult({
      campaignObjective: "Kampanye ini akan mengaktifkan kembali pelanggan terpilih.",
      suggestedOffer: "Kirim penawaran khusus untuk pelanggan yang sudah tidak aktif.",
      offerReasoning: "Penawaran ini cocok karena pelanggan sudah lama tidak bermain.",
      customerReasoning: "Pelanggan terpilih adalah target yang tepat untuk kampanye ini.",
      followUpPlan: "Kirim satu pengingat setelah pesan kampanye pertama.",
      stopCondition: "Hentikan ketika periode kampanye telah berakhir.",
      expectedBusinessImpact: "Strategi ini berpotensi meningkatkan booking dari pelanggan tidak aktif.",
      dataLimitation: "Data atribusi kampanye tidak tersedia.",
      whatsappMessage: "Yuk kembali main bersama kami di Maiin Gandaria.",
    }), context()),
    (error) => error.errorCode === "AI_RESPONSE_LANGUAGE_MISMATCH"
  )
})

test("word limits and evidence count are enforced", () => {
  const tooLong = (count) => Array.from({ length: count }, () => "kata").join(" ")
  for (const [field, limit] of [
    ["offerReasoning", STRATEGY_WORD_LIMITS.offerReasoning],
    ["expectedBusinessImpact", STRATEGY_WORD_LIMITS.expectedBusinessImpact],
    ["whatsappMessage", STRATEGY_WORD_LIMITS.whatsappMessage],
  ]) {
    assert.throws(
      () => validateStrategyResponse(validResult({ [field]: tooLong(limit + 1) }), context()),
      (error) => error.errorCode === "AI_RESPONSE_TOO_VERBOSE"
    )
  }
  assert.throws(
    () => validateStrategyResponse(validResult({ evidenceUsed: Array(6).fill("Data tersedia.") }), context()),
    (error) => error.errorCode === "AI_RESPONSE_TOO_VERBOSE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: [tooLong(STRATEGY_WORD_LIMITS.evidenceItem + 1)] }),
      context()
    ),
    (error) => error.errorCode === "AI_RESPONSE_TOO_VERBOSE"
  )
})

test("one corrective retry preserves scope and no third attempt occurs", async () => {
  let attempts = 0
  const prompts = []
  const strategy = await generateValidatedStrategy(context(), async (prompt) => {
    attempts += 1
    prompts.push(prompt)
    return attempts === 1
      ? validResult({ offerReasoning: Array(29).fill("kata").join(" ") })
      : validResult()
  })
  assert.equal(attempts, 2)
  assert.equal(strategy.targetSegmentKey, "re_engagement")
  assert.match(prompts[1], /preserving the exact selected scope/)

  attempts = 0
  await assert.rejects(
    () => generateValidatedStrategy(context(), async () => {
      attempts += 1
      return validResult({ whatsappMessage: Array(66).fill("kata").join(" ") })
    }),
    (error) => error.errorCode === "AI_RESPONSE_TOO_VERBOSE"
  )
  assert.equal(attempts, 2)
})

test("selected segment, venue, and session scope mismatches are rejected", () => {
  assert.throws(
    () => validateStrategyResponse(validResult({ targetSegmentKey: "prime" }), context()),
    (error) => error.errorCode === "AI_SCOPE_MISMATCH"
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ targetVenueKey: "basketball" }), context()),
    (error) => error.errorCode === "AI_VENUE_SCOPE_MISMATCH"
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ targetSessionKey: "morning" }), context()),
    (error) => error.errorCode === "AI_SESSION_SCOPE_MISMATCH"
  )
  assert.equal(validateStrategyResponse(validResult(), context()).targetSegmentKey, "re_engagement")
})

test("all venue and all session allow general nullable targets", () => {
  const result = validResult({ targetVenueKey: null, targetSessionKey: null })
  assert.equal(validateStrategyResponse(
    result,
    context({ venueKey: "all", sessionKey: "all" })
  ).targetVenueKey, null)
})

test("response structure validation rejects bad plans, KPIs, evidence, and messages", () => {
  assert.throws(
    () => validateStrategyResponse(validResult({ executionPlan: [] }), context()),
    (error) => error.errorCode === "AI_INVALID_EXECUTION_PLAN"
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ kpis: [] }), context()),
    (error) => error.errorCode === "AI_INVALID_KPI_LIST"
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ evidenceUsed: "not-array" }), context()),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ whatsappMessage: "" }), context()),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  const badKpis = validResult().kpis.map((kpi, index) =>
    index === 0 ? { ...kpi, targetDirection: "guaranteed" } : kpi
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ kpis: badKpis }), context()),
    (error) => error.errorCode === "AI_INVALID_KPI_LIST"
  )
})

test("membership and selected offer framework validation are enforced", () => {
  assert.throws(
    () => validateStrategyResponse(
      validResult({ recommendedOfferKey: "membership_conversion" }),
      context()
    ),
    (error) => error.errorCode === "AI_INVALID_MEMBERSHIP_RECOMMENDATION"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ recommendedOfferKey: "reactivation_offer" }),
      context({ offerFrameworkKey: "time_based_discount" })
    ),
    (error) => error.errorCode === "AI_OFFER_FRAMEWORK_MISMATCH"
  )
})

test("AI-recommended Routine strategy rejects membership and recurring offers", () => {
  const routineContext = {
    ...context({
      segmentKey: "routine",
      offerFrameworkKey: "ai_recommended",
    }),
    membership_opportunity: { eligible: true },
  }
  const routineResult = {
    targetSegmentKey: "routine",
    targetSegmentLabel: "Routine Players",
  }

  for (const recommendedOfferKey of [
    "membership_conversion",
    "membership_trial",
    "recurring_bundle",
  ]) {
    assert.throws(
      () => validateStrategyResponse(
        validResult({ ...routineResult, recommendedOfferKey }),
        routineContext
      ),
      (error) => error.errorCode === "AI_ROUTINE_STRATEGY_MISMATCH"
    )
  }

  assert.equal(
    validateStrategyResponse(
      validResult({
        ...routineResult,
        recommendedOfferKey: "value_added_services",
        recommendedOfferType: "Match Highlight Video",
      }),
      routineContext
    ).recommendedOfferKey,
    "value_added_services"
  )
})

test("privacy sanitizer recursively removes personal and raw fields but retains aggregates", () => {
  const sanitized = sanitizeGeminiContext({
    customerCount: 10,
    membershipCount: 4,
    customerName: "Private",
    name: "Private",
    nama: "Private",
    email: "private@example.com",
    normalizedEmail: "private@example.com",
    phone: "1",
    normalizedPhone: "1",
    noTelepon: "1",
    customerKey: "key",
    customerIdentity: "identity",
    customerId: 1,
    rawData: {},
    facilityTransactions: [],
  })
  assert.deepEqual(sanitized, { customerCount: 10, membershipCount: 4 })
})

test("evidence rejects unavailable campaign conversion, response, attribution, and guarantees", () => {
  for (const claim of [
    "This promotion conversion rate is historically strong.",
    "WhatsApp response is high.",
    "Campaign attribution proves the offer works.",
    "This will increase bookings by 30%.",
  ]) {
    assert.throws(
      () => validateStrategyResponse(validResult({ evidenceUsed: [claim] }), context()),
      (error) => error.errorCode === "AI_INVALID_RESPONSE"
    )
  }
})

test("available aggregated opportunity evidence remains valid", () => {
  const result = validateStrategyResponse(
    validResult({
      evidenceUsed: [
        "Current occupancy is 20%.",
        "Recorded promotion usage is 25% of valid selected-segment bookings.",
      ],
    }),
    context()
  )
  assert.equal(result.evidenceUsed.length, 2)
})

test("unavailable response, redemption, and attribution metrics cannot drive KPIs or stop conditions", () => {
  const responseRateKpis = validResult().kpis.map((kpi, index) =>
    index === 0
      ? { ...kpi, name: "Tingkat respons WhatsApp", definition: "Persentase pelanggan yang merespons WhatsApp." }
      : kpi
  )
  assert.throws(
    () => validateStrategyResponse(validResult({ kpis: responseRateKpis }), context()),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ stopCondition: "Hentikan jika tingkat penukaran penawaran tetap rendah." }),
      context()
    ),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["Atribusi campaign membuktikan penawaran berhasil."] }),
      context()
    ),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
})

test("off-peak day and session must match the calculated primary window", () => {
  assert.throws(
    () => validateStrategyResponse(
      validOffPeakResult({ targetDayKey: "monday" }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_OFF_PEAK_DAY_MISMATCH"
  )
  assert.throws(
    () => validateStrategyResponse(
      validOffPeakResult({ targetSessionKey: "night" }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_OFF_PEAK_SESSION_MISMATCH"
  )
  assert.equal(
    validateStrategyResponse(validOffPeakResult(), offPeakContext()).targetDayKey,
    "tuesday"
  )
})

test("reliable off-peak strategy rejects generic wording and unapproved exact discounts", () => {
  assert.throws(
    () => validateStrategyResponse(
      validOffPeakResult({ campaignObjective: "Increase occupancy during the quiet period." }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validOffPeakResult({
        suggestedOffer: "Give a discount of 20% for Tuesday (Selasa) afternoon (Siang) bookings.",
      }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_UNAPPROVED_DISCOUNT_VALUE"
  )
  assert.equal(
    validateStrategyResponse(
      validOffPeakResult({
        suggestedOffer: "Add an extra service for Tuesday (Selasa) afternoon (Siang) bookings.",
      }),
      offPeakContext()
    ).recommendedOfferKey,
    "reactivation_offer"
  )
})

test("unavailable off-peak context does not force a target day or session", () => {
  const unavailable = offPeakContext({
    off_peak_opportunity: {
      available: false,
      recommendedPrimaryWindow: null,
      lowestOccupancyWindows: [],
    },
  })
  const result = validateStrategyResponse(
    validResult({ targetDayKey: null, targetDayLabel: null }),
    unavailable
  )
  assert.equal(result.targetDayKey, null)
})

test("General Strategy rejects future-slot and unavailable revenue-target claims", () => {
  const generalContext = {
    ...context({
      workspaceModeKey: "general_strategy",
      analysisPeriodKey: "three_months",
    }),
    analysis_period: {
      key: "three_months",
      label: "3 Bulan",
      startDate: "2026-04-30",
      displayEndDate: "2026-07-29",
    },
    revenue_target_context: { available: false },
  }
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["A future slot remains available."] }),
      generalContext
    ),
    (error) => error.errorCode === "AI_FUTURE_AVAILABILITY_UNSUPPORTED"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["The revenue target has not been met."] }),
      generalContext
    ),
    (error) => error.errorCode === "AI_UNAVAILABLE_METRIC_REFERENCE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["Bookings on 2026-04-01 were high."] }),
      {
        ...generalContext,
        analysis_period: {
          ...generalContext.analysis_period,
          endDateExclusive: "2026-07-30",
        },
      }
    ),
    (error) => error.errorCode === "AI_ANALYSIS_PERIOD_MISMATCH"
  )
})

test("ask prompt embeds the question, sanitized context, and English rules", () => {
  const prompt = buildAskAiPrompt("Which session should the next promotion target?", context())
  assert.match(prompt, /Operator's question:/)
  assert.match(prompt, /Which session should the next promotion target\?/)
  assert.match(prompt, /Aggregated historical context:/)
  assert.match(prompt, /"segmentKey": "re_engagement"/)
  assert.match(prompt, /Respond in English/)
  assert.match(prompt, /Never output names, email addresses, phone numbers, customer keys/)
  assert.doesNotMatch(prompt, /"customerName"/)
})

test("ask answers must be non-empty, within the word limit, and free of personal data", () => {
  assert.throws(
    () => validateAskAiAnswer(""),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateAskAiAnswer(Array(ASK_AI_WORD_LIMIT + 1).fill("word").join(" ")),
    (error) => error.errorCode === "AI_RESPONSE_TOO_VERBOSE"
  )
  assert.throws(
    () => validateAskAiAnswer("Please call this customer at 081234567890 about the offer."),
    (error) => error.errorCode === "AI_PRIVACY_VALIDATION_FAILED"
  )
  assert.throws(
    () => validateAskAiAnswer("Email the report to budi@example.com."),
    (error) => error.errorCode === "AI_PRIVACY_VALIDATION_FAILED"
  )
  assert.equal(
    validateAskAiAnswer("Target Tuesday afternoon: its historical occupancy is 20%."),
    "Target Tuesday afternoon: its historical occupancy is 20%."
  )
})
