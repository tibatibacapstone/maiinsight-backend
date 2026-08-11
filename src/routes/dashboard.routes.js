import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import {
  buildCourtHourUsageWhere,
  buildFacilityTransactionWhere,
  buildOccupancyTrendPeriods,
  EXCLUDED_IMPORT_BATCH_FILE_NAMES,
  getAvailableCourtHours,
    buildCustomRangeOccupancyPeriods,
  getCourtCount,
  getPreviousComparisonRange,
  normalizeCourtTypeFilter,
  resolveSelectedDateRange,
} from "../services/dashboardPeriod.service.js";
import { buildEmptySlotHeatmap } from "../services/emptySlotHeatmap.service.js";

export const dashboardRouter = Router();

const calculatePercentChange = (currentValue, previousValue) => {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);

  if (previous === 0) {
    if (current === 0) return 0;
    return 100;
  }

  return ((current - previous) / previous) * 100;
};

const COURT_TYPES = ["mini_soccer", "basketball"];
const COURT_TYPE_LABELS = {
  mini_soccer: "Mini Soccer",
  basketball: "Basketball",
};

dashboardRouter.use(authenticate);

const buildSelectedFilters = (query) => ({
  month: query.month ?? "All Month",
  year: query.year ?? String(new Date().getFullYear()),
  periodType: query.periodType ?? "MTD",
  venue: query.venue ?? query.courtType ?? "All Venue",
  customerType: query.customerType ?? "All Type",
  bookingType: query.bookingType ?? "all",
});

const SESSION_DEFINITIONS = [
  { name: "Morning", startHour: 6, endHour: 10 },
  { name: "Afternoon", startHour: 11, endHour: 14 },
  { name: "Evening", startHour: 15, endHour: 18 },
  { name: "Night", startHour: 19, endHour: 23 },
];
const EARLY_MONTH_REFERENCE_THRESHOLD_DAYS = 7;

const cloneDate = (value) => new Date(value.getTime());

