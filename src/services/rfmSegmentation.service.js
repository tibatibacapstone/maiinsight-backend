import { prisma } from "../config/prisma.js"
import {
  buildFacilityTransactionWhere,
  normalizeBookingTypeFilter,
  normalizeCourtTypeFilter,
  resolveSelectedDateRange,
} from "./dashboardPeriod.service.js"

const DEFAULT_K = 4
const DEFAULT_MIN_K = 2
const DEFAULT_MAX_K = 8
const SEGMENTATION_METHOD = "RFM_KMEANS"
const RUNNING_STATUS = "running"
const COMPLETED_STATUS = "completed"
const FAILED_STATUS = "failed"
const MIXED_BOOKING_TYPE_LABEL = "Mixed/Other"

const BOOKING_TYPE_DISPLAY_MAP = {
  member_internal_booking: "Membership",
  regular_booking: "Non Membership",
  other: "Other",
}

const SEGMENT_DEFINITIONS = [
  {
    baseName: "Prime Players",
    description:
      "Highly valuable players with strong booking frequency and revenue contribution.",
    recommendedAction:
      "Prioritize retention, loyalty benefits, priority booking, and membership offers.",
  },
  {
    baseName: "Routine Players",
    description:
      "Consistent players with routine booking patterns and stable revenue contribution.",
    recommendedAction:
      "Maintain with routine booking packages, membership upgrades, and consistent engagement offers.",
  },
  {
    baseName: "Growth Players",
    description:
      "Players with potential to increase booking frequency and revenue contribution.",
    recommendedAction:
      "Target with follow-up promotions, bundles, repeat-booking nudges, and conversion campaigns.",
  },
  {
    baseName: "Re-Engagement Players",
    description:
      "Players with low recent activity who require re-engagement or low-touch awareness campaigns.",
    recommendedAction:
      "Target with reactivation campaigns, general awareness campaigns, and selective follow-up based on historical value.",
  },
]

const SEGMENT_DEFINITION_BY_NAME = new Map(
  SEGMENT_DEFINITIONS.map((definition) => [definition.baseName, definition])
)

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ""

const startOfDay = (value) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

const endOfDay = (value) => {
  const date = new Date(value)
  date.setHours(23, 59, 59, 999)
  return date
}

const toNumber = (value) => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber()
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundNumber = (value, precision = 2) => Number(value.toFixed(precision))

const getCurrentYear = () => new Date().getFullYear()

const normalizePeriodType = (value) =>
  String(value ?? "").trim().toUpperCase() === "YTD" ? "YTD" : "MTD"

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value

  const normalizedValue = String(value ?? "").trim().toLowerCase()

  if (["true", "1", "yes", "y"].includes(normalizedValue)) return true
  if (["false", "0", "no", "n"].includes(normalizedValue)) return false

  return fallback
}

const normalizePositiveInteger = (value, fallback = null) => {
  if (!hasValue(value)) return fallback

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

const mapBookingTypeToDisplayLabel = (bookingType) =>
  BOOKING_TYPE_DISPLAY_MAP[bookingType] || BOOKING_TYPE_DISPLAY_MAP.other

const normalizeSegmentationScope = (input = {}) => {
  const providedMonth = hasValue(input.month) ? String(input.month).trim() : null
  const providedYear = hasValue(input.year) ? Number(input.year) : null
  const periodType = normalizePeriodType(input.periodType)
  const courtType = normalizeCourtTypeFilter(input.courtType ?? input.venue)
  const bookingType = normalizeBookingTypeFilter({
    bookingType: input.bookingType,
    customerType: input.customerType,
  })

  const hasDateScope = Boolean(providedMonth || providedYear)
  const filterYear = hasDateScope ? providedYear || getCurrentYear() : null
  const filterMonth = hasDateScope ? providedMonth || "All Month" : null

  const dateRange = hasDateScope
    ? resolveSelectedDateRange({
        selectedYear: filterYear,
        selectedMonth: filterMonth,
        periodType,
      })
    : null

  return {
    filterMonth,
    filterYear,
    filterPeriodType: hasDateScope ? periodType : null,
    filterCourtType: courtType,
    filterBookingType: bookingType,
    startDate: dateRange?.startDate || null,
    endDate: dateRange?.endDate || null,
    analysisDate: dateRange?.endDate ? endOfDay(dateRange.endDate) : endOfDay(new Date()),
    hasScope: Boolean(hasDateScope || courtType || bookingType),
    isEmptyDateScope: hasDateScope && !dateRange,
  }
}

const normalizeKSelectionOptions = (input = {}) => {
  const manualK = normalizePositiveInteger(input.k)
  const analystMode = normalizeBoolean(input.analysisMode ?? input.analystMode, false)
  const autoKRequested = normalizeBoolean(input.autoK, false)
  const minK = Math.max(2, normalizePositiveInteger(input.minK, DEFAULT_MIN_K))
  const maxK = Math.max(minK, normalizePositiveInteger(input.maxK, DEFAULT_MAX_K))

  return {
    manualK,
    analystMode,
    autoKRequested,
    minK,
    maxK,
  }
}

const buildSegmentationRunWhere = (input = {}) => {
  const normalizedScope = normalizeSegmentationScope(input)
  const where = {}

  if (normalizedScope.hasScope) {
    where.filterMonth = normalizedScope.filterMonth
    where.filterYear = normalizedScope.filterYear
    where.filterPeriodType = normalizedScope.filterPeriodType
    where.filterCourtType = normalizedScope.filterCourtType
    where.filterBookingType = normalizedScope.filterBookingType
  }

  return where
}

const buildSegmentationTransactionWhere = (scope) => {
  const baseWhere = buildFacilityTransactionWhere({
    startDate: scope.startDate,
    endDate: scope.endDate,
    courtType: scope.filterCourtType,
    bookingType: scope.filterBookingType,
  })

  const rfmEligibleStatuses = [
    {
      equals: "payment completed",
      mode: "insensitive",
    },
    {
      equals: "manual/walk-in",
      mode: "insensitive",
    },
  ]

  if (baseWhere.playDate) {
    baseWhere.playDate = {
      ...baseWhere.playDate,
      not: null,
    }
  } else {
    baseWhere.playDate = {
      not: null,
    }
  }

  baseWhere.AND = [
    ...(Array.isArray(baseWhere.AND) ? baseWhere.AND : []),
    {
      validBooking: true,
    },
    {
      netRevenue: {
        gt: 0,
      },
    },
    {
      OR: rfmEligibleStatuses.map((status) => ({
        status,
      })),
    },
  ]

  if (baseWhere.bookingEventKey) {
    baseWhere.bookingEventKey = {
      not: "",
    }
  }

  return baseWhere
}

const getCustomerDisplayName = (transaction) =>
  transaction.customerName ||
  transaction.nama ||
  transaction.normalizedName ||
  transaction.customerKey

const determineDominantBookingType = (bookingTypeEventMap) => {
  if (!bookingTypeEventMap.size) {
    return BOOKING_TYPE_DISPLAY_MAP.other
  }

  const bookingTypeCounters = new Map()

  bookingTypeEventMap.forEach((bookingType) => {
    bookingTypeCounters.set(bookingType, (bookingTypeCounters.get(bookingType) || 0) + 1)
  })

  const sortedBookingTypes = [...bookingTypeCounters.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1]
    }

    return left[0].localeCompare(right[0])
  })

  const [topBookingType, topCount] = sortedBookingTypes[0]
  const secondCount = sortedBookingTypes[1]?.[1] || 0

  if (sortedBookingTypes.length > 1 && topCount === secondCount) {
    return MIXED_BOOKING_TYPE_LABEL
  }

  return mapBookingTypeToDisplayLabel(topBookingType)
}

