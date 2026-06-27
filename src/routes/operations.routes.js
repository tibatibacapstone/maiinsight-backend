import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import {
  buildCourtHourUsageWhere,
  buildFacilityTransactionWhere,
  EXCLUDED_IMPORT_BATCH_FILE_NAMES,
  getAvailableCourtHours,
  getCourtCount,
  normalizeCourtTypeFilter,
} from "../services/dashboardPeriod.service.js"

const router = Router()

router.use(authenticate)

const ACTIVITY_TYPE_MAP = {
  login: "auth",
  user: "config",
  token: "config",
  import: "data",
  sync: "data",
  delete: "data",
  segmentation: "ai",
  ml: "ai",
  ai: "ai",
  report: "report",
  settings: "config",
  meta: "data",
}

const formatRelativeTime = (value) => {
  if (!value) return "-"

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return "-"

  const diffMs = Date.now() - timestamp.getTime()
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000))

  if (diffMinutes < 1) return "just now"
  if (diffMinutes < 60) return `${diffMinutes} min ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return "yesterday"

  return `${diffDays} days ago`
}

const getActivityType = (action = "") => {
  const normalized = String(action).toLowerCase()

  for (const [keyword, value] of Object.entries(ACTIVITY_TYPE_MAP)) {
    if (normalized.includes(keyword)) {
      return value
    }
  }

  return "config"
}

const buildStatus = (action = "", metadata = {}) => {
  const normalized = String(action).toLowerCase()
  const metadataStatus = String(metadata?.status || "").toLowerCase()

  if (normalized.includes("failed") || metadataStatus === "failed") return "error"
  if (normalized.includes("warning")) return "warning"
  return "success"
}

const formatMonthInputValue = (value) => {
  if (!value) return null

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return null

  return `${timestamp.getUTCFullYear()}-${String(timestamp.getUTCMonth() + 1).padStart(2, "0")}`
}

const buildDerivedNotifications = async () => {
  const [
    latestBatch,
    latestMlRun,
    latestSegmentationRun,
    latestMetaSync,
  ] = await Promise.all([
    prisma.importBatch.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        fileName: true,
        status: true,
        rowCount: true,
        updatedAt: true,
        errorMessage: true,
      },
    }),
    prisma.playtimeMlRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        totalSessions: true,
        totalCustomers: true,
        createdAt: true,
        errorMessage: true,
      },
    }),
    prisma.segmentationRun.findFirst({
      orderBy: { runDate: "desc" },
      select: {
        id: true,
        status: true,
        totalCustomers: true,
        runDate: true,
        errorMessage: true,
      },
    }),
    prisma.metaSyncLog.findFirst({
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        status: true,
        message: true,
        startedAt: true,
      },
    }),
  ])

  const derived = []

  if (latestBatch) {
    derived.push({
      id: `import-${latestBatch.id}`,
      title: latestBatch.status === "failed" ? "Import Failed" : "Import Completed",
      message:
        latestBatch.status === "failed"
          ? latestBatch.errorMessage || "The latest data import did not complete successfully."
          : `${latestBatch.fileName} imported ${latestBatch.rowCount} row(s).`,
      read: false,
      createdAt: latestBatch.updatedAt,
      category: "data",
      derived: true,
    })
  }

  if (latestMlRun) {
    derived.push({
      id: `ml-${latestMlRun.id}`,
      title: latestMlRun.status?.toLowerCase() === "failed" ? "ML Run Failed" : "ML Run Completed",
      message:
        latestMlRun.status?.toLowerCase() === "failed"
          ? latestMlRun.errorMessage || "The latest machine learning run did not complete successfully."
          : `Play-time ML processed ${latestMlRun.totalSessions} sessions for ${latestMlRun.totalCustomers} customers.`,
      read: false,
      createdAt: latestMlRun.createdAt,
      category: "ai",
      derived: true,
    })
  }

  if (latestSegmentationRun) {
    derived.push({
      id: `segmentation-${latestSegmentationRun.id}`,
      title:
        latestSegmentationRun.status?.toLowerCase() === "failed"
          ? "Segmentation Update Failed"
          : "Segmentation Updated",
      message:
        latestSegmentationRun.status?.toLowerCase() === "failed"
          ? latestSegmentationRun.errorMessage || "The latest segmentation run did not complete successfully."
          : `Customer value segments were refreshed for ${latestSegmentationRun.totalCustomers} customers.`,
      read: false,
      createdAt: latestSegmentationRun.runDate,
      category: "ai",
      derived: true,
    })
  }

  if (latestMetaSync) {
    derived.push({
      id: `meta-${latestMetaSync.id}`,
      title:
        latestMetaSync.status?.toLowerCase() === "failed"
          ? "InstaSight Sync Failed"
          : "InstaSight Sync Completed",
      message:
        latestMetaSync.message ||
        "Meta performance data sync status was updated.",
      read: false,
      createdAt: latestMetaSync.startedAt,
      category: "data",
      derived: true,
    })
  }

  return derived
}

const buildActivityItems = async () => {
  const [logs, batches, mlRuns, segmentationRuns, metaSyncLogs] = await Promise.all([
    prisma.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 120,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    }),
    prisma.importBatch.findMany({
      where: {
        fileName: {
          notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        fileName: true,
        rowCount: true,
        status: true,
        updatedAt: true,
        createdAt: true,
        errorMessage: true,
      },
    }),
    prisma.playtimeMlRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        totalSessions: true,
        totalCustomers: true,
        createdAt: true,
        errorMessage: true,
      },
    }),
    prisma.segmentationRun.findMany({
      orderBy: { runDate: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        totalCustomers: true,
        runDate: true,
        errorMessage: true,
      },
    }),
    prisma.metaSyncLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        message: true,
        startedAt: true,
      },
    }),
  ])

  const activityItems = [
    ...logs.map((log) => ({
      id: `log-${log.id}`,
      type: getActivityType(log.action),
      action: log.action,
      user: log.user?.name || log.user?.email || "System",
      role: log.user?.role || "system",
      details: log.metadata?.route
        ? `${log.metadata.route} (${log.metadata.method || "action"})`
        : "System activity recorded.",
      timestamp: log.createdAt,
      relativeTime: formatRelativeTime(log.createdAt),
      status: buildStatus(log.action, log.metadata),
      source: "activity_log",
    })),
    ...batches.map((batch) => ({
      id: `batch-${batch.id}`,
      type: "data",
      action: batch.status === "failed" ? "Import Failed" : "Import Completed",
      user: "System",
      role: "system",
      details:
        batch.status === "failed"
          ? batch.errorMessage || `${batch.fileName} failed to import.`
          : `${batch.fileName} imported ${batch.rowCount} row(s).`,
      timestamp: batch.updatedAt || batch.createdAt,
      relativeTime: formatRelativeTime(batch.updatedAt || batch.createdAt),
      status: batch.status === "failed" ? "error" : "success",
      source: "import_batch",
    })),
    ...mlRuns.map((run) => ({
      id: `ml-${run.id}`,
      type: "ai",
      action: run.status?.toLowerCase() === "failed" ? "ML Run Failed" : "ML Run Completed",
      user: "System",
      role: "system",
      details:
        run.status?.toLowerCase() === "failed"
          ? run.errorMessage || "Machine learning run failed."
          : `Processed ${run.totalSessions} sessions for ${run.totalCustomers} customers.`,
      timestamp: run.createdAt,
      relativeTime: formatRelativeTime(run.createdAt),
      status: run.status?.toLowerCase() === "failed" ? "error" : "success",
      source: "ml_run",
    })),
    ...segmentationRuns.map((run) => ({
      id: `seg-${run.id}`,
      type: "ai",
      action:
        run.status?.toLowerCase() === "failed"
          ? "Segmentation Update Failed"
          : "Segmentation Updated",
      user: "System",
      role: "system",
      details:
        run.status?.toLowerCase() === "failed"
          ? run.errorMessage || "Segmentation run failed."
          : `Segments refreshed for ${run.totalCustomers} customers.`,
      timestamp: run.runDate,
      relativeTime: formatRelativeTime(run.runDate),
      status: run.status?.toLowerCase() === "failed" ? "error" : "success",
      source: "segmentation_run",
    })),
    ...metaSyncLogs.map((syncLog) => ({
      id: `meta-${syncLog.id}`,
      type: "data",
      action:
        syncLog.status?.toLowerCase() === "failed"
          ? "InstaSight Sync Failed"
          : "InstaSight Sync Completed",
      user: "System",
      role: "system",
      details: syncLog.message || "Meta performance sync executed.",
      timestamp: syncLog.startedAt,
      relativeTime: formatRelativeTime(syncLog.startedAt),
      status: syncLog.status?.toLowerCase() === "failed" ? "error" : "success",
      source: "meta_sync",
    })),
  ]

  const deduped = new Map()

  activityItems
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .forEach((item) => {
      const key = `${item.action}|${item.details}|${new Date(item.timestamp).toISOString()}`
      if (!deduped.has(key)) {
        deduped.set(key, item)
      }
    })

  return [...deduped.values()]
}

const toCsv = (rows) => {
  const headers = ["Timestamp", "Type", "Action", "User", "Role", "Status", "Details"]
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`
  const lines = [headers.map(escape).join(",")]

  rows.forEach((row) => {
    lines.push(
      [
        row.timestamp,
        row.type,
        row.action,
        row.user,
        row.role,
        row.status,
        row.details,
      ]
        .map(escape)
        .join(",")
    )
  })

  return lines.join("\n")
}