const startOfDay = (value) => {
  const date = cloneDate(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = cloneDate(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const getRangeDayCount = (startDate, endDate) =>
  Math.max(
    0,
    Math.round(
      (endOfDay(endDate).getTime() - startOfDay(startDate).getTime()) / 86400000
    )
  ) + 1;

const resolveSessionNameByHour = (hourStart) => {
  const parsedHour = Number(String(hourStart ?? "").split(":")[0]);

  if (!Number.isFinite(parsedHour)) return null;

  return (
    SESSION_DEFINITIONS.find(
      (session) =>
        parsedHour >= session.startHour && parsedHour <= session.endHour
    )?.name || null
  );
};
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const getShortDayLabel = (dateValue) => {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);

  if (Number.isNaN(date.getTime())) return null;

  return DAY_LABELS[date.getDay()];
};

const normalizeStartHourLabel = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return null;

  return `${String(Number(match[1])).padStart(2, "0")}:00`;
};

const buildHeatmapSummaryFromTransactions = (transactions = []) => {
  if (transactions.length === 0) {
    return { slots: [], mostEmptySlot: null };
  }

  const slotCounts = new Map();

  transactions.forEach((transaction) => {
    const dayShort = getShortDayLabel(transaction.playDate);
    const startHour = normalizeStartHourLabel(transaction.startHour);

    if (!dayShort || !startHour) return;

    const key = `${dayShort}|${startHour}`;
    slotCounts.set(key, (slotCounts.get(key) || 0) + 1);
  });

  const slots = [];

  DAY_LABELS.forEach((day) => {
    SESSION_DEFINITIONS.forEach((session) => {
      for (let hour = session.startHour; hour <= session.endHour; hour += 1) {
        const startHour = `${String(hour).padStart(2, "0")}:00`;
        const key = `${day}|${startHour}`;

        slots.push({
          day_short: day,
          startHour,
          session_count: slotCounts.get(key) || 0,
          session_label: session.name,
        });
      }
    });
  });

  const mostEmptySlot =
    [...slots].sort((left, right) => {
      if (left.session_count !== right.session_count) {
        return left.session_count - right.session_count;
      }

      return DAY_LABELS.indexOf(left.day_short) - DAY_LABELS.indexOf(right.day_short);
    })[0] || null;

  return {
    slots,
    mostEmptySlot: mostEmptySlot
      ? {
          dayLabel: mostEmptySlot.day_short,
          hourLabel: mostEmptySlot.startHour,
          sessionLabel: mostEmptySlot.session_label,
          sessionCount: mostEmptySlot.session_count,
        }
      : null,
  };
};

const getPreviousMonthRange = (referenceDate) => {
  const year = referenceDate.getFullYear();
  const monthIndex = referenceDate.getMonth();

  return {
    startDate: startOfDay(new Date(year, monthIndex - 1, 1)),
    endDate: endOfDay(new Date(year, monthIndex, 0)),
  };
};

const getLowSessionSummary = async ({
  startDate,
  endDate,
  courtType,
  customerType,
  bookingType,
  periodType,
}) => {
  const selectedStartDate = startOfDay(new Date(startDate));
  const selectedEndDate = endOfDay(new Date(endDate));
  const selectedRangeDays = getRangeDayCount(selectedStartDate, selectedEndDate);

  let referenceStartDate = selectedStartDate;
  let referenceEndDate = selectedEndDate;
  let lowSessionBasis = "selected_period";
  let lowSessionDetail =
    "Based on historical occupancy within the selected play-date period.";

  const isSingleMonthRange =
    selectedStartDate.getFullYear() === selectedEndDate.getFullYear() &&
    selectedStartDate.getMonth() === selectedEndDate.getMonth();

  if (
    periodType === "MTD" &&
    isSingleMonthRange &&
    selectedStartDate.getDate() === 1 &&
    selectedRangeDays <= EARLY_MONTH_REFERENCE_THRESHOLD_DAYS
  ) {
    const previousMonthRange = getPreviousMonthRange(selectedStartDate);
    referenceStartDate = previousMonthRange.startDate;
    referenceEndDate = previousMonthRange.endDate;
    lowSessionBasis = "previous_month";
    lowSessionDetail = `Predicted from the previous month because the selected month only has ${selectedRangeDays} uploaded play day(s) so far.`;
  }

  const rangeDays = [];
  const cursor = new Date(referenceStartDate);

  while (cursor <= referenceEndDate) {
    rangeDays.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!rangeDays.length) {
    return {
      lowSessionLabel: "No Data",
      lowSessionCount: 0,
      lowSessionBasis: "no_data",
      lowSessionDetail: "No historical session data is available for the selected period.",
    };
  }

  const trackedCourtTypes = courtType ? [courtType] : COURT_TYPES;
  const usageRows = await prisma.courtHourUsage.findMany({
    where: buildCourtHourUsageWhere({
      startDate: referenceStartDate,
      endDate: referenceEndDate,
      courtType,
      customerType,
      bookingType,
      includeOperational: true,
    }),
    select: {
      hourStart: true,
      courtType: true,
    },
  });

  const usageByBucket = new Map();

  for (const row of usageRows) {
    const sessionName = resolveSessionNameByHour(row.hourStart);
    if (!sessionName || !row.courtType) continue;

    const bucketKey = `${sessionName}|${row.courtType}`;
    usageByBucket.set(bucketKey, (usageByBucket.get(bucketKey) || 0) + 1);
  }

  let selectedBucket = null;

  for (const session of SESSION_DEFINITIONS) {
    const sessionHourCount = session.endHour - session.startHour + 1;

    for (const trackedCourtType of trackedCourtTypes) {
      const bucketKey = `${session.name}|${trackedCourtType}`;
      const occupiedCourtHours = usageByBucket.get(bucketKey) || 0;
      const availableCourtHours = rangeDays.length * sessionHourCount;
      const occupancyRate =
        availableCourtHours > 0 ? occupiedCourtHours / availableCourtHours : 0;

      const candidate = {
        sessionName: session.name,
        courtType: trackedCourtType,
        occupiedCourtHours,
        availableCourtHours,
        occupancyRate,
      };

      if (!selectedBucket) {
        selectedBucket = candidate;
        continue;
      }

      if (candidate.occupancyRate < selectedBucket.occupancyRate) {
        selectedBucket = candidate;
        continue;
      }

      if (
        candidate.occupancyRate === selectedBucket.occupancyRate &&
        candidate.occupiedCourtHours < selectedBucket.occupiedCourtHours
      ) {
        selectedBucket = candidate;
        continue;
      }

      if (
        candidate.occupancyRate === selectedBucket.occupancyRate &&
        candidate.occupiedCourtHours === selectedBucket.occupiedCourtHours &&
        candidate.sessionName.localeCompare(selectedBucket.sessionName) < 0
      ) {
        selectedBucket = candidate;
      }
    }
  }

  if (!selectedBucket) {
    return {
      lowSessionLabel: "No Data",
      lowSessionCount: 0,
      lowSessionBasis: "no_data",
      lowSessionDetail: "No historical session data is available for the selected period.",
    };
  }

  const courtSuffix = courtType
    ? ""
    : ` - ${COURT_TYPE_LABELS[selectedBucket.courtType] || selectedBucket.courtType}`;
  const occupancyPercent = Number((selectedBucket.occupancyRate * 100).toFixed(1));

  return {
    lowSessionLabel: `${selectedBucket.sessionName}${courtSuffix}`,
    lowSessionCount: selectedBucket.occupiedCourtHours,
    lowSessionBasis,
    lowSessionDetail: `${lowSessionDetail} Historical occupancy was ${occupancyPercent}% for this session bucket${courtSuffix ? " in the referenced venue" : ""}.`,
  };
};

dashboardRouter.get("/overview", authorize("operational", "management", "it_support"), async (req, res, next) => {
  try {
    const totalUsers = await prisma.user.count();
    const activityCount = await prisma.activityLog.count();
    const notifications = await prisma.notification.findMany({ where: { role: req.user.role } });

    res.json({
      overview: {
        totalUsers,
        activityCount,
        notificationsCount: notifications.length,
        role: req.user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/activity", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const logs = await prisma.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/notifications", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { role: req.user.role },
      orderBy: { createdAt: "desc" },
    });

    res.json({ notifications });
  } catch (error) {
    next(error);
  }
});
dashboardRouter.get(
  "/playtime-mix",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const filters = buildSelectedFilters(req.query);
      const courtType = normalizeCourtTypeFilter(filters.venue);

      const selectedRange =
  req.query.startDate && req.query.endDate
    ? {
        startDate: startOfDay(new Date(req.query.startDate)),
        endDate: endOfDay(new Date(req.query.endDate)),
      }
    : resolveSelectedDateRange({
        selectedYear: filters.year,
        selectedMonth: filters.month,
        periodType: filters.periodType,
      });
      if (!selectedRange) {
        return res.json({
          success: true,
          message: "Playtime mix fetched successfully.",
          data: {
            sessionByTime: [],
            totalSessions: 0,
            totalCustomers: 0,
            heatmapSummary: buildHeatmapSummaryFromTransactions([]),
          },
        });
      }

      const transactionWhere = buildFacilityTransactionWhere({
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      });

      const transactions = await prisma.facilityTransaction.findMany({
        where: transactionWhere,
        select: {
          playDate: true,
          startHour: true,
          customerKey: true,
          bookingEventKey: true,
        },
      });

      const sessionCounts = {
        Morning: 0,
        Afternoon: 0,
        Evening: 0,
        Night: 0,
      };

      const customerSet = new Set();
      const sessionEventKeys = new Set();
      const sessionEventKeysByGroup = new Map(
        SESSION_DEFINITIONS.map((session) => [session.name, new Set()])
      );

      transactions.forEach((tx) => {
        const sessionName = resolveSessionNameByHour(tx.startHour);

        if (!sessionName || !tx.bookingEventKey) return;

        sessionEventKeys.add(tx.bookingEventKey);
        sessionEventKeysByGroup.get(sessionName)?.add(tx.bookingEventKey);

        if (tx.customerKey && !tx.customerKey.startsWith("SYS-")) {
          customerSet.add(tx.customerKey);
        }
      });

      SESSION_DEFINITIONS.forEach((session) => {
        sessionCounts[session.name] = sessionEventKeysByGroup.get(session.name)?.size || 0;
      });

      const sessionByTime = SESSION_DEFINITIONS
        .filter((session) => sessionCounts[session.name] > 0)
        .map((session) => ({
          play_time_group: session.name,
          session_count: sessionCounts[session.name],
        }));

      const heatmapSummary = buildHeatmapSummaryFromTransactions(transactions);

      return res.json({
        success: true,
        message: "Playtime mix fetched successfully.",
        data: {
          sessionByTime,
          totalSessions: sessionEventKeys.size,
          totalCustomers: customerSet.size,
          heatmapSummary,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ⬅️ NEW: Empty Slot Heatmap derived from actual court-hour-usage data
// (replaces the previous ML playtime source).
dashboardRouter.get(
  "/empty-slot-heatmap",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const filters = buildSelectedFilters(req.query)
      const courtType = normalizeCourtTypeFilter(filters.venue)

      const selectedRange =
        req.query.startDate && req.query.endDate
          ? {
              startDate: startOfDay(new Date(req.query.startDate)),
              endDate: endOfDay(new Date(req.query.endDate)),
            }
          : resolveSelectedDateRange({
              selectedYear: filters.year,
              selectedMonth: filters.month,
              periodType: filters.periodType,
            })

      if (!selectedRange) {
        return res.json({
          success: true,
          message: "Empty slot heatmap fetched successfully.",
          data: { slots: [], mostEmptySlot: null },
        })
      }

      const { startDate, endDate } = selectedRange
      const courtCount = courtType ? 1 : 2

      const usageWhere = buildCourtHourUsageWhere({
        startDate,
        endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      })

      // Aggregate booked hours per (dayOfWeek, startHour)
      const usageRows = await prisma.courtHourUsage.findMany({
        where: usageWhere,
        select: {
          courtHourKey: true,
          courtType: true,
          playDate: true,
          hourStart: true,
          transaction: {
            select: {
              status: true,
            },
          },
        },
      })

      res.json({
        success: true,
        message: "Empty slot heatmap fetched successfully.",
        data: buildEmptySlotHeatmap({
          usageRows,
          startDate,
          endDate,
          courtCount,
        }),
      })
    } catch (error) {
      next(error)
    }
  }
)

dashboardRouter.get(
  "/data-center",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const [
        totalBatches,
        totalRawRows,
        totalFacilityTransactions,
        totalCourtHourUsages,
        completedBatches,
        failedBatches,
        aiStrategySuggestionCount,
        metaMediaCount,
        latestBatch,
        lastTransactionDate,

        totalInstagramMedia,
        totalInstagramMediaInsights,
        totalInstagramAccountInsights,
        totalInstagramAudienceInsights,
        latestMetaSync,
      ] = await Promise.all([
        prisma.importBatch.count({
          where: {
            fileName: {
              notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
            },
          },
        }),

        prisma.rawTransactionTable.count({
          where: {
            batch: {
              fileName: {
                notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
              },
            },
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

        prisma.courtHourUsage.count({
          where: {
            transaction: {
              batch: {
                fileName: {
                  notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
                },
              },
            },
          },
        }),

        prisma.importBatch.count({
          where: {
            status: "completed",
            fileName: {
              notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
            },
          },
        }),

        prisma.importBatch.count({
          where: {
            status: "failed",
            fileName: {
              notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
            },
          },
        }),
        prisma.activityLog.count({
          where: {
            action: "AI_STRATEGY_GENERATED",
          },
        }),
        prisma.instagramMedia.count(),

        prisma.importBatch.findFirst({
          where: {
            fileName: {
              notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            fileName: true,
            rowCount: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        }),

        prisma.facilityTransaction.findFirst({
          where: {
            batch: {
              fileName: {
                notIn: EXCLUDED_IMPORT_BATCH_FILE_NAMES,
              },
            },
            playDate: { not: null },
          },
          orderBy: {
            playDate: "desc",
          },
          select: {
            playDate: true,
          },
        }),

        // Meta Graph API records
        prisma.instagramMedia.count(),
        prisma.instagramMediaInsight.count(),
        prisma.instagramAccountInsight.count(),
        prisma.instagramAudienceInsight.count(),

        prisma.metaSyncLog.findFirst({
          orderBy: {
            startedAt: "desc",
          },
          select: {
            id: true,
            status: true,
            message: true,
            startedAt: true,
            finishedAt: true,
          },
        }),
      ]);

      const totalMetaRecords =
        totalInstagramMedia +
        totalInstagramMediaInsights +
        totalInstagramAccountInsights +
        totalInstagramAudienceInsights;

      res.json({
        success: true,
        message: "Data center summary fetched successfully.",
        data: {
          totalBatches,
          totalRawRows,
          totalFacilityTransactions,
          totalCourtHourUsages,
          completedBatches,
          failedBatches,
          aiStrategySuggestionCount,
          metaMediaCount,
          latestBatch,
          lastTransactionDate: lastTransactionDate?.playDate ?? null,

          totalInstagramMedia,
          totalInstagramMediaInsights,
          totalInstagramAccountInsights,
          totalInstagramAudienceInsights,
          totalMetaRecords,
          latestMetaSync,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

dashboardRouter.post("/activity", authorize("operational", "it_support"), async (req, res, next) => {
  try {
    const { action, metadata } = req.body;
    const log = await prisma.activityLog.create({
      data: {
        userId: req.user.userId,
        action,
        metadata,
      },
    });

    res.status(201).json({ log });
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get(
  "/overview-kpis",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const filters = buildSelectedFilters(req.query);
      const courtType = normalizeCourtTypeFilter(filters.venue);
      const selectedRange =
  req.query.startDate && req.query.endDate
    ? {
        startDate: startOfDay(new Date(req.query.startDate)),
        endDate: endOfDay(new Date(req.query.endDate)),
      }
    : resolveSelectedDateRange({
        selectedYear: filters.year,
        selectedMonth: filters.month,
        periodType: filters.periodType,
      });

      if (!selectedRange) {
        return res.json({
          success: true,
          message: "Overview KPI fetched successfully.",
          data: {
            occupancyRate: 0,
            occupancyChange: 0,
            totalRevenue: 0,
            revenueChange: 0,
            lowSessionLabel: "No Data",
            lowSessionCount: 0,
            lowSessionBasis: "no_data",
            lowSessionDetail: "No historical session data is available for the selected period.",
            peakSessionLabel: "-",
            peakSessionRevenue: 0,
            totalBookedSessions: 0,
            availableSessions: 0,
          },
        });
      }

      const previousRange = getPreviousComparisonRange(selectedRange);

      const transactionWhere = buildFacilityTransactionWhere({
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      });

      const previousTransactionWhere = buildFacilityTransactionWhere({
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      });

      const courtHourWhere = buildCourtHourUsageWhere({
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      });

      const previousCourtHourWhere = buildCourtHourUsageWhere({
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
        includeOperational: true,
      });

      const [
        revenueResult,
        previousRevenueResult,
        totalBookedSessions,
        previousBookedSessions,
        lowSession,
        transactions,
      ] = await Promise.all([
        prisma.facilityTransaction.aggregate({
          where: transactionWhere,
          _sum: {
            netRevenue: true,
          },
        }),
        prisma.facilityTransaction.aggregate({
          where: previousTransactionWhere,
          _sum: {
            netRevenue: true,
          },
        }),
        prisma.courtHourUsage.count({
          where: courtHourWhere,
        }),
        prisma.courtHourUsage.count({
          where: previousCourtHourWhere,
        }),
        getLowSessionSummary({
          startDate: selectedRange.startDate,
          endDate: selectedRange.endDate,
          courtType,
          customerType: filters.customerType,
          bookingType: filters.bookingType,
          periodType: filters.periodType,
        }),
        prisma.facilityTransaction.findMany({
          where: transactionWhere,
          select: {
            startHour: true,
            netRevenue: true,
          },
        }),
      ]);

      const totalRevenue = Number(revenueResult._sum.netRevenue || 0);
      const previousRevenue = Number(previousRevenueResult._sum.netRevenue || 0);

      // Calculate peak session revenue
      const sessionRevenue = {
        Morning: 0,
        Afternoon: 0,
        Evening: 0,
        Night: 0,
      };

      transactions.forEach((tx) => {
        const hourStr = tx.startHour || "";
        const hour = Number(String(hourStr).split(":")[0]);

        const session = resolveSessionNameByHour(hour);

        if (session) {
          sessionRevenue[session] += Number(tx.netRevenue || 0);
        }
      });

      const peakSession =
        transactions.length > 0
          ? Object.entries(sessionRevenue).reduce((max, [session, revenue]) =>
              revenue > max[1] ? [session, revenue] : max
            )
          : null;

      const peakSessionLabel = peakSession ? peakSession[0] : "No Data";
      const peakSessionRevenue = peakSession ? peakSession[1] : 0;

      const courtCount = getCourtCount(courtType);
      const availableSessions = getAvailableCourtHours(
        selectedRange.startDate,
        selectedRange.endDate,
        courtCount
      );
      const previousAvailableSessions = getAvailableCourtHours(
        previousRange.startDate,
        previousRange.endDate,
        courtCount
      );

      const occupancyRate =
        availableSessions > 0 ? (totalBookedSessions / availableSessions) * 100 : 0;
      const previousOccupancyRate =
        previousAvailableSessions > 0
          ? (previousBookedSessions / previousAvailableSessions) * 100
          : 0;

      const occupancyChange = calculatePercentChange(occupancyRate, previousOccupancyRate);
      const revenueChange = calculatePercentChange(totalRevenue, previousRevenue);

      const normalizedLowSession =
        totalBookedSessions > 0
          ? lowSession
          : {
              lowSessionLabel: "-",
              lowSessionCount: 0,
              lowSessionBasis: "no_data",
              lowSessionDetail: "No data is available for the selected period.",
            };

      return res.json({
        success: true,
        message: "Overview KPI fetched successfully.",
        data: {
          occupancyRate: Number(occupancyRate.toFixed(1)),
          occupancyChange: Number(occupancyChange.toFixed(1)),
          totalRevenue,
          revenueChange: Number(revenueChange.toFixed(1)),
          lowSessionLabel: normalizedLowSession.lowSessionLabel,
          lowSessionCount: normalizedLowSession.lowSessionCount,
          lowSessionBasis: normalizedLowSession.lowSessionBasis,
          lowSessionDetail: normalizedLowSession.lowSessionDetail,
          peakSessionLabel,
          peakSessionRevenue,
          totalBookedSessions,
          availableSessions,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

dashboardRouter.get(
  "/occupancy-trend",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const filters = buildSelectedFilters(req.query);
      const courtType = normalizeCourtTypeFilter(filters.venue);

      const trendPeriods = (req.query.startDate && req.query.endDate)
        ? buildCustomRangeOccupancyPeriods({
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            forceDaily: String(req.query.bucket || "").toLowerCase() === "daily",
          })
        : buildOccupancyTrendPeriods({
            selectedYear: filters.year,
            selectedMonth: filters.month,
            periodType: filters.periodType,
          });

      const courtCount = getCourtCount(courtType);

      const trend = await Promise.all(
        trendPeriods.map(async (period) => {
          const bookedSessions = await prisma.courtHourUsage.count({
            where: buildCourtHourUsageWhere({
              startDate: period.startDate,
              endDate: period.endDate,
              courtType,
              customerType: filters.customerType,
              bookingType: filters.bookingType,
              includeOperational: true,
            }),
          });

          const availableSessions = getAvailableCourtHours(
            period.startDate,
            period.endDate,
            courtCount
          );

          const rate =
            availableSessions > 0 ? (bookedSessions / availableSessions) * 100 : 0;

          return {
            label: period.label,
            month: period.month,
            date: period.date,
            bookedSessions,
            availableSessions,
            rate: Number(rate.toFixed(1)),
          };
        })
      );

      return res.json({
        success: true,
        message: "Occupancy trend fetched successfully.",
        data: trend,
      });
    } catch (error) {
      next(error);
    }
  }
);
dashboardRouter.get(
  "/sync-jobs",
  authorize("operational", "management", "it_support"),
  async (req, res, next) => {
    try {
      const importJobs = await prisma.importBatch.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: 30,
        select: {
          id: true,
          fileName: true,
          rowCount: true,
          status: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { facilityTransactions: true },
          },
        },
      })

      const activityLogs = await prisma.activityLog.findMany({
  where: {
    action: {
      in: [
        "INSTASIGHT_SYNC_COMPLETED",
        "INSTASIGHT_SYNC_FAILED",
        "AI_STRATEGY_GENERATED",
        "AI_STRATEGY_FAILED",
        "SEGMENTATION_UPDATED",
        "SEGMENTATION_FAILED",
      ],
    },
  },
  orderBy: {
    createdAt: "desc",
  },
  take: 50,
  select: {
    id: true,
    action: true,
    metadata: true,
    createdAt: true,
  },
})
console.log("SYNC JOBS ACTIVITY LOGS:", activityLogs.map((log) => ({
  id: log.id,
  action: log.action,
  metadata: log.metadata,
  createdAt: log.createdAt,
})))

      const normalizeImportStatus = (status) => {
        const normalized = String(status || "").toLowerCase()

        if (normalized === "completed" || normalized === "uploaded") {
          return "completed"
        }

        if (normalized === "failed") {
          return "failed"
        }

        if (normalized === "processing") {
          return "processing"
        }

        return "queued"
      }

      const normalizeActivityStatus = (action, metadata) => {
        const normalizedAction = String(action || "").toLowerCase()
        const normalizedStatus = String(metadata?.status || "").toLowerCase()

        if (
          normalizedAction.includes("failed") ||
          normalizedStatus === "failed" ||
          normalizedStatus === "error"
        ) {
          return "failed"
        }

        if (
          normalizedAction.includes("started") ||
          normalizedStatus === "started" ||
          normalizedStatus === "processing" ||
          normalizedStatus === "running"
        ) {
          return "processing"
        }

        return "completed"
      }

      const formatActionName = (action) => {
        const normalizedAction = String(action || "")

        if (normalizedAction.includes("INSTASIGHT_SYNC")) {
          return "Meta Graph API Sync"
        }

        if (normalizedAction.includes("AI_STRATEGY")) {
          return "AI Strategy Engine Sync"
        }

        if (normalizedAction.includes("SEGMENTATION")) {
          return "Customer Value Segmentation Run"
        }

        return normalizedAction
          .replaceAll("_", " ")
          .toLowerCase()
          .replace(/\b\w/g, (char) => char.toUpperCase())
      }

      const fileJobs = importJobs.map((job) => {
        const status = normalizeImportStatus(job.status)

        return {
          id: `file-${job.id}`,
          name: job.fileName,
          type: "file",
          status,
          progress:
            status === "completed"
              ? 100
              : status === "failed"
                ? 0
                : 60,
          records: job._count.facilityTransactions || 0,
          startedAt: job.createdAt,
          completedAt: status === "completed" ? job.updatedAt : null,
          error: job.errorMessage || null,
        }
      })

      const activityJobs = activityLogs.map((log) => {
        const metadata = log.metadata || {}
        const status = normalizeActivityStatus(log.action, metadata)

        return {
          id: `activity-${log.id}`,
          name: metadata.jobName || formatActionName(log.action),
          type: "api",
          status,
          progress:
            status === "completed"
              ? 100
              : status === "failed"
                ? 0
                : 60,
          records: Number(
            metadata.records ||
              metadata.totalCustomers ||
              metadata.totalRecords ||
              metadata.mediaCount ||
              0
          ),
          startedAt: metadata.startedAt || log.createdAt,
          completedAt:
            metadata.completedAt ||
            metadata.finishedAt ||
            (status === "processing" ? null : log.createdAt),
          error: metadata.technicalMessage || metadata.error || null,
        }
      })

      const jobs = [...activityJobs, ...fileJobs].sort(
        (left, right) =>
          new Date(right.startedAt).getTime() -
          new Date(left.startedAt).getTime()
      )

      return res.json({
        success: true,
        message: "Sync jobs fetched successfully.",
        data: jobs.slice(0, 50),
      })
    } catch (error) {
      next(error)
    }
  }
)