const aggregateCustomerMetrics = (transactions, analysisDate) => {
  const customerMap = new Map()

  for (const transaction of transactions) {
    if (!transaction.customerKey || !transaction.playDate || !transaction.bookingEventKey) {
      continue
    }

    if (toNumber(transaction.netRevenue) <= 0) {
      continue
    }

    const existingCustomer = customerMap.get(transaction.customerKey) || {
      customerKey: transaction.customerKey,
      customerName: getCustomerDisplayName(transaction),
      latestPlayDate: null,
      bookingEventKeys: new Set(),
      bookingTypeEventMap: new Map(),
      monetary: 0,
    }

    const playDate = new Date(transaction.playDate)

    if (!existingCustomer.latestPlayDate || playDate > existingCustomer.latestPlayDate) {
      existingCustomer.latestPlayDate = playDate
    }

    existingCustomer.bookingEventKeys.add(transaction.bookingEventKey)
    existingCustomer.monetary += toNumber(transaction.netRevenue)

    if (!existingCustomer.bookingTypeEventMap.has(transaction.bookingEventKey)) {
      existingCustomer.bookingTypeEventMap.set(
        transaction.bookingEventKey,
        transaction.bookingType || "other"
      )
    }

    customerMap.set(transaction.customerKey, existingCustomer)
  }

  const safeAnalysisDate = startOfDay(analysisDate)

  return [...customerMap.values()]
    .map((customer) => {
      const latestPlayDate = startOfDay(customer.latestPlayDate)
      const recency = Math.max(
        0,
        Math.round((safeAnalysisDate.getTime() - latestPlayDate.getTime()) / 86400000)
      )

      return {
        customerKey: customer.customerKey,
        customerName: customer.customerName,
        bookingTypeDominant: determineDominantBookingType(customer.bookingTypeEventMap),
        recency,
        frequency: customer.bookingEventKeys.size,
        monetary: roundNumber(customer.monetary),
        rScore: 0,
        fScore: 0,
        mScore: 0,
        clusterId: -1,
        segmentName: "",
      }
    })
    .sort((left, right) => left.customerKey.localeCompare(right.customerKey))
}

const getQuantileThresholds = (values) => {
  if (!values.length) return null

  const sortedValues = [...values].sort((left, right) => left - right)
  const minimum = sortedValues[0]
  const maximum = sortedValues[sortedValues.length - 1]

  if (minimum === maximum) return null

  const getThreshold = (fraction) =>
    sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1)]

  return [0.2, 0.4, 0.6, 0.8].map(getThreshold)
}

const scoreMetric = (value, thresholds, higherIsBetter) => {
  if (!thresholds) return 3

  const bucket =
    value <= thresholds[0]
      ? 1
      : value <= thresholds[1]
        ? 2
        : value <= thresholds[2]
          ? 3
          : value <= thresholds[3]
            ? 4
            : 5

  return higherIsBetter ? bucket : 6 - bucket
}

const assignRfmScores = (customers) => {
  const recencyThresholds = getQuantileThresholds(customers.map((customer) => customer.recency))
  const frequencyThresholds = getQuantileThresholds(
    customers.map((customer) => customer.frequency)
  )
  const monetaryThresholds = getQuantileThresholds(
    customers.map((customer) => customer.monetary)
  )

  customers.forEach((customer) => {
    customer.rScore = scoreMetric(customer.recency, recencyThresholds, false)
    customer.fScore = scoreMetric(customer.frequency, frequencyThresholds, true)
    customer.mScore = scoreMetric(customer.monetary, monetaryThresholds, true)
  })

  return customers
}

