import { prisma } from "../config/prisma.js"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SESSION_DEFINITIONS = [
  { key: "Pagi", label: "Morning", startHour: 6, endHour: 11, segment: "Morning Player" },
  { key: "Siang", label: "Afternoon", startHour: 12, endHour: 15, segment: "Afternoon Player" },
  { key: "Evening", label: "Evening", startHour: 16, endHour: 18, segment: "Evening Player" },
  { key: "Malam", label: "Night", startHour: 19, endHour: 23, segment: "Night Player" },
]
const SESSION_KEYS = SESSION_DEFINITIONS.map((session) => session.key)
const MAX_KMEANS_ITERATIONS = 100
const DEFAULT_CLUSTER_COUNT = 3

const roundNumber = (value, digits = 6) => Number(Number(value || 0).toFixed(digits))

const normalizeFeatureVectors = (rows, featureKeys) => {
  const means = {}
  const standardDeviations = {}

  featureKeys.forEach((featureKey) => {
    const values = rows.map((row) => Number(row[featureKey] || 0))
    const mean = values.reduce((total, value) => total + value, 0) / (values.length || 1)
    const variance =
      values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length || 1)

    means[featureKey] = mean
    standardDeviations[featureKey] = Math.sqrt(variance)
  })

  return rows.map((row) => ({
    row,
    features: featureKeys.map((featureKey) => {
      const standardDeviation = standardDeviations[featureKey]
      if (!standardDeviation) return 0
      return (Number(row[featureKey] || 0) - means[featureKey]) / standardDeviation
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

    const leftName = String(left.row.customerName || "")
    const rightName = String(right.row.customerName || "")
    return leftName.localeCompare(rightName)
  })

  const centroids = []

  for (let index = 0; index < kValue; index += 1) {
    const pointIndex =
      kValue === 1 ? 0 : Math.round((index * (sortedPoints.length - 1)) / (kValue - 1))
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

const runDeterministicKMeans = (points, requestedKValue = DEFAULT_CLUSTER_COUNT) => {
  if (!points.length) {
    return {
      kValue: 0,
      assignments: [],
      centroids: [],
    }
  }

  const kValue = Math.max(1, Math.min(requestedKValue, points.length))
  let centroids = initializeCentroids(points, kValue)
  let assignments = new Array(points.length).fill(-1)

  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration += 1) {
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
  }
}

const quantile = (sortedValues, target) => {
  if (!sortedValues.length) return 0
  if (sortedValues.length === 1) return sortedValues[0]

  const position = (sortedValues.length - 1) * target
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = sortedValues[lowerIndex]
  const upperValue = sortedValues[upperIndex]

  if (lowerIndex === upperIndex) return lowerValue

  const weight = position - lowerIndex
  return lowerValue + (upperValue - lowerValue) * weight
}

const getActivityLevel = (totalSessions, q75, q95) => {
  if (totalSessions <= q75) return "Low Activity"
  if (totalSessions <= q95) return "Medium Activity"
  return "High Activity"
}

const parseHourValue = (value) => {
  if (value === null || value === undefined) return null

  const text = String(value).trim()
  if (!text) return null

  const [hourText] = text.split(":")
  const parsed = Number(hourText)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return null
  return parsed
}

const resolveSessionDefinitionByHour = (hour) =>
  SESSION_DEFINITIONS.find((session) => hour >= session.startHour && hour <= session.endHour) || null

const getPlaytimeSegment = (summary) => {
  const dominantSession = SESSION_DEFINITIONS.reduce((selected, session) => {
    const key = `avgRatio${session.key}`
    if (!selected) return session
    return Number(summary[key] || 0) > Number(summary[`avgRatio${selected.key}`] || 0)
      ? session
      : selected
  }, null)

  return dominantSession?.segment || "Morning Player"
}

const buildSessionByTime = (transactions) => {
  const counts = new Map()

  transactions.forEach((transaction) => {
    const sessionKey = transaction.sessionKey
    if (!sessionKey) return
    counts.set(sessionKey, (counts.get(sessionKey) || 0) + 1)
  })

  return SESSION_DEFINITIONS.filter((session) => counts.has(session.key)).map((session) => ({
    play_time_group: session.label,
    session_count: counts.get(session.key) || 0,
  }))
}

const buildHeatmapData = (transactions) => {
  const counts = new Map()

  transactions.forEach((transaction) => {
    const playDate = transaction.tanggalMain instanceof Date ? transaction.tanggalMain : null
    const startHour = transaction.startHour ? String(transaction.startHour).trim() : ""
    if (!playDate || !startHour) return

    const dayShort = DAY_LABELS[playDate.getDay()]
    const key = `${dayShort}|${startHour}`
    counts.set(key, (counts.get(key) || 0) + 1)
  })

  return [...counts.entries()]
    .map(([key, sessionCount]) => {
      const [day_short, startHour] = key.split("|")
      return { day_short, startHour, session_count: sessionCount }
    })
    .sort((left, right) => {
      const dayDiff = DAY_LABELS.indexOf(left.day_short) - DAY_LABELS.indexOf(right.day_short)
      if (dayDiff !== 0) return dayDiff
      return left.startHour.localeCompare(right.startHour)
    })
}

const buildTopHourData = (transactions) => {
  const counts = new Map()

  transactions.forEach((transaction) => {
    const startHour = transaction.startHour ? String(transaction.startHour).trim() : ""
    if (!startHour) return
    counts.set(startHour, (counts.get(startHour) || 0) + 1)
  })

  return [...counts.entries()]
    .map(([startHour, sessionCount]) => ({ startHour, session_count: sessionCount }))
    .sort(
      (left, right) =>
        right.session_count - left.session_count || left.startHour.localeCompare(right.startHour)
    )
}

const createZeroedCustomerRow = (customerName) => ({
  customerName,
  sesiPagi: 0,
  sesiSiang: 0,
  sesiEvening: 0,
  sesiMalam: 0,
})

const buildCustomerFeatureRows = (transactions) => {
  const customerMap = new Map()

  transactions.forEach((transaction) => {
    const customerName = String(transaction.nama || "").trim()
    const sessionKey = transaction.sessionKey
    if (!customerName || !SESSION_KEYS.includes(sessionKey)) return

    if (!customerMap.has(customerName)) {
      customerMap.set(customerName, createZeroedCustomerRow(customerName))
    }

    const row = customerMap.get(customerName)
    if (sessionKey === "Pagi") row.sesiPagi += 1
    if (sessionKey === "Siang") row.sesiSiang += 1
    if (sessionKey === "Evening") row.sesiEvening += 1
    if (sessionKey === "Malam") row.sesiMalam += 1
  })

  return [...customerMap.values()]
    .map((row) => {
      const totalSesi = row.sesiPagi + row.sesiSiang + row.sesiEvening + row.sesiMalam
      if (!totalSesi) return null

      return {
        ...row,
        totalSesi,
        ratioPagi: row.sesiPagi / totalSesi,
        ratioSiang: row.sesiSiang / totalSesi,
        ratioEvening: row.sesiEvening / totalSesi,
        ratioMalam: row.sesiMalam / totalSesi,
      }
    })
    .filter(Boolean)
}

export const runPlaytimeClustering = async () => {
  const transactions = await prisma.facilityTransaction.findMany({
    where: {
      status: {
        equals: "payment completed",
        mode: "insensitive",
      },
      startHour: {
        not: null,
      },
      nama: {
        not: null,
      },
      batch: {
        fileName: {
          not: "tmp-upload-sample.csv",
        },
      },
    },
    select: {
      id: true,
      nama: true,
      tanggalMain: true,
      startHour: true,
      status: true,
    },
  })

  const validTransactions = transactions
    .map((transaction) => {
      const hour = parseHourValue(transaction.startHour)
      const sessionDefinition = hour === null ? null : resolveSessionDefinitionByHour(hour)
      return {
        ...transaction,
        parsedHour: hour,
        sessionKey: sessionDefinition?.key || null,
      }
    })
    .filter(
      (transaction) =>
        transaction.tanggalMain &&
        transaction.startHour &&
        transaction.nama &&
        transaction.sessionKey
    )

  if (!validTransactions.length) {
    throw new Error("No valid facility transaction data found for play-time behavior ML.")
  }

  const sessionByTime = buildSessionByTime(validTransactions)
  const heatmapData = buildHeatmapData(validTransactions)
  const topHourData = buildTopHourData(validTransactions)
  const customerFeatureRows = buildCustomerFeatureRows(validTransactions)

  if (!customerFeatureRows.length) {
    throw new Error(
      "No customer play-time behavior rows could be derived from the imported transactions."
    )
  }

  const normalizedPoints = normalizeFeatureVectors(customerFeatureRows, [
    "ratioPagi",
    "ratioSiang",
    "ratioEvening",
    "ratioMalam",
  ])

  const clusteringResult = runDeterministicKMeans(normalizedPoints, DEFAULT_CLUSTER_COUNT)

  const enrichedCustomerRows = customerFeatureRows.map((row, index) => ({
    ...row,
    playtimeCluster: clusteringResult.assignments[index],
  }))

  const clusterMap = new Map()

  enrichedCustomerRows.forEach((row) => {
    const clusterId = row.playtimeCluster
    const summary = clusterMap.get(clusterId) || {
      playtimeCluster: clusterId,
      totalCustomers: 0,
      totalSesiPagi: 0,
      totalSesiSiang: 0,
      totalSesiEvening: 0,
      totalSesiMalam: 0,
      totalSessions: 0,
      totalRatioPagi: 0,
      totalRatioSiang: 0,
      totalRatioEvening: 0,
      totalRatioMalam: 0,
    }

    summary.totalCustomers += 1
    summary.totalSesiPagi += row.sesiPagi
    summary.totalSesiSiang += row.sesiSiang
    summary.totalSesiEvening += row.sesiEvening
    summary.totalSesiMalam += row.sesiMalam
    summary.totalSessions += row.totalSesi
    summary.totalRatioPagi += row.ratioPagi
    summary.totalRatioSiang += row.ratioSiang
    summary.totalRatioEvening += row.ratioEvening
    summary.totalRatioMalam += row.ratioMalam

    clusterMap.set(clusterId, summary)
  })

  const clusterSummaries = [...clusterMap.values()]
    .map((summary) => {
      const totalCustomers = summary.totalCustomers || 1
      const normalizedSummary = {
        playtimeCluster: summary.playtimeCluster,
        totalCustomers: summary.totalCustomers,
        avgRatioPagi: roundNumber(summary.totalRatioPagi / totalCustomers),
        avgRatioSiang: roundNumber(summary.totalRatioSiang / totalCustomers),
        avgRatioEvening: roundNumber(summary.totalRatioEvening / totalCustomers),
        avgRatioMalam: roundNumber(summary.totalRatioMalam / totalCustomers),
        avgSesiPagi: roundNumber(summary.totalSesiPagi / totalCustomers),
        avgSesiSiang: roundNumber(summary.totalSesiSiang / totalCustomers),
        avgSesiEvening: roundNumber(summary.totalSesiEvening / totalCustomers),
        avgSesiMalam: roundNumber(summary.totalSesiMalam / totalCustomers),
        avgTotalSesi: roundNumber(summary.totalSessions / totalCustomers),
      }

      return {
        ...normalizedSummary,
        playtimeSegment: getPlaytimeSegment(normalizedSummary),
      }
    })
    .sort((left, right) => left.playtimeCluster - right.playtimeCluster)

  const segmentByCluster = new Map(
    clusterSummaries.map((summary) => [summary.playtimeCluster, summary.playtimeSegment])
  )

  const sortedTotalSessions = enrichedCustomerRows
    .map((row) => row.totalSesi)
    .sort((left, right) => left - right)
  const q75 = quantile(sortedTotalSessions, 0.75)
  const q95 = quantile(sortedTotalSessions, 0.95)

  const finalCustomerRows = enrichedCustomerRows.map((row) => ({
    ...row,
    playtimeSegment: segmentByCluster.get(row.playtimeCluster) || "Morning Player",
    activityLevel: getActivityLevel(row.totalSesi, q75, q95),
  }))

  const run = await prisma.playtimeMlRun.create({
    data: {
      period: "all",
      algorithm: "Deterministic KMeans (4-session)",
      clusterCount: clusteringResult.kValue,
      totalCustomers: finalCustomerRows.length,
      totalSessions: validTransactions.length,
      status: "completed",
      sessionByTime,
      heatmapData,
      topHourData,
      segmentSummaries: {
        createMany: {
          data: clusterSummaries.map((summary) => ({
            playtimeCluster: summary.playtimeCluster,
            playtimeSegment: summary.playtimeSegment,
            totalCustomers: summary.totalCustomers,
            avgRatioPagi: summary.avgRatioPagi,
            avgRatioSiang: summary.avgRatioSiang,
            avgRatioEvening: summary.avgRatioEvening,
            avgRatioMalam: summary.avgRatioMalam,
            avgSesiPagi: summary.avgSesiPagi,
            avgSesiSiang: summary.avgSesiSiang,
            avgSesiEvening: summary.avgSesiEvening,
            avgSesiMalam: summary.avgSesiMalam,
            avgTotalSesi: summary.avgTotalSesi,
          })),
        },
      },
      customerSegments: {
        createMany: {
          data: finalCustomerRows.map((row) => ({
            customerName: row.customerName,
            sesiPagi: row.sesiPagi,
            sesiSiang: row.sesiSiang,
            sesiEvening: row.sesiEvening,
            sesiMalam: row.sesiMalam,
            totalSesi: row.totalSesi,
            ratioPagi: roundNumber(row.ratioPagi),
            ratioSiang: roundNumber(row.ratioSiang),
            ratioEvening: roundNumber(row.ratioEvening),
            ratioMalam: roundNumber(row.ratioMalam),
            playtimeCluster: row.playtimeCluster,
            playtimeSegment: row.playtimeSegment,
            activityLevel: row.activityLevel,
          })),
        },
      },
    },
  })

  return {
    success: true,
    runId: run.id,
    totalCustomers: finalCustomerRows.length,
    totalSessions: validTransactions.length,
    clusterCount: clusteringResult.kValue,
  }
}

