import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const DEFAULT_K = 5;
const SEGMENT_LABELS = {
  champions: "Champions",
  loyal: "Loyal Customers",
  potential: "Potential Customers",
  atRisk: "At Risk Customers",
  dormant: "Dormant / Low Value",
};

const toNumber = (value) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const scoreByRank = (entries, key, descending = true) => {
  const ordered = [...entries].sort((a, b) => {
    const diff = toNumber(a[key]) - toNumber(b[key]);
    return descending ? -diff || a.customerId - b.customerId : diff || a.customerId - b.customerId;
  });
  const n = ordered.length;
  const scores = new Map();
  ordered.forEach((entry, index) => {
    const score = Math.min(5, Math.max(1, Math.ceil(((n - index) / n) * 5)));
    scores.set(entry.customerId, score);
  });
  return scores;
};

const mean = (values) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stdDev = (values, avg) => {
  if (!values.length) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const zScoreScale = (rows) => {
  const recencies = rows.map((row) => row.recency);
  const frequencies = rows.map((row) => row.frequency);
  const monetaries = rows.map((row) => row.monetary);

  const recencyMean = mean(recencies);
  const frequencyMean = mean(frequencies);
  const monetaryMean = mean(monetaries);
  const recencyStd = stdDev(recencies, recencyMean) || 1;
  const frequencyStd = stdDev(frequencies, frequencyMean) || 1;
  const monetaryStd = stdDev(monetaries, monetaryMean) || 1;

  return rows.map((row) => ({
    ...row,
    scaledRecency: (row.recency - recencyMean) / recencyStd,
    scaledFrequency: (row.frequency - frequencyMean) / frequencyStd,
    scaledMonetary: (row.monetary - monetaryMean) / monetaryStd,
  }));
};

const euclideanDistance = (a, b) =>
  Math.sqrt(
    (a.scaledRecency - b.scaledRecency) ** 2 +
      (a.scaledFrequency - b.scaledFrequency) ** 2 +
      (a.scaledMonetary - b.scaledMonetary) ** 2
  );

const averageVector = (rows) => ({
  scaledRecency: mean(rows.map((row) => row.scaledRecency)),
  scaledFrequency: mean(rows.map((row) => row.scaledFrequency)),
  scaledMonetary: mean(rows.map((row) => row.scaledMonetary)),
});

const initializeCentroids = (rows, k) => {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.scaledRecency + a.scaledFrequency + a.scaledMonetary) -
        (b.scaledRecency + b.scaledFrequency + b.scaledMonetary) ||
      a.customerId - b.customerId
  );
  if (k === 1) return [averageVector(sorted)];
  const centroids = [];
  for (let i = 0; i < k; i += 1) {
    const index = Math.min(sorted.length - 1, Math.round((i * (sorted.length - 1)) / (k - 1)));
    centroids.push({
      scaledRecency: sorted[index].scaledRecency,
      scaledFrequency: sorted[index].scaledFrequency,
      scaledMonetary: sorted[index].scaledMonetary,
    });
  }
  return centroids;
};

const assignSegments = (profiles) => {
  const sortedByRecency = [...profiles].sort((a, b) => a.centroidRecency - b.centroidRecency);
  const recencyCutoffLow = sortedByRecency[Math.max(0, Math.floor(sortedByRecency.length * 0.35))]?.centroidRecency ?? 0;
  const recencyCutoffHigh = sortedByRecency[Math.max(0, Math.floor(sortedByRecency.length * 0.7))]?.centroidRecency ?? 0;

  return profiles.map((profile) => {
    const highRecency = profile.centroidRecency >= recencyCutoffHigh;
    const lowRecency = profile.centroidRecency <= recencyCutoffLow;
    const mediumHighFrequency = profile.centroidFrequency >= 0;
    const highFrequency = profile.centroidFrequency >= 0.5;
    const mediumHighMonetary = profile.centroidMonetary >= 0;
    const lowFrequency = profile.centroidFrequency < 0;
    const lowMonetary = profile.centroidMonetary < 0;

    let segmentName = SEGMENT_LABELS.dormant;
    if (lowRecency && highFrequency && mediumHighMonetary) segmentName = SEGMENT_LABELS.champions;
    else if (lowRecency && mediumHighFrequency) segmentName = SEGMENT_LABELS.loyal;
    else if (lowRecency && !highFrequency) segmentName = SEGMENT_LABELS.potential;
    else if (highRecency && mediumHighMonetary) segmentName = SEGMENT_LABELS.atRisk;
    else if (highRecency && lowFrequency && lowMonetary) segmentName = SEGMENT_LABELS.dormant;

    return { ...profile, segmentName };
  });
};