const zScoreScale = (customers) => {
  const featureKeys = ["recency", "frequency", "monetary"]
  const means = {}
  const standardDeviations = {}

  featureKeys.forEach((featureKey) => {
    const values = customers.map((customer) => customer[featureKey])
    const mean = values.reduce((total, value) => total + value, 0) / (values.length || 1)
    const variance =
      values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length || 1)
    const standardDeviation = Math.sqrt(variance)

    means[featureKey] = mean
    standardDeviations[featureKey] = standardDeviation
  })

  return customers.map((customer) => ({
    customer,
    features: featureKeys.map((featureKey) => {
      const standardDeviation = standardDeviations[featureKey]
      if (!standardDeviation) return 0
      return (customer[featureKey] - means[featureKey]) / standardDeviation
    }),
  }))
}

const euclideanDistance = (leftVector, rightVector) =>
  Math.sqrt(
    leftVector.reduce((total, value, index) => total + (value - rightVector[index]) ** 2, 0)
  )

const initializeCentroids = (points, kValue) => {
  const sortedPoints = [...points].sort((left, right) => {
    const leftSum = left.features.reduce((total, value) => total + value, 0)
    const rightSum = right.features.reduce((total, value) => total + value, 0)

    if (leftSum !== rightSum) return leftSum - rightSum
    if (left.customer.recency !== right.customer.recency) {
      return left.customer.recency - right.customer.recency
    }
    if (left.customer.frequency !== right.customer.frequency) {
      return right.customer.frequency - left.customer.frequency
    }
    if (left.customer.monetary !== right.customer.monetary) {
      return right.customer.monetary - left.customer.monetary
    }

    return left.customer.customerKey.localeCompare(right.customer.customerKey)
  })

  const centroids = []

  for (let index = 0; index < kValue; index += 1) {
    const pointIndex =
      kValue === 1
        ? 0
        : Math.round((index * (sortedPoints.length - 1)) / (kValue - 1))
    centroids.push([...sortedPoints[pointIndex].features])
  }

  return centroids
}

const assignPointToCluster = (point, centroids) => {
  let selectedClusterId = 0
  let shortestDistance = Number.POSITIVE_INFINITY

  centroids.forEach((centroid, centroidIndex) => {
    const distance = euclideanDistance(point.features, centroid)

    if (distance < shortestDistance) {
      shortestDistance = distance
      selectedClusterId = centroidIndex
    }
  })

  return selectedClusterId
}

const calculateCentroid = (clusterPoints, fallbackCentroid) => {
  if (!clusterPoints.length) return [...fallbackCentroid]

  const dimensions = clusterPoints[0].features.length
  const nextCentroid = Array.from({ length: dimensions }, () => 0)

  clusterPoints.forEach((point) => {
    point.features.forEach((value, index) => {
      nextCentroid[index] += value
    })
  })

  return nextCentroid.map((value) => value / clusterPoints.length)
}

const calculateInertia = (points, assignments, centroids) =>
  roundNumber(
    points.reduce((total, point, pointIndex) => {
      const centroid = centroids[assignments[pointIndex]]
      const distance = euclideanDistance(point.features, centroid)
      return total + distance ** 2
    }, 0),
    4
  )

const runDeterministicKMeans = (points, requestedKValue = DEFAULT_K) => {
  if (!points.length) {
    return {
      kValue: 0,
      assignments: [],
      centroids: [],
      inertia: 0,
    }
  }

  const kValue = Math.max(1, Math.min(requestedKValue, points.length))
  let centroids = initializeCentroids(points, kValue)
  let assignments = new Array(points.length).fill(-1)

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const nextAssignments = points.map((point) => assignPointToCluster(point, centroids))
    const hasAssignmentChanged = nextAssignments.some(
      (clusterId, index) => clusterId !== assignments[index]
    )

    const nextCentroids = centroids.map((centroid, centroidIndex) =>
      calculateCentroid(
        points.filter((point, pointIndex) => nextAssignments[pointIndex] === centroidIndex),
        centroid
      )
    )

    const totalCentroidShift = nextCentroids.reduce(
      (total, centroid, centroidIndex) =>
        total + euclideanDistance(centroid, centroids[centroidIndex]),
      0
    )

    assignments = nextAssignments
    centroids = nextCentroids

    if (!hasAssignmentChanged || totalCentroidShift < 1e-6) {
      break
    }
  }

  return {
    kValue,
    assignments,
    centroids,
    inertia: calculateInertia(points, assignments, centroids),
  }
}

const calculateSilhouetteScore = (points, assignments, kValue) => {
  if (points.length < 2 || kValue < 2) return null

  const clusterMembers = Array.from({ length: kValue }, () => [])
  assignments.forEach((clusterId, pointIndex) => {
    clusterMembers[clusterId].push(pointIndex)
  })

  const silhouetteScores = points.map((point, pointIndex) => {
    const clusterId = assignments[pointIndex]
    const sameClusterMembers = clusterMembers[clusterId]

    if (sameClusterMembers.length <= 1) return 0

    const averageIntraClusterDistance =
      sameClusterMembers
        .filter((memberIndex) => memberIndex !== pointIndex)
        .reduce(
          (total, memberIndex) =>
            total + euclideanDistance(point.features, points[memberIndex].features),
          0
        ) /
      (sameClusterMembers.length - 1)

    let nearestClusterDistance = Number.POSITIVE_INFINITY

    clusterMembers.forEach((members, memberClusterId) => {
      if (memberClusterId === clusterId || !members.length) return

      const interClusterDistance =
        members.reduce(
          (total, memberIndex) =>
            total + euclideanDistance(point.features, points[memberIndex].features),
          0
        ) / members.length

      if (interClusterDistance < nearestClusterDistance) {
        nearestClusterDistance = interClusterDistance
      }
    })

    if (!Number.isFinite(nearestClusterDistance)) return 0

    const denominator = Math.max(averageIntraClusterDistance, nearestClusterDistance)
    if (denominator === 0) return 0

    return (nearestClusterDistance - averageIntraClusterDistance) / denominator
  })

  return roundNumber(
    silhouetteScores.reduce((total, value) => total + value, 0) / silhouetteScores.length,
    4
  )
}

