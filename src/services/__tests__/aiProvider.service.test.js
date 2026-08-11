import test from "node:test"
import assert from "node:assert/strict"

import {
  buildPrompt,
  GEMINI_GENERATION_CONFIG,
  generateValidatedStrategy,
  sanitizeGeminiContext,
  STRATEGY_WORD_LIMITS,
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
  campaignObjective: "Mengaktifkan kembali pelanggan yang tidak aktif.",
  recommendedOfferKey: "reactivation_offer",
  recommendedOfferType: "Paket kembali bermain",
  suggestedOffer: "Berikan benefit tambahan untuk pemesanan berikutnya.",
  offerReasoning: "Recency tinggi mendukung penawaran kembali bermain yang terbatas.",
  customerReasoning: "Segmen terpilih pernah booking tetapi kini tidak aktif.",
  evidenceUsed: ["Rata-rata recency segmen tergolong tinggi."],
  executionPlan: Array.from({ length: 3 }, (_, index) => ({
    timing: `H-${index}`, action: "Kirim penawaran melalui WhatsApp.", successCondition: "Pesan campaign telah disiapkan.",
  })),
  followUpPlan: "Kirim satu pengingat kepada pelanggan yang belum booking.",
  stopCondition: "Hentikan campaign setelah periode berakhir.",
  whatsappMessage: "Halo Kak, yuk kembali main di Maiin Gandaria.",
  expectedBusinessImpact: "Berpotensi meningkatkan booking dari pelanggan yang kembali aktif.",
  kpis: Array.from({ length: 3 }, (_, index) => ({
    name: `KPI ${index}`, definition: "Jumlah booking segmen target.", targetDirection: "increase",
  })),
  dataLimitation: "Data atribusi campaign belum tersedia.",
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
    campaignObjective: "Tingkatkan okupansi Selasa sesi Siang.",
    suggestedOffer: "Berikan benefit tambahan untuk booking Selasa sesi Siang.",
    offerReasoning: "Selasa sesi Siang memiliki okupansi historis terendah.",
    whatsappMessage: "Yuk booking Selasa sesi Siang dengan benefit tambahan dari Maiin Gandaria.",
    ...overrides,
  })

test("prompt requires concise Bahasa Indonesia and compact structured output", () => {
  const prompt = buildPrompt(context())
  assert.match(prompt, /Bahasa Indonesia/)
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
  assert.equal(GEMINI_GENERATION_CONFIG.temperature, 0.3)
  assert.equal(GEMINI_GENERATION_CONFIG.maxOutputTokens, 1100)
  assert.equal(GEMINI_GENERATION_CONFIG.maxAttempts, 2)
  assert.equal(GEMINI_GENERATION_CONFIG.responseMimeType, "application/json")
  assert.equal(STRATEGY_WORD_LIMITS.evidenceItem, 16)
})

test("concise Indonesian response is accepted and canonical English keys remain valid", () => {
  const result = validateStrategyResponse(validResult(), context())
  assert.equal(result.targetSegmentKey, "re_engagement")
  assert.equal(result.kpis[0].targetDirection, "increase")
})

test("clearly English explanatory content is rejected", () => {
  assert.throws(
    () => validateStrategyResponse(validResult({
      campaignObjective: "The campaign will reactivate selected customers through a targeted offer.",
      suggestedOffer: "Send the selected customers a valuable comeback offer.",
      offerReasoning: "This offer is suitable because the customers have become inactive.",
      customerReasoning: "The selected customers are the right audience for this campaign.",
      followUpPlan: "Send one reminder after the first campaign message.",
      stopCondition: "Stop when the campaign period has ended.",
      expectedBusinessImpact: "The strategy may increase bookings from inactive customers.",
      dataLimitation: "Campaign attribution data is unavailable.",
      whatsappMessage: "Come back and book your next game with us today.",
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
      validOffPeakResult({ campaignObjective: "Tingkatkan okupansi pada periode sepi." }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_INVALID_RESPONSE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validOffPeakResult({
        suggestedOffer: "Berikan diskon 20% untuk booking Selasa sesi Siang.",
      }),
      offPeakContext()
    ),
    (error) => error.errorCode === "AI_UNAPPROVED_DISCOUNT_VALUE"
  )
  assert.equal(
    validateStrategyResponse(
      validOffPeakResult({
        suggestedOffer: "Berikan layanan tambahan untuk booking Selasa sesi Siang.",
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
      validResult({ evidenceUsed: ["Slot masa depan masih tersedia."] }),
      generalContext
    ),
    (error) => error.errorCode === "AI_FUTURE_AVAILABILITY_UNSUPPORTED"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["Target revenue belum tercapai."] }),
      generalContext
    ),
    (error) => error.errorCode === "AI_UNAVAILABLE_METRIC_REFERENCE"
  )
  assert.throws(
    () => validateStrategyResponse(
      validResult({ evidenceUsed: ["Booking pada 2026-04-01 tercatat tinggi."] }),
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