const getLatestRun = () =>
  prisma.segmentationRun.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      clusterProfiles: { orderBy: { clusterId: "asc" } },
      customerScores: {
        orderBy: { clusterId: "asc" },
        include: { customer: { select: { id: true, name: true, email: true, customerKey: true } } },
      },
    },
  });

const getRunById = (id) =>
  prisma.segmentationRun.findUnique({
    where: { id },
    include: {
      clusterProfiles: { orderBy: { clusterId: "asc" } },
      customerScores: {
        orderBy: { clusterId: "asc" },
        include: { customer: { select: { id: true, name: true, email: true, customerKey: true } } },
      },
    },
  });

export async function runRfmSegmentation(input = {}) {
  const requestedK = Number.parseInt(String(input.k ?? DEFAULT_K), 10);
  const k = Number.isFinite(requestedK) && requestedK > 0 ? requestedK : DEFAULT_K;
  const analysisDate = new Date();
  const run = await prisma.segmentationRun.create({
    data: {
      k,
      analysisDate,
      status: "processing",
      totalCustomers: 0,
    },
  });

  const transactions = await prisma.facilityTransaction.findMany({
    where: { validBooking: true, customerId: { not: null }, playDate: { not: null } },
    select: {
      customerId: true,
      customer: { select: { id: true, name: true, email: true, customerKey: true } },
      playDate: true,
      bookingEventKey: true,
      netRevenue: true,
    },
  });

  const customerMap = new Map();
  for (const row of transactions) {
    if (!row.customerId || !row.playDate) continue;
    const current = customerMap.get(row.customerId) || {
      customerId: row.customerId,
      customer: row.customer,
      latestPlayDate: row.playDate,
      bookingEventKeys: new Set(),
      monetary: 0,
    };
    if (row.playDate > current.latestPlayDate) current.latestPlayDate = row.playDate;
    current.bookingEventKeys.add(row.bookingEventKey);
    current.monetary += toNumber(row.netRevenue);
    customerMap.set(row.customerId, current);
  }

  const rawRows = [...customerMap.values()].map((row) => ({
    customerId: row.customerId,
    customer: row.customer,
    recency: Math.max(0, Math.ceil((analysisDate.getTime() - new Date(row.latestPlayDate).getTime()) / 86400000)),
    frequency: row.bookingEventKeys.size,
    monetary: row.monetary,
  }));

  if (rawRows.length === 0) {
    await prisma.segmentationRun.update({
      where: { id: run.id },
      data: { status: "completed", totalCustomers: 0 },
    });
    return { runId: run.id, run: await getRunById(run.id), clusters: [], summary: [], customers: [] };
  }

  const effectiveK = Math.min(k, rawRows.length);
  const scoredRows = zScoreScale(rawRows);
  const recencyScores = scoreByRank(rawRows, "recency", false);
  const frequencyScores = scoreByRank(rawRows, "frequency", true);
  const monetaryScores = scoreByRank(rawRows, "monetary", true);

  let centroids = initializeCentroids(scoredRows, effectiveK);
  let assignments = new Array(scoredRows.length).fill(0);

  for (let iteration = 0; iteration < 50; iteration += 1) {
    let changed = false;
    for (let i = 0; i < scoredRows.length; i += 1) {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let clusterId = 0; clusterId < centroids.length; clusterId += 1) {
        const distance = euclideanDistance(scoredRows[i], centroids[clusterId]);
        if (distance < bestDistance || (distance === bestDistance && clusterId < bestCluster)) {
          bestDistance = distance;
          bestCluster = clusterId;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    const nextCentroids = centroids.map((centroid, clusterId) => {
      const clusterRows = scoredRows.filter((_, index) => assignments[index] === clusterId);
      return clusterRows.length ? averageVector(clusterRows) : centroid;
    });

    const stable = nextCentroids.every((centroid, index) => euclideanDistance(centroid, centroids[index]) < 1e-6);
    centroids = nextCentroids;
    if (!changed || stable) break;
  }

  const clusterProfilesBase = centroids.map((centroid, clusterId) => {
    const clusterRows = rawRows.filter((_, index) => assignments[index] === clusterId);
    return {
      runId: run.id,
      clusterId,
      size: clusterRows.length,
      centroidRecency: centroid.scaledRecency,
      centroidFrequency: centroid.scaledFrequency,
      centroidMonetary: centroid.scaledMonetary,
    };
  });

  const clusterProfiles = assignSegments(clusterProfilesBase);
  const clusterSegmentMap = new Map(clusterProfiles.map((profile) => [profile.clusterId, profile.segmentName]));

  const customerScoresData = scoredRows.map((row, index) => ({
    runId: run.id,
    customerId: row.customerId,
    recency: rawRows[index].recency,
    frequency: rawRows[index].frequency,
    monetary: new Prisma.Decimal(rawRows[index].monetary),
    recencyScore: recencyScores.get(row.customerId) ?? 1,
    frequencyScore: frequencyScores.get(row.customerId) ?? 1,
    monetaryScore: monetaryScores.get(row.customerId) ?? 1,
    scaledRecency: row.scaledRecency,
    scaledFrequency: row.scaledFrequency,
    scaledMonetary: row.scaledMonetary,
    clusterId: assignments[index],
    segmentName: clusterSegmentMap.get(assignments[index]) || SEGMENT_LABELS.dormant,
  }));

  await prisma.$transaction([
    prisma.customerRfmScore.createMany({ data: customerScoresData }),
    prisma.clusterProfile.createMany({ data: clusterProfiles }),
    prisma.segmentationRun.update({
      where: { id: run.id },
      data: { status: "completed", totalCustomers: customerScoresData.length },
    }),
  ]);

  return {
    runId: run.id,
    run: await getRunById(run.id),
    clusters: clusterProfiles,
    summary: summarizeClusters(clusterProfiles),
    customers: customerScoresData.map((row) => ({
      customerId: row.customerId,
      clusterId: row.clusterId,
      segmentName: row.segmentName,
      recency: row.recency,
      frequency: row.frequency,
      monetary: row.monetary,
      recencyScore: row.recencyScore,
      frequencyScore: row.frequencyScore,
      monetaryScore: row.monetaryScore,
      scaledRecency: row.scaledRecency,
      scaledFrequency: row.scaledFrequency,
      scaledMonetary: row.scaledMonetary,
    })),
  };
}

const summarizeClusters = (clusters) =>
  clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    segmentName: cluster.segmentName,
    size: cluster.size,
  }));

export async function getLatestSegmentation() {
  const run = await getLatestRun();
  if (!run) {
    return { run: null, clusters: [], summary: [], customers: [] };
  }

  return {
    run,
    clusters: run.clusterProfiles,
    summary: summarizeClusters(run.clusterProfiles),
    customers: run.customerScores.map((row) => ({
      customerId: row.customerId,
      clusterId: row.clusterId,
      segmentName: row.segmentName,
      customer: row.customer,
      recency: row.recency,
      frequency: row.frequency,
      monetary: row.monetary,
      recencyScore: row.recencyScore,
      frequencyScore: row.frequencyScore,
      monetaryScore: row.monetaryScore,
    })),
  };
}

export async function getSegmentationSummary() {
  const run = await getLatestRun();
  if (!run) return [];
  return summarizeClusters(run.clusterProfiles);
}

export async function getSegmentationCustomers() {
  const run = await getLatestRun();
  if (!run) return [];
  return run.customerScores;
}