/*
  The system evaluates multiple K values using Silhouette Score and Elbow Method as
  validation evidence. However, the production segmentation uses fixed K=4 because it
  provides a balance between business actionability and Marketing Operational efficiency.
  K=2 produces stronger mathematical separation but is too broad for campaign planning,
  while K=5 provides more detail but requires higher operational effort. Therefore,
  K=4 is selected as the business-facing segmentation structure.
*/
const detectElbowK = (evaluationMetrics) => {
  if (evaluationMetrics.length < 3) return null

  const firstPoint = evaluationMetrics[0]
  const lastPoint = evaluationMetrics[evaluationMetrics.length - 1]
  const deltaK = lastPoint.k - firstPoint.k
  const deltaInertia = lastPoint.inertia - firstPoint.inertia
  const denominator = Math.sqrt(deltaK ** 2 + deltaInertia ** 2)

  if (denominator === 0) return null

  let elbowCandidate = null
  let largestDistance = Number.NEGATIVE_INFINITY

  evaluationMetrics.slice(1, -1).forEach((metric) => {
    const distance =
      Math.abs(
        deltaInertia * metric.k -
          deltaK * metric.inertia +
          lastPoint.k * firstPoint.inertia -
          lastPoint.inertia * firstPoint.k
      ) / denominator

    if (distance > largestDistance) {
      largestDistance = distance
      elbowCandidate = metric.k
    }
  })

  return elbowCandidate
}

const evaluateKCandidates = (points, options) => {
  if (points.length < 2) {
    return {
      testedK: [],
      elbowK: null,
      optimalK: Math.min(points.length, 1),
      bestSilhouetteK: null,
      selectedResultByK: new Map(),
    }
  }

  const evaluationCandidates = new Set()
  const upperK = Math.min(options.maxK, points.length)

  for (let kValue = options.minK; kValue <= upperK; kValue += 1) {
    evaluationCandidates.add(kValue)
  }

  if (options.includeKValues?.length) {
    options.includeKValues.forEach((kValue) => {
      if (kValue >= 2 && kValue <= points.length) {
        evaluationCandidates.add(kValue)
      }
    })
  }

  const sortedCandidates = [...evaluationCandidates].sort((left, right) => left - right)
  const selectedResultByK = new Map()

  const testedK = sortedCandidates.map((kValue) => {
    const kMeansResult = runDeterministicKMeans(points, kValue)
    const silhouetteScore = calculateSilhouetteScore(
      points,
      kMeansResult.assignments,
      kMeansResult.kValue
    )

    const evaluationMetric = {
      k: kMeansResult.kValue,
      inertia: kMeansResult.inertia,
      silhouetteScore,
    }

    selectedResultByK.set(kMeansResult.kValue, {
      ...kMeansResult,
      silhouetteScore,
    })

    return evaluationMetric
  })

  const bestSilhouetteMetric =
    [...testedK]
      .filter((metric) => metric.silhouetteScore !== null)
      .sort((left, right) => {
        if (right.silhouetteScore !== left.silhouetteScore) {
          return right.silhouetteScore - left.silhouetteScore
        }

        return left.k - right.k
      })[0] || null

  const elbowK = detectElbowK(testedK)
  const optimalK =
    bestSilhouetteMetric && elbowK && Math.abs(bestSilhouetteMetric.k - elbowK) <= 1
      ? Math.min(bestSilhouetteMetric.k, elbowK)
      : bestSilhouetteMetric?.k || elbowK || Math.min(DEFAULT_K, points.length)

  return {
    testedK,
    elbowK,
    optimalK,
    bestSilhouetteK: bestSilhouetteMetric?.k || null,
    selectedResultByK,
  }
}

const selectKValue = ({ customerCount, evaluation, selectionOptions }) => {
  if (customerCount === 0) {
    return {
      selectedK: 0,
      optimalK: 0,
      selectionReason:
        "No valid customers were found in the selected scope, so clustering was not run.",
    }
  }

  if (customerCount === 1) {
    return {
      selectedK: 1,
      optimalK: 1,
      selectionReason:
        "Only one customer was available in the selected scope, so the clustering result uses a single group.",
    }
  }

  const productionK = Math.min(DEFAULT_K, customerCount)
  const optimalK = evaluation.optimalK || productionK

  if (productionK !== DEFAULT_K) {
    return {
      selectedK: productionK,
      optimalK,
      selectionReason:
        `K=${DEFAULT_K} is the fixed business-facing segmentation because it balances customer behavior detail and Marketing Operational efficiency. ` +
        `This run used k=${productionK} only because fewer than ${DEFAULT_K} customers were available. ` +
        `K evaluation metrics are stored as validation evidence only and do not automatically change the production K.`,
    }
  }

  if (selectionOptions.manualK) {
    return {
      selectedK: productionK,
      optimalK,
      selectionReason:
        `Manual k=${selectionOptions.manualK} was ignored because K=${DEFAULT_K} is the fixed business-facing segmentation for business consistency and Marketing Operational efficiency. ` +
        `K evaluation metrics are stored as validation evidence only and do not automatically change the production K.`,
    }
  }

  if (selectionOptions.autoKRequested) {
    return {
      selectedK: productionK,
      optimalK,
      selectionReason:
        `Auto-K is disabled for production selection. K=${DEFAULT_K} is used as the fixed business-facing segmentation because it balances customer behavior detail and Marketing Operational efficiency. ` +
        `K evaluation metrics are stored as validation evidence only and do not automatically change the production K.`,
    }
  }

  if (selectionOptions.analystMode) {
    return {
      selectedK: productionK,
      optimalK,
      selectionReason:
        `K=${DEFAULT_K} is used as the fixed business-facing segmentation because it balances customer behavior detail and Marketing Operational efficiency. ` +
        `Analyst-only request flags do not override the production K, and K evaluation metrics are stored as validation evidence only.`,
    }
  }

  return {
    selectedK: productionK,
    optimalK,
    selectionReason:
      `K=${DEFAULT_K} is used as the fixed business-facing segmentation because it balances customer behavior detail and Marketing Operational efficiency. ` +
      `K evaluation metrics are stored as validation evidence only and do not automatically change the production K.`,
  }
}

