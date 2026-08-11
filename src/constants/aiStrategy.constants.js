export const CUSTOMER_SEGMENTS = {
  PRIME: { key: "prime", label: "Prime Players" },
  ROUTINE: { key: "routine", label: "Routine Players" },
  GROWTH: { key: "growth", label: "Growth Players" },
  RE_ENGAGEMENT: { key: "re_engagement", label: "Re-Engagement Players" },
}

export const CUSTOMER_SEGMENT_LIST = Object.values(CUSTOMER_SEGMENTS)

export const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")

const SEGMENT_ALIASES = new Map(
  CUSTOMER_SEGMENT_LIST.flatMap((segment) => [
    [normalizeKey(segment.key), segment],
    [normalizeKey(segment.label), segment],
    [normalizeKey(segment.label.replace(/ players$/i, "")), segment],
  ])
)

export const resolveCustomerSegment = (value) => SEGMENT_ALIASES.get(normalizeKey(value)) || null

export const MEMBERSHIP_OPPORTUNITY_RULE = {
  minimumNonMembershipSharePct: 50,
  minimumAverageFrequency: 2,
}

export const OCCUPANCY_OPPORTUNITY_RULES = {
  highGapPercentagePoints: 15,
  mediumGapPercentagePoints: 5,
}

export const OFF_PEAK_ANALYSIS_RULES = Object.freeze({
  lookbackMonths: 3,
  resultLimit: 3,
  minimumObservedWeeks: 4,
  minimumAvailableCourtHours: 8,
})

export const ANALYSIS_PERIODS = Object.freeze({
  ONE_MONTH: Object.freeze({ key: "one_month", months: 1, label: "1 Bulan" }),
  THREE_MONTHS: Object.freeze({ key: "three_months", months: 3, label: "3 Bulan" }),
  SIX_MONTHS: Object.freeze({ key: "six_months", months: 6, label: "6 Bulan" }),
  TWELVE_MONTHS: Object.freeze({ key: "twelve_months", months: 12, label: "12 Bulan" }),
})

export const DEFAULT_ANALYSIS_PERIOD = ANALYSIS_PERIODS.THREE_MONTHS

const ANALYSIS_PERIOD_BY_KEY = new Map(
  Object.values(ANALYSIS_PERIODS).map((period) => [period.key, period])
)

export const resolveAnalysisPeriod = (value = DEFAULT_ANALYSIS_PERIOD.key) =>
  ANALYSIS_PERIOD_BY_KEY.get(normalizeKey(value)) || null

