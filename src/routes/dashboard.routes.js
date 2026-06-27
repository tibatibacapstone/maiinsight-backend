import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import {
  buildCourtHourUsageWhere,
  buildFacilityTransactionWhere,
  buildOccupancyTrendPeriods,
  EXCLUDED_IMPORT_BATCH_FILE_NAMES,
  formatHourLabel,
  getAvailableCourtHours,
  getCourtCount,
  getPreviousComparisonRange,
  getWeekdayLabel,
  normalizeCourtTypeFilter,
  resolveSelectedDateRange,
} from "../services/dashboardPeriod.service.js";

export const dashboardRouter = Router();

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
  { name: "Morning", startHour: 6, endHour: 11 },
  { name: "Afternoon", startHour: 12, endHour: 15 },
  { name: "Evening", startHour: 16, endHour: 18 },
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
        latestBatch,
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
      ]);

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
          latestBatch,
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
      const selectedRange = resolveSelectedDateRange({
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
      });

      const previousTransactionWhere = buildFacilityTransactionWhere({
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
      });

      const courtHourWhere = buildCourtHourUsageWhere({
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
      });

      const previousCourtHourWhere = buildCourtHourUsageWhere({
        startDate: previousRange.startDate,
        endDate: previousRange.endDate,
        courtType,
        customerType: filters.customerType,
        bookingType: filters.bookingType,
      });

      const [
        revenueResult,
        previousRevenueResult,
        totalBookedSessions,
        previousBookedSessions,
        lowSession,
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
      ]);

      const totalRevenue = Number(revenueResult._sum.netRevenue || 0);
      const previousRevenue = Number(previousRevenueResult._sum.netRevenue || 0);

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

      const occupancyChange = occupancyRate - previousOccupancyRate;
      const revenueChange =
        previousRevenue > 0
          ? ((totalRevenue - previousRevenue) / previousRevenue) * 100
          : 0;

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
      const trendPeriods = buildOccupancyTrendPeriods({
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