const buildKEvaluationPayload = ({ evaluation, selectedK, selectionReason }) => ({
  testedK: evaluation.testedK.map((metric) => ({
    k: metric.k,
    inertia: metric.inertia,
    silhouetteScore: metric.silhouetteScore,
  })),
  elbowK: evaluation.elbowK,
  optimalK: evaluation.optimalK,
  bestSilhouetteK: evaluation.bestSilhouetteK,
  selectedK,
  selectionReason,
})

const buildClusterProfiles = (customers) => {
  const clusters = new Map()

  customers.forEach((customer) => {
    const profile = clusters.get(customer.clusterId) || {
      clusterId: customer.clusterId,
      customerCount: 0,
      totalRecency: 0,
      totalFrequency: 0,
      totalMonetary: 0,
      totalRScore: 0,
      totalFScore: 0,
      totalMScore: 0,
    }

    profile.customerCount += 1
    profile.totalRecency += customer.recency
    profile.totalFrequency += customer.frequency
    profile.totalMonetary += customer.monetary
    profile.totalRScore += customer.rScore
    profile.totalFScore += customer.fScore
    profile.totalMScore += customer.mScore

    clusters.set(customer.clusterId, profile)
  })

  const sortedProfiles = [...clusters.values()]
    .map((profile) => ({
      clusterId: profile.clusterId,
      customerCount: profile.customerCount,
      avgRecency: roundNumber(profile.totalRecency / profile.customerCount),
      avgFrequency: roundNumber(profile.totalFrequency / profile.customerCount),
      avgMonetary: roundNumber(profile.totalMonetary / profile.customerCount),
      avgRScore: roundNumber(profile.totalRScore / profile.customerCount, 4),
      avgFScore: roundNumber(profile.totalFScore / profile.customerCount, 4),
      avgMScore: roundNumber(profile.totalMScore / profile.customerCount, 4),
      combinedScore: roundNumber(
        (profile.totalRScore + profile.totalFScore + profile.totalMScore) / profile.customerCount,
        4
      ),
    }))
    .sort((left, right) => {
      if (right.combinedScore !== left.combinedScore) {
        return right.combinedScore - left.combinedScore
      }
      if (left.avgRecency !== right.avgRecency) {
        return left.avgRecency - right.avgRecency
      }
      if (left.avgFrequency !== right.avgFrequency) {
        return right.avgFrequency - left.avgFrequency
      }
      if (left.avgMonetary !== right.avgMonetary) {
        return right.avgMonetary - left.avgMonetary
      }
      return left.clusterId - right.clusterId
    })

  const clusterIdRemap = new Map(
    sortedProfiles.map((profile, index) => [profile.clusterId, index])
  )

  customers.forEach((customer) => {
    customer.clusterId = clusterIdRemap.get(customer.clusterId)
  })

  return sortedProfiles.map((profile) => ({
    ...profile,
    clusterId: clusterIdRemap.get(profile.clusterId),
  }))
}

const getRangeMatchScore = (value, minimum, maximum, weight) => {
  if (value >= minimum && value <= maximum) {
    return weight * 2
  }

  const distance = value < minimum ? minimum - value : value - maximum
  return weight * 2 - distance * weight * 2
}

const scorePrimePlayers = (profile) =>
  getRangeMatchScore(profile.avgRScore, 4, 5, 3) +
  getRangeMatchScore(profile.avgFScore, 4, 5, 3) +
  getRangeMatchScore(profile.avgMScore, 4, 5, 3)

const scoreRoutinePlayers = (profile) =>
  getRangeMatchScore(profile.avgRScore, 3, 5, 2.5) +
  getRangeMatchScore(profile.avgFScore, 4, 5, 3) +
  getRangeMatchScore(profile.avgMScore, 3, 5, 2)

const scoreGrowthPlayers = (profile) =>
  getRangeMatchScore(profile.avgRScore, 4, 5, 3) +
  getRangeMatchScore(profile.avgFScore, 1, 3.5, 2.5) +
  getRangeMatchScore(profile.avgMScore, 1, 3.5, 2)

const scoreReEngagementPlayers = (profile) =>
  getRangeMatchScore(profile.avgRScore, 1, 2.5, 3) +
  getRangeMatchScore(profile.avgFScore, 1, 3.5, 2.25) +
  getRangeMatchScore(profile.avgMScore, 1, 3.5, 2.25) +
  Math.max(0, profile.avgRecency - 14) * 0.02

const getSegmentMatchScore = (profile, baseName) => {
  switch (baseName) {
    case "Prime Players":
      return scorePrimePlayers(profile)
    case "Routine Players":
      return scoreRoutinePlayers(profile)
    case "Growth Players":
      return scoreGrowthPlayers(profile)
    case "Re-Engagement Players":
      return scoreReEngagementPlayers(profile)
    default:
      return Number.NEGATIVE_INFINITY
  }
}

const buildPermutationAssignments = (definitions, targetLength) => {
  if (targetLength === 0) return [[]]

  const assignments = []

  definitions.forEach((definition, index) => {
    const remainingDefinitions = [...definitions.slice(0, index), ...definitions.slice(index + 1)]
    const childAssignments = buildPermutationAssignments(remainingDefinitions, targetLength - 1)

    childAssignments.forEach((childAssignment) => {
      assignments.push([definition, ...childAssignment])
    })
  })

  return assignments
}