export const SEGMENT_STRATEGY_GUIDANCE = {
  prime: {
    lifecycleObjective: "Retain high-value customers and strengthen loyalty.",
    preferredTreatments: [
      "priority booking",
      "early access",
      "complimentary team photography",
      "free beverage",
      "premium facility add-on",
      "loyalty reward",
      "referral benefit",
      "exclusive event or tournament invitation",
    ],
    avoid: [
      "unnecessary heavy discounting",
      "generic acquisition messaging",
      "treating loyal customers as inactive",
    ],
    campaignObjectiveTreatments: {
      drive_revenue_growth: [
        "premium experience",
        "referral benefit",
        "priority booking",
      ],
      maximize_off_peak_occupancy: [
        "premium loyalty benefit for the verified off-peak window",
        "priority access for the verified off-peak window",
      ],
      boost_social_media_conversion: [
        "exclusive event content",
        "referral campaign with shareable team moments",
      ],
      customer_reactivation_and_retention: [
        "loyalty reward",
        "exclusive member experience",
        "priority booking",
      ],
    },
  },
  routine: {
    lifecycleObjective:
      "Increase customer value and revenue per visit through a premium match experience.",
    preferredTreatments: [
      "Photographer",
      "Premium Ball",
      "Match Highlight Video",
      "Referee Package",
    ],
    avoid: [
      "membership conversion as the primary recommendation",
      "recurring booking package",
      "weekly booking package",
      "win-back messaging for active customers",
      "churn language without evidence",
    ],
    campaignObjectiveTreatments: {
      drive_revenue_growth: [
        "Photographer",
        "Premium Ball",
        "Match Highlight Video",
        "Referee Package",
      ],
      maximize_off_peak_occupancy: [
        "one or more allowed premium add-ons limited to the verified lowest-occupancy day and session",
      ],
      boost_social_media_conversion: [
        "Photographer",
        "Match Highlight Video",
      ],
      customer_reactivation_and_retention: [
        "loyalty benefit",
        "exclusive member experience",
        "premium service",
        "priority booking",
      ],
    },
  },
  growth: {
    lifecycleObjective: "Encourage the next booking and build repeat-booking habits.",
    preferredTreatments: [
      "second-booking incentive",
      "limited repeat-booking benefit",
      "light multi-session bundle",
      "referral reward",
      "post-visit reminder",
      "value-added benefit",
      "short-validity next-booking offer",
      "recurring booking package",
      "weekly booking package",
    ],
    avoid: [
      "large long-term commitment",
      "premium loyalty treatment without enough history",
      "churn-recovery messaging",
      "heavy discounting without evidence",
    ],
    campaignObjectiveTreatments: {
      drive_revenue_growth: [
        "light multi-session package",
        "repeat-visit value benefit",
      ],
      maximize_off_peak_occupancy: [
        "next-booking or weekly package for the verified off-peak window",
      ],
      boost_social_media_conversion: [
        "referral reward",
        "shareable next-visit experience",
      ],
      customer_reactivation_and_retention: [
        "habit-forming recurring package",
        "next-booking reminder",
      ],
    },
  },
  re_engagement: {
    lifecycleObjective: "Reactivate inactive customers and recover churn risk.",
    preferredTreatments: [
      "win-back offer",
      "limited comeback package",
      "complimentary photographer",
      "free mineral water",
      "free equipment",
      "time-limited reactivation benefit",
      "historically preferred venue/session offer",
      "we-miss-you campaign",
    ],
    avoid: [
      "describing customers as currently loyal or active",
      "generic retention messaging",
      "recommendations unrelated to historical preferences",
      "routine membership messaging without supporting evidence",
    ],
    campaignObjectiveTreatments: {
      drive_revenue_growth: [
        "return offer that restores booking activity before upselling",
      ],
      maximize_off_peak_occupancy: [
        "win-back benefit for the verified off-peak window",
      ],
      boost_social_media_conversion: [
        "shareable comeback experience",
        "visual return benefit when supported",
      ],
      customer_reactivation_and_retention: [
        "comeback campaign",
        "limited-time win-back promotion",
        "special return offer",
      ],
    },
  },
}

export const OFFER_FRAMEWORKS = {
  ai_recommended: { key: "ai_recommended", label: "AI Recommended Offer" },
  time_based_discount: { key: "time_based_discount", label: "Time-Based Discount" },
  value_added_services: { key: "value_added_services", label: "Value-Added Services" },
  membership_conversion: { key: "membership_conversion", label: "Membership Conversion" },
  recurring_bundle: { key: "recurring_bundle", label: "Recurring Booking Package" },
  loyalty_benefit: { key: "loyalty_benefit", label: "Loyalty Benefit" },
  reactivation_offer: { key: "reactivation_offer", label: "Reactivation Offer" },
}

const OFFER_ALIASES = new Map([
  ...Object.values(OFFER_FRAMEWORKS).flatMap((offer) => [
    [normalizeKey(offer.key), offer],
    [normalizeKey(offer.label), offer],
  ]),
  ["loyalty_points_multiplier", OFFER_FRAMEWORKS.loyalty_benefit],
  ["fixed_rate_bundling", OFFER_FRAMEWORKS.recurring_bundle],
])

export const resolveOfferFramework = (value) =>
  OFFER_ALIASES.get(normalizeKey(value)) || null

export const SUPPORTED_RECOMMENDED_OFFER_KEYS = new Set([
  "time_based_discount",
  "value_added_services",
  "membership_conversion",
  "membership_trial",
  "recurring_bundle",
  "loyalty_benefit",
  "reactivation_offer",
  "priority_booking",
  "referral_reward",
])