const filterActivityItems = (items, query) => {
  const search = String(query.search || "").toLowerCase().trim()
  const type = String(query.type || "all").toLowerCase()
  const status = String(query.status || "all").toLowerCase()
  const role = String(query.role || "all").toLowerCase()
  const startDate = query.startDate ? new Date(query.startDate) : null
  const endDate = query.endDate ? new Date(query.endDate) : null

  return items.filter((item) => {
    const itemDate = new Date(item.timestamp)

    if (type !== "all" && item.type !== type) return false
    if (status !== "all" && item.status !== status) return false
    if (role !== "all" && String(item.role).toLowerCase() !== role) return false
    if (startDate && itemDate < startDate) return false
    if (endDate) {
      const safeEnd = new Date(endDate)
      safeEnd.setHours(23, 59, 59, 999)
      if (itemDate > safeEnd) return false
    }

    if (!search) return true

    return [item.action, item.user, item.role, item.details]
      .join(" ")
      .toLowerCase()
      .includes(search)
  })
}

router.get(
  "/status",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const [latestBatch, latestCompletedBatch, latestMetaSync, latestMlRun, latestSegmentationRun, transactionCount, transactionDateRange, transactionDates] =
        await Promise.all([
          prisma.importBatch.findFirst({
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              fileName: true,
              status: true,
              updatedAt: true,
              rowCount: true,
            },
          }),
          prisma.importBatch.findFirst({
            where: { status: "completed" },
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              fileName: true,
              status: true,
              updatedAt: true,
              rowCount: true,
            },
          }),
          prisma.metaSyncLog.findFirst({
            orderBy: { startedAt: "desc" },
            select: {
              id: true,
              status: true,
              message: true,
              startedAt: true,
            },
          }),
          prisma.playtimeMlRun.findFirst({
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              status: true,
              createdAt: true,
              totalSessions: true,
            },
          }),
          prisma.segmentationRun.findFirst({
            orderBy: { runDate: "desc" },
            select: {
              id: true,
              status: true,
              runDate: true,
              totalCustomers: true,
            },
          }),
          prisma.facilityTransaction.count({
            where: {
              batch: {
                fileName: {
                  notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
                },
              },
            },
          }),
          prisma.facilityTransaction.aggregate({
            where: {
              batch: {
                fileName: {
                  notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
                },
              },
            },
            _min: { transactionDate: true },
            _max: { transactionDate: true },
          }),
          prisma.facilityTransaction.findMany({
            where: {
              transactionDate: { not: null },
              batch: {
                fileName: {
                  notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
                },
              },
            },
            select: { transactionDate: true },
            distinct: ["transactionDate"],
            orderBy: { transactionDate: "asc" },
          }),
        ])

      const lastUpdatedCandidates = [
        latestBatch?.updatedAt,
        latestMetaSync?.startedAt,
        latestMlRun?.createdAt,
        latestSegmentationRun?.runDate,
      ].filter(Boolean)

      const lastUpdatedAt = lastUpdatedCandidates.length
        ? new Date(
            Math.max(
              ...lastUpdatedCandidates.map((value) => new Date(value).getTime())
            )
          ).toISOString()
        : null

      return res.json({
        success: true,
        data: {
          hasTransactionData: transactionCount > 0,
          transactionCount,
          transactionMonthRange: {
            min: formatMonthInputValue(transactionDateRange?._min?.transactionDate),
            max: formatMonthInputValue(transactionDateRange?._max?.transactionDate),
          },
          transactionAvailableMonths: [...new Set(transactionDates.map((item) => formatMonthInputValue(item.transactionDate)).filter(Boolean))],
          lastUpdatedAt,
          lastTransactionSyncAt: latestCompletedBatch?.updatedAt || null,
          latestImport: latestBatch,
          latestCompletedImport: latestCompletedBatch,
          latestMetaSync,
          latestMlRun,
          latestSegmentationRun,
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  "/notifications",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const storedNotifications = await prisma.notification.findMany({
        where: { role: req.user.role },
        orderBy: { createdAt: "desc" },
        take: 50,
      })

      const derivedNotifications = await buildDerivedNotifications()

      const notifications = [
        ...storedNotifications.map((item) => ({
          id: String(item.id),
          title: item.title,
          message: item.message,
          read: item.read,
          createdAt: item.createdAt,
          relativeTime: formatRelativeTime(item.createdAt),
          category: getActivityType(item.title),
          derived: false,
        })),
        ...derivedNotifications.map((item) => ({
          ...item,
          relativeTime: formatRelativeTime(item.createdAt),
        })),
      ]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, 50)

      return res.json({
        success: true,
        data: notifications,
      })
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  "/notifications/unread-count",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const unreadCount = await prisma.notification.count({
        where: {
          role: req.user.role,
          read: false,
        },
      })

      return res.json({
        success: true,
        data: {
          unreadCount,
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

router.patch(
  "/notifications/:id/read",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id)

      if (!Number.isFinite(id)) {
        return res.status(400).json({
          success: false,
          message: "This notification could not be updated.",
        })
      }

      const notification = await prisma.notification.findFirst({
        where: {
          id,
          role: req.user.role,
        },
      })

      if (!notification) {
        return res.status(404).json({
          success: false,
          message: "Notification not found.",
        })
      }

      await prisma.notification.update({
        where: { id },
        data: { read: true },
      })

      return res.json({
        success: true,
        message: "Notification marked as read.",
      })
    } catch (error) {
      next(error)
    }
  }
)

router.post(
  "/notifications/read-all",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      await prisma.notification.updateMany({
        where: {
          role: req.user.role,
          read: false,
        },
        data: { read: true },
      })

      return res.json({
        success: true,
        message: "Notifications marked as read.",
      })
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  "/history",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const items = await buildActivityItems()
      const filteredItems = filterActivityItems(items, req.query || {})

      return res.json({
        success: true,
        data: filteredItems,
      })
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  "/history/export",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const items = await buildActivityItems()
      const filteredItems = filterActivityItems(items, req.query || {})
      const csv = toCsv(filteredItems)

      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="maiinsight-history-${new Date().toISOString().slice(0, 10)}.csv"`
      )

      return res.send(csv)
    } catch (error) {
      next(error)
    }
  }
)

router.get(
  "/management-report",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : null
      const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : null
      const courtType = normalizeCourtTypeFilter(req.query.courtType)
      const bookingType = req.query.bookingType ? String(req.query.bookingType) : "all"
      const customerType = req.query.customerType ? String(req.query.customerType) : "All Type"

      if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
        return res.status(400).json({
          success: false,
          message: "Please choose a valid reporting date range.",
        })
      }

      const transactionWhere = buildFacilityTransactionWhere({
        startDate,
        endDate,
        courtType,
        customerType,
        bookingType,
      })

      const courtHourWhere = buildCourtHourUsageWhere({
        startDate,
        endDate,
        courtType,
        customerType,
        bookingType,
      })

      const [transactions, courtHourCount, latestSegmentationRun] = await Promise.all([
        prisma.facilityTransaction.findMany({
          where: transactionWhere,
          orderBy: { playDate: "asc" },
          select: {
            playDate: true,
            netRevenue: true,
            bookingType: true,
            courtType: true,
            customerProfile: true,
          },
        }),
        prisma.courtHourUsage.count({ where: courtHourWhere }),
        prisma.segmentationRun.findFirst({
          orderBy: { runDate: "desc" },
          select: {
            runDate: true,
            totalCustomers: true,
          },
        }),
      ])

      const courtCount = getCourtCount(courtType)
      const availableSessions = getAvailableCourtHours(startDate, endDate, courtCount)
      const totalRevenue = transactions.reduce(
        (sum, item) => sum + Number(item.netRevenue || 0),
        0
      )
      const avgRevenuePerBooking = transactions.length > 0 ? totalRevenue / transactions.length : 0
      const occupancyRate = availableSessions > 0 ? (courtHourCount / availableSessions) * 100 : 0

      const groupedTrend = new Map()
      const useDailyGrouping = Math.ceil((endDate - startDate) / 86400000) <= 45

      transactions.forEach((item) => {
        if (!item.playDate) return

        const date = new Date(item.playDate)
        const key = useDailyGrouping
          ? date.toISOString().slice(0, 10)
          : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
        const label = useDailyGrouping
          ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)
          : new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(date)

        const existing = groupedTrend.get(key) || {
          key,
          label,
          revenue: 0,
          bookings: 0,
        }

        existing.revenue += Number(item.netRevenue || 0)
        existing.bookings += 1
        groupedTrend.set(key, existing)
      })

      const revenueTrend = [...groupedTrend.values()].sort((left, right) =>
        left.key.localeCompare(right.key)
      )

      const bookingTypeBreakdown = transactions.reduce((accumulator, item) => {
        const key = item.bookingType || "other"
        accumulator[key] = (accumulator[key] || 0) + 1
        return accumulator
      }, {})

      const occupancyInsight =
        occupancyRate === 0
          ? "No occupancy data is available for the selected period."
          : occupancyRate < 35
            ? "Occupancy is still low for the selected period. Consider activating off-peak campaigns."
            : occupancyRate < 65
              ? "Occupancy is stable but still has room to improve in selected sessions."
              : "Occupancy is healthy for the selected period."

      const revenueInsight =
        totalRevenue === 0
          ? "No revenue data is available for the selected period."
          : avgRevenuePerBooking < 250000
            ? "Average booking value by play date is still modest. Upsell or bundle offers may help improve revenue."
            : "Average booking value by play date is healthy for the selected period."

      const recommendations = [occupancyInsight, revenueInsight]

      return res.json({
        success: true,
        data: {
          filters: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            courtType: courtType || "all",
            bookingType,
            customerType,
          },
          generatedAt: new Date().toISOString(),
          hasData: transactions.length > 0,
          summary: {
            totalRevenue,
            totalBookings: transactions.length,
            courtHourCount,
            availableSessions,
            occupancyRate: Number(occupancyRate.toFixed(1)),
            avgRevenuePerBooking: Number(avgRevenuePerBooking.toFixed(2)),
          },
          revenueTrend,
          bookingTypeBreakdown,
          segmentationSummary: latestSegmentationRun,
          insights: {
            executiveSummary:
              transactions.length > 0
                ? `The selected report covers ${transactions.length} booking record(s) with total revenue by play date of IDR ${Math.round(totalRevenue).toLocaleString("id-ID")}.`
                : "No transaction data is available for the selected reporting period.",
            occupancyInsight,
            revenueInsight,
            segmentationInsight: latestSegmentationRun
              ? `The latest customer value segmentation covered ${latestSegmentationRun.totalCustomers} customers.`
              : "Customer value segmentation has not been generated yet.",
            recommendations,
          },
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

export const operationsRouter = router