const buildLabelReason = (profile, definition, segmentName) => {
  const scoreSummary = `Average R/F/M scores are ${profile.avgRScore.toFixed(2)}/${profile.avgFScore.toFixed(2)}/${profile.avgMScore.toFixed(2)}`
  const metricSummary = `with average recency ${profile.avgRecency} days, frequency ${profile.avgFrequency}, and monetary ${profile.avgMonetary}`

  switch (definition.baseName) {
    case "Prime Players":
      return `${scoreSummary}, indicating high recency, high frequency, and high monetary value ${metricSummary}. This cluster represents the highest-value customers and is a retention priority. ${definition.recommendedAction}`
    case "Routine Players":
      return `${scoreSummary}, showing strong booking frequency with stable medium-to-high value ${metricSummary}. This cluster contributes stable revenue and is a maintenance or upgrade opportunity. ${definition.recommendedAction}`
    case "Growth Players":
      return `${scoreSummary}, showing recent or relatively active behavior but still lower frequency and monetary value ${metricSummary}. This cluster has growth potential through repeat-booking and value expansion campaigns. ${definition.recommendedAction}`
    case "Re-Engagement Players":
      return `${scoreSummary}, showing low recency score or high absolute recency ${metricSummary}. This cluster has lower recent activity and is best handled through an efficient re-engagement approach, whether the customers are historically valuable or generally low activity. ${definition.recommendedAction}`
    default:
      return `${segmentName} was assigned based on the cluster's RFM profile ${metricSummary}.`
  }
}

/*
  Segment names are not arbitrary and are never assigned directly from clusterId.
  Each cluster is profiled first with normalized R/F/M scores plus absolute recency,
  then matched to the most appropriate business segment based on customer behavior.
  Each segment name is tied to a business action, and kEvaluation is stored only as
  validation evidence. selectedK is the production K, while bestSilhouetteK/optimalK
  remain analytical evidence rather than the business-facing segment count.
*/
const assignSegmentLabels = (clusterProfiles) => {
  if (!clusterProfiles.length) return new Map()

  const candidateAssignments = buildPermutationAssignments(
    SEGMENT_DEFINITIONS,
    clusterProfiles.length
  )

  let selectedAssignment = candidateAssignments[0]
  let highestTotalScore = Number.NEGATIVE_INFINITY

  candidateAssignments.forEach((candidateAssignment) => {
    const totalScore = candidateAssignment.reduce(
      (total, definition, index) =>
        total + getSegmentMatchScore(clusterProfiles[index], definition.baseName),
      0
    )

    if (totalScore > highestTotalScore) {
      highestTotalScore = totalScore
      selectedAssignment = candidateAssignment
    }
  })

  return new Map(
    clusterProfiles.map((profile, index) => {
      const definition = selectedAssignment[index]
      return [
        profile.clusterId,
        {
          segmentName: definition.baseName,
          segmentDescription: definition.description,
          recommendedAction: definition.recommendedAction,
          labelReason: buildLabelReason(profile, definition, definition.baseName),
          matchScore: getSegmentMatchScore(profile, definition.baseName),
        },
      ]
    })
  )
}

const serializeRun = (run) => {
  if (!run) return null

  const kEvaluation = run.kEvaluation ?? null

  return {
    id: run.id,
    runDate: run.runDate,
    method: run.method,
    kValue: run.kValue,
    selectedK: run.kValue,
    optimalK: kEvaluation?.optimalK ?? null,
    bestSilhouetteK: kEvaluation?.bestSilhouetteK ?? null,
    elbowK: kEvaluation?.elbowK ?? null,
    totalCustomers: run.totalCustomers,
    filterMonth: run.filterMonth,
    filterYear: run.filterYear,
    filterPeriodType: run.filterPeriodType,
    filterCourtType: run.filterCourtType,
    filterBookingType: run.filterBookingType,
    status: run.status,
    errorMessage: run.errorMessage,
    silhouetteScore: run.silhouetteScore,
    kEvaluation,
    selectionReason: kEvaluation?.selectionReason ?? null,
  }
}

const serializeClusterProfile = (profile) => ({
  clusterId: profile.clusterId,
  segmentName: profile.segmentName,
  segmentDescription: profile.segmentDescription,
  labelReason: profile.labelReason,
  recommendedAction:
    SEGMENT_DEFINITION_BY_NAME.get(profile.segmentName?.split(" - ")[0])?.recommendedAction || null,
  customerCount: profile.customerCount,
  avgRecency: roundNumber(toNumber(profile.avgRecency)),
  avgFrequency: roundNumber(toNumber(profile.avgFrequency)),
  avgMonetary: roundNumber(toNumber(profile.avgMonetary)),
  avgRScore: roundNumber(toNumber(profile.avgRScore)),
  avgFScore: roundNumber(toNumber(profile.avgFScore)),
  avgMScore: roundNumber(toNumber(profile.avgMScore)),
})

const serializeCustomerScore = (customerScore) => ({
  customerKey: customerScore.customerKey,
  customerName: customerScore.customerName,
  bookingTypeDominant: customerScore.bookingTypeDominant,
  recency: customerScore.recency,
  frequency: customerScore.frequency,
  monetary: roundNumber(toNumber(customerScore.monetary)),
  rScore: customerScore.rScore,
  fScore: customerScore.fScore,
  mScore: customerScore.mScore,
  clusterId: customerScore.clusterId,
  segmentName: customerScore.segmentName,
})

const buildPaginationPayload = ({ totalCustomers, limit, offset, returned }) => ({
  limit,
  offset,
  returned,
  totalCustomers,
  hasMore: offset + returned < totalCustomers,
})

const buildCustomerScoreWhere = ({ runId, segmentName }) => {
  const where = {
    runId,
  }

  if (hasValue(segmentName)) {
    where.segmentName = segmentName
  }

  return where
}

const fetchCustomerScoresPage = async ({ runId, segmentName = null, limit, offset }) => {
  const where = buildCustomerScoreWhere({
    runId,
    segmentName,
  })

  const [totalCustomers, customerScores] = await prisma.$transaction([
    prisma.customerRfmScore.count({ where }),
    prisma.customerRfmScore.findMany({
      where,
      orderBy: [{ clusterId: "asc" }, { monetary: "desc" }, { customerKey: "asc" }],
      skip: offset,
      take: limit,
    }),
  ])

  return {
    customers: customerScores.map(serializeCustomerScore),
    totalCustomers,
    pagination: buildPaginationPayload({
      totalCustomers,
      limit,
      offset,
      returned: customerScores.length,
    }),
  }
}

const buildRunResultPayload = (run, clusterProfiles = [], customerResult = null) => {
  const serializedRun = serializeRun(run)
  const clusters = clusterProfiles.map(serializeClusterProfile)

  return {
    run: serializedRun,
    selectedK: serializedRun?.selectedK ?? null,
    optimalK: serializedRun?.optimalK ?? null,
    bestSilhouetteK: serializedRun?.bestSilhouetteK ?? null,
    elbowK: serializedRun?.elbowK ?? null,
    silhouetteScore: serializedRun?.silhouetteScore ?? null,
    kEvaluation: serializedRun?.kEvaluation ?? null,
    selectionReason: serializedRun?.selectionReason ?? null,
    clusters,
    summary: clusters,
    customers: customerResult?.customers || [],
    totalCustomers: customerResult?.totalCustomers ?? serializedRun?.totalCustomers ?? 0,
    pagination: customerResult?.pagination || null,
  }
}

const fetchPreviousSegmentationRun = async (currentRunId) => {
  if (!currentRunId) return null

  return prisma.segmentationRun.findFirst({
    where: {
      id: {
        lt: currentRunId,
      },
    },
    orderBy: {
      runDate: "desc",
    },
    select: {
      id: true,
      runDate: true,
      totalCustomers: true,
      kValue: true,
      status: true,
    },
  })
}

const getRunInclude = () => ({
  clusterProfiles: {
    orderBy: {
      clusterId: "asc",
    },
  },
})

const buildStoredRunWhere = ({ runId, filters } = {}) => {
  if (runId) {
    return {
      id: Number(runId),
    }
  }

  return buildSegmentationRunWhere(filters)
}

const buildSelectedClusteringResult = ({ selectedK, evaluation, points }) => {
  if (selectedK <= 0) {
    return {
      kValue: 0,
      assignments: [],
      centroids: [],
      inertia: 0,
      silhouetteScore: null,
    }
  }

  if (selectedK === 1) {
    return {
      ...runDeterministicKMeans(points, 1),
      silhouetteScore: null,
    }
  }

  if (evaluation.selectedResultByK.has(selectedK)) {
    return evaluation.selectedResultByK.get(selectedK)
  }

  const clusteringResult = runDeterministicKMeans(points, selectedK)
  return {
    ...clusteringResult,
    silhouetteScore: calculateSilhouetteScore(
      points,
      clusteringResult.assignments,
      clusteringResult.kValue
    ),
  }
}

export const runRfmSegmentation = async (input = {}) => {
  const scope = normalizeSegmentationScope(input)
  const selectionOptions = normalizeKSelectionOptions(input)

  const segmentationRun = await prisma.segmentationRun.create({
    data: {
      runDate: new Date(),
      method: SEGMENTATION_METHOD,
      kValue: 0,
      totalCustomers: 0,
      filterMonth: scope.filterMonth,
      filterYear: scope.filterYear,
      filterPeriodType: scope.filterPeriodType,
      filterCourtType: scope.filterCourtType,
      filterBookingType: scope.filterBookingType,
      status: RUNNING_STATUS,
    },
  })

  try {
    let customers = []
    let clusterProfiles = []
    let silhouetteScore = null
    let selectedK = 0
    let kEvaluation = {
      testedK: [],
      elbowK: null,
      optimalK: 0,
      bestSilhouetteK: null,
      selectedK: 0,
      selectionReason:
        "No valid customers were found in the selected scope, so clustering was not run.",
    }

    if (!scope.isEmptyDateScope) {
      const transactions = await prisma.facilityTransaction.findMany({
        where: buildSegmentationTransactionWhere(scope),
        orderBy: [{ customerKey: "asc" }, { playDate: "asc" }, { bookingEventKey: "asc" }],
        select: {
          customerKey: true,
          customerName: true,
          normalizedName: true,
          nama: true,
          bookingType: true,
          playDate: true,
          bookingEventKey: true,
          netRevenue: true,
        },
      })

      customers = assignRfmScores(aggregateCustomerMetrics(transactions, scope.analysisDate))

      if (customers.length) {
        const scaledPoints = zScoreScale(customers)
        const evaluation = evaluateKCandidates(scaledPoints, {
          minK: selectionOptions.minK,
          maxK: selectionOptions.maxK,
          includeKValues: [selectionOptions.manualK, DEFAULT_K].filter(Boolean),
        })

        const selection = selectKValue({
          customerCount: customers.length,
          evaluation,
          selectionOptions,
        })

        selectedK = selection.selectedK
        kEvaluation = buildKEvaluationPayload({
          evaluation,
          selectedK,
          selectionReason: selection.selectionReason,
        })

        const selectedClusteringResult = buildSelectedClusteringResult({
          selectedK,
          evaluation,
          points: scaledPoints,
        })

        silhouetteScore = selectedClusteringResult.silhouetteScore

        selectedClusteringResult.assignments.forEach((clusterId, index) => {
          customers[index].clusterId = clusterId
        })

        clusterProfiles = buildClusterProfiles(customers)

        const labelByClusterId = assignSegmentLabels(clusterProfiles)

        customers.forEach((customer) => {
          customer.segmentName =
            labelByClusterId.get(customer.clusterId)?.segmentName || "Growth Players"
        })

        clusterProfiles = clusterProfiles.map((profile) => {
          const labelInfo = labelByClusterId.get(profile.clusterId)

          return {
            clusterId: profile.clusterId,
            segmentName: labelInfo?.segmentName || "Growth Players",
            segmentDescription:
              labelInfo?.segmentDescription ||
              SEGMENT_DEFINITION_BY_NAME.get("Growth Players").description,
            labelReason:
              labelInfo?.labelReason ||
              "This cluster was mapped to Growth Players based on its normalized RFM profile.",
            customerCount: profile.customerCount,
            avgRecency: profile.avgRecency,
            avgFrequency: profile.avgFrequency,
            avgMonetary: profile.avgMonetary,
            avgRScore: profile.avgRScore,
            avgFScore: profile.avgFScore,
            avgMScore: profile.avgMScore,
          }
        })
      }
    }

    await prisma.$transaction(async (transactionClient) => {
      if (customers.length) {
        await transactionClient.customerRfmScore.createMany({
          data: customers.map((customer) => ({
            runId: segmentationRun.id,
            customerKey: customer.customerKey,
            customerName: customer.customerName,
            bookingTypeDominant: customer.bookingTypeDominant,
            recency: customer.recency,
            frequency: customer.frequency,
            monetary: customer.monetary,
            rScore: customer.rScore,
            fScore: customer.fScore,
            mScore: customer.mScore,
            clusterId: customer.clusterId,
            segmentName: customer.segmentName,
          })),
        })
      }

      if (clusterProfiles.length) {
        await transactionClient.clusterProfile.createMany({
          data: clusterProfiles.map((profile) => ({
            runId: segmentationRun.id,
            clusterId: profile.clusterId,
            segmentName: profile.segmentName,
            segmentDescription: profile.segmentDescription,
            labelReason: profile.labelReason,
            customerCount: profile.customerCount,
            avgRecency: profile.avgRecency,
            avgFrequency: profile.avgFrequency,
            avgMonetary: profile.avgMonetary,
            avgRScore: profile.avgRScore,
            avgFScore: profile.avgFScore,
            avgMScore: profile.avgMScore,
          })),
        })
      }

      await transactionClient.segmentationRun.update({
        where: {
          id: segmentationRun.id,
        },
        data: {
          status: COMPLETED_STATUS,
          kValue: selectedK,
          totalCustomers: customers.length,
          silhouetteScore,
          kEvaluation,
          errorMessage: null,
        },
      })
    })

    const completedRun = await prisma.segmentationRun.findUnique({
      where: {
        id: segmentationRun.id,
      },
      include: getRunInclude(),
    })

    return buildRunResultPayload(completedRun, completedRun?.clusterProfiles || [], null)
  } catch (error) {
    await prisma.segmentationRun.update({
      where: {
        id: segmentationRun.id,
      },
      data: {
        status: FAILED_STATUS,
        errorMessage: error instanceof Error ? error.message : "Segmentation run failed.",
      },
    })

    throw error
  }
}

export const getLatestSegmentationResult = async (input = {}) => {
  const where = buildStoredRunWhere({
    runId: input.runId,
    filters: input,
  })

  const latestRun = await prisma.segmentationRun.findFirst({
    where: Object.keys(where).length ? where : undefined,
    orderBy: {
      runDate: "desc",
    },
    include: getRunInclude(),
  })

  if (!latestRun) {
    return {
      run: null,
      selectedK: null,
      optimalK: null,
      bestSilhouetteK: null,
      elbowK: null,
      silhouetteScore: null,
      kEvaluation: null,
      selectionReason: null,
      clusters: [],
      summary: [],
      customers: [],
      totalCustomers: 0,
      pagination: input.includeCustomers
        ? buildPaginationPayload({
            totalCustomers: 0,
            limit: input.limit,
            offset: input.offset || 0,
            returned: 0,
          })
        : null,
    }
  }

  const previousRun = await fetchPreviousSegmentationRun(latestRun.id)

  const customerResult = input.includeCustomers
    ? await fetchCustomerScoresPage({
        runId: latestRun.id,
        segmentName: input.segmentName,
        limit: input.limit,
        offset: input.offset || 0,
      })
    : null

  return {
    ...buildRunResultPayload(latestRun, latestRun.clusterProfiles || [], customerResult),
    previousRun,
  }
}

export const getSegmentationSummary = async (input = {}) => {
  const latestResult = await getLatestSegmentationResult(input)

  return {
    run: latestResult.run,
    selectedK: latestResult.selectedK,
    optimalK: latestResult.optimalK,
    bestSilhouetteK: latestResult.bestSilhouetteK,
    elbowK: latestResult.elbowK,
    silhouetteScore: latestResult.silhouetteScore,
    kEvaluation: latestResult.kEvaluation,
    selectionReason: latestResult.selectionReason,
    clusters: latestResult.clusters,
    summary: latestResult.summary,
  }
}

export const getSegmentationCustomers = async (input = {}) => {
  const latestResult = await getLatestSegmentationResult({
    ...input,
    includeCustomers: false,
  })

  if (!latestResult.run?.id) {
    return {
      ...latestResult,
      customers: [],
      totalCustomers: 0,
      pagination: buildPaginationPayload({
        totalCustomers: 0,
        limit: input.limit,
        offset: input.offset || 0,
        returned: 0,
      }),
    }
  }

  const customerResult = await fetchCustomerScoresPage({
    runId: latestResult.run.id,
    segmentName: input.segmentName,
    limit: input.limit,
    offset: input.offset || 0,
  })

  return {
    ...latestResult,
    customers: customerResult.customers,
    totalCustomers: customerResult.totalCustomers,
    pagination: customerResult.pagination,
  }
}


