import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js"
export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

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
        completedBatches,
        failedBatches,
        latestBatch,
      ] = await Promise.all([
        prisma.importBatch.count(),

        prisma.rawTransactionTable.count(),

        prisma.facilityTransaction.count(),

        prisma.importBatch.count({
          where: {
            status: "completed",
          },
        }),

        prisma.importBatch.count({
          where: {
            status: "failed",
          },
        }),

        prisma.importBatch.findFirst({
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
      ])

      res.json({
        success: true,
        message: "Data center summary fetched successfully.",
        data: {
          totalBatches,
          totalRawRows,
          totalFacilityTransactions,
          completedBatches,
          failedBatches,
          latestBatch,
        },
      })
    } catch (error) {
      next(error)
    }
  }
)

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
const monthMap = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sept: 8,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

const playtimeLabelMap = {
  Pagi: "Morning",
  Siang: "Afternoon",
  Malam: "Night",
}

const dayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

const getDateRange = ({ selectedYear, selectedMonth }) => {
  const year = Number(selectedYear)

  if (!year || Number.isNaN(year)) {
    throw new Error("Invalid year.")
  }

  if (selectedMonth && selectedMonth !== "All Month") {
    const monthIndex = monthMap[selectedMonth]

    if (monthIndex === undefined) {
      throw new Error("Invalid month.")
    }

    const startDate = new Date(year, monthIndex, 1)
    const endDate = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999)

    return {
      startDate,
      endDate,
    }
  }

  return {
    startDate: new Date(year, 0, 1),
    endDate: new Date(year, 11, 31, 23, 59, 59, 999),
  }
}

const getPreviousDateRange = ({ selectedYear, selectedMonth }) => {
  const year = Number(selectedYear)

  if (selectedMonth && selectedMonth !== "All Month") {
    const monthIndex = monthMap[selectedMonth]
    const previousMonthDate = new Date(year, monthIndex - 1, 1)

    return {
      startDate: new Date(previousMonthDate.getFullYear(), previousMonthDate.getMonth(), 1),
      endDate: new Date(
        previousMonthDate.getFullYear(),
        previousMonthDate.getMonth() + 1,
        0,
        23,
        59,
        59,
        999
      ),
    }
  }

  return {
    startDate: new Date(year - 1, 0, 1),
    endDate: new Date(year - 1, 11, 31, 23, 59, 59, 999),
  }
}

const getFieldCount = (selectedVenue) => {
  if (selectedVenue === "Mini Soccer") return 1
  if (selectedVenue === "Basket") return 1

  // Sesuaikan kalau nanti jumlah lapangan bertambah
  return 2
}

const getAvailableSessions = (startDate, endDate, fieldCount) => {
  let totalSlots = 0
  const currentDate = new Date(startDate)

  while (currentDate <= endDate) {
    const day = currentDate.getDay()

    // Senin-Jumat: 08:00-22:00 = 14 slot
    // Sabtu-Minggu: 06:00-22:00 = 16 slot
    const dailySlots = day === 0 || day === 6 ? 16 : 14

    totalSlots += dailySlots * fieldCount
    currentDate.setDate(currentDate.getDate() + 1)
  }

  return totalSlots
}

const buildTransactionWhere = ({
  startDate,
  endDate,
  selectedVenue,
  selectedCustomerType,
}) => {
  const validStatusFilter = {
    OR: [
      {
        status: {
          contains: "Payment Completed",
        },
      },
      {
        status: {
          contains: "Manual/Walk-in",
        },
      },
    ],
  }

  const where = {
    AND: [
      {
        tanggalMain: {
          gte: startDate,
          lte: endDate,
        },
      },
      validStatusFilter,
      {
        playTimeGroup: {
          in: ["Pagi", "Siang", "Malam"],
        },
      },
    ],
  }

  if (selectedVenue && selectedVenue !== "All Venue") {
    where.AND.push({
      lapangan: {
        contains: selectedVenue === "Basket" ? "Basket" : selectedVenue,
      },
    })
  }

  if (selectedCustomerType && selectedCustomerType !== "All Type") {
    if (selectedCustomerType === "Membership") {
      where.AND.push({
        status: {
          contains: "Payment Completed",
        },
      })
    }

    if (
      selectedCustomerType === "Non Membership" ||
      selectedCustomerType === "Manual/Walk-in"
    ) {
      where.AND.push({
        status: {
          contains: "Manual/Walk-in",
        },
      })
    }
  }

  return where
}


dashboardRouter.get("/overview-kpis", async (req, res, next) => {
  try {
    const {
      month = "All Month",
      year = "2026",
      venue = "All Venue",
      customerType = "All Type",
    } = req.query
  

    const { startDate, endDate } = getDateRange({
      selectedYear: year,
      selectedMonth: month,
    })

    const previousRange = getPreviousDateRange({
      selectedYear: year,
      selectedMonth: month,
    })

   const where = buildTransactionWhere({
  startDate,
  endDate,
  selectedVenue: venue,
  selectedCustomerType: customerType,
})

    const previousWhere = buildTransactionWhere({
  startDate: previousRange.startDate,
  endDate: previousRange.endDate,
  selectedVenue: venue,
  selectedCustomerType: customerType,
})


    const totalBookedSessions = await prisma.facilityTransaction.count({
      where,
    })

    const previousBookedSessions = await prisma.facilityTransaction.count({
      where: previousWhere,
    })

    const revenueResult = await prisma.facilityTransaction.aggregate({
      where,
      _sum: {
        hargaBersih: true,
      },
    })

    const previousRevenueResult = await prisma.facilityTransaction.aggregate({
      where: previousWhere,
      _sum: {
        hargaBersih: true,
      },
    })

    const totalRevenue = Number(revenueResult._sum.hargaBersih || 0)
    const previousRevenue = Number(previousRevenueResult._sum.hargaBersih || 0)

    const fieldCount = getFieldCount(venue)
    const availableSessions = getAvailableSessions(startDate, endDate, fieldCount)
    const previousAvailableSessions = getAvailableSessions(
      previousRange.startDate,
      previousRange.endDate,
      fieldCount
    )

    const occupancyRate =
      availableSessions > 0 ? (totalBookedSessions / availableSessions) * 100 : 0

    const previousOccupancyRate =
      previousAvailableSessions > 0
        ? (previousBookedSessions / previousAvailableSessions) * 100
        : 0

    const occupancyChange = occupancyRate - previousOccupancyRate

    const revenueChange =
      previousRevenue > 0
        ? ((totalRevenue - previousRevenue) / previousRevenue) * 100
        : 0

    const sessions = await prisma.facilityTransaction.findMany({
      where,
      select: {
        tanggalMain: true,
        playTimeGroup: true,
      },
    })

    const sessionBucket = {}

    for (const day of dayNames) {
      for (const group of ["Pagi", "Siang", "Malam"]) {
        sessionBucket[`${day} ${group}`] = {
          day,
          playTimeGroup: group,
          count: 0,
        }
      }
    }

    for (const item of sessions) {
      if (!item.tanggalMain || !item.playTimeGroup) continue

      const date = new Date(item.tanggalMain)
      const dayName = dayNames[date.getDay()]
      const key = `${dayName} ${item.playTimeGroup}`

      if (sessionBucket[key]) {
        sessionBucket[key].count += 1
      }
    }

    const lowSession = Object.values(sessionBucket).sort(
      (a, b) => a.count - b.count
    )[0]

    const lowSessionLabel = lowSession
      ? `${lowSession.day} ${playtimeLabelMap[lowSession.playTimeGroup]}`
      : "No Data"

    res.json({
      success: true,
      message: "Overview KPI fetched successfully.",
      data: {
        occupancyRate: Number(occupancyRate.toFixed(1)),
        occupancyChange: Number(occupancyChange.toFixed(1)),

        totalRevenue,
        revenueChange: Number(revenueChange.toFixed(1)),

        lowSessionLabel,
        lowSessionCount: lowSession?.count || 0,

        totalBookedSessions,
        availableSessions,
      },
    })
  } catch (error) {
    next(error)
  }
dashboardRouter.get("/occupancy-trend", async (req, res, next) => {
  try {
    const {
      month = "All Month",
      year = "2025",
      periodType = "MTD",
      venue = "All Venue",
      customerType = "All Type",
    } = req.query

    const selectedYear = Number(year)
    const today = new Date()

    const currentYear = today.getFullYear()
    const currentMonthIndex = today.getMonth()
    const currentDate = today.getDate()

    if (!selectedYear || Number.isNaN(selectedYear)) {
      return res.status(400).json({
        success: false,
        message: "Invalid year.",
      })
    }

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sept",
      "Oct",
      "Nov",
      "Dec",
    ]

    const monthMap = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sept: 8,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    }

    const getFieldCount = (selectedVenue) => {
      if (selectedVenue === "Mini Soccer") return 1
      if (selectedVenue === "Basket") return 1
      return 2
    }

    const getAvailableSessions = (startDate, endDate, fieldCount) => {
      let totalSlots = 0
      const currentDateLoop = new Date(startDate)

      while (currentDateLoop <= endDate) {
        const day = currentDateLoop.getDay()

        // Senin-Jumat: 08:00-22:00 = 14 slot
        // Sabtu-Minggu: 06:00-22:00 = 16 slot
        const dailySlots = day === 0 || day === 6 ? 16 : 14

        totalSlots += dailySlots * fieldCount
        currentDateLoop.setDate(currentDateLoop.getDate() + 1)
      }

      return totalSlots
    }

    const buildWhere = (startDate, endDate) => {
      const where = {
        AND: [
          {
            tanggalMain: {
              gte: startDate,
              lte: endDate,
            },
          },
          {
            OR: [
              {
                status: {
                  contains: "Payment Completed",
                },
              },
              {
                status: {
                  contains: "Manual/Walk-in",
                },
              },
            ],
          },
          {
            playTimeGroup: {
              in: ["Pagi", "Siang", "Malam"],
            },
          },
        ],
      }

      if (venue && venue !== "All Venue") {
        where.AND.push({
          lapangan: {
            contains: venue === "Basket" ? "Basket" : venue,
          },
        })
      }

      if (customerType && customerType !== "All Type") {
        if (customerType === "Membership") {
          where.AND.push({
            status: {
              contains: "Payment Completed",
            },
          })
        }

        if (customerType === "Non Membership") {
          where.AND.push({
            status: {
              contains: "Manual/Walk-in",
            },
          })
        }
      }

      return where
    }

    const getSafeMonthEndDate = (yearValue, monthIndex) => {
      const isCurrentYear = yearValue === currentYear
      const isCurrentMonth = monthIndex === currentMonthIndex

      // Kalau tahun dan bulan yang dipilih adalah bulan sekarang,
      // maka end date hanya sampai hari ini.
      if (isCurrentYear && isCurrentMonth) {
        return new Date(yearValue, monthIndex, currentDate, 23, 59, 59, 999)
      }

      // Kalau bulan sudah lewat atau tahun sebelumnya, pakai full month.
      return new Date(yearValue, monthIndex + 1, 0, 23, 59, 59, 999)
    }

    const getLastVisibleMonthIndex = () => {
      // Kalau tahun yang dipilih adalah tahun sekarang,
      // jangan tampilkan bulan setelah bulan hari ini.
      if (selectedYear === currentYear) {
        return currentMonthIndex
      }

      // Kalau tahun sebelumnya, tampilkan sampai Dec.
      if (selectedYear < currentYear) {
        return 11
      }

      // Kalau tahun masa depan, tidak ada data real.
      return -1
    }

    const fieldCount = getFieldCount(venue)
    let trendPeriods = []

    // CASE 1:
    // Month dipilih + MTD
    // Contoh:
    // Apr 2025 MTD -> daily 1 Apr - 30 Apr
    // Jun 2026 MTD -> daily 1 Jun - today
    if (month !== "All Month" && periodType === "MTD") {
      const monthIndex = monthMap[month]

      if (monthIndex === undefined) {
        return res.status(400).json({
          success: false,
          message: "Invalid month.",
        })
      }

      const endDate = getSafeMonthEndDate(selectedYear, monthIndex)

      const lastDay = endDate.getDate()

      trendPeriods = Array.from({ length: lastDay }, (_, index) => {
        const day = index + 1

        const startDate = new Date(selectedYear, monthIndex, day)
        const dailyEndDate = new Date(
          selectedYear,
          monthIndex,
          day,
          23,
          59,
          59,
          999
        )

        return {
          label: `${day} ${month}`,
          date: `${selectedYear}-${String(monthIndex + 1).padStart(
            2,
            "0"
          )}-${String(day).padStart(2, "0")}`,
          startDate,
          endDate: dailyEndDate,
        }
      })
    }

    // CASE 2:
    // Month dipilih + YTD
    // Contoh:
    // Apr 2025 YTD -> Jan, Jan-Feb, Jan-Mar, Jan-Apr
    // Jun 2026 YTD -> Jan, Jan-Feb, ..., Jan-today
    if (month !== "All Month" && periodType === "YTD") {
      const selectedMonthIndex = monthMap[month]

      if (selectedMonthIndex === undefined) {
        return res.status(400).json({
          success: false,
          message: "Invalid month.",
        })
      }

      const maxMonthIndex =
        selectedYear === currentYear
          ? Math.min(selectedMonthIndex, currentMonthIndex)
          : selectedMonthIndex

      trendPeriods = monthNames
        .slice(0, maxMonthIndex + 1)
        .map((monthName, monthIndex) => {
          const startDate = new Date(selectedYear, 0, 1)
          const endDate = getSafeMonthEndDate(selectedYear, monthIndex)

          return {
            label: monthName,
            month: monthName,
            startDate,
            endDate,
          }
        })
    }

    // CASE 3:
    // All Month + MTD
    // Contoh:
    // 2025 -> monthly Jan-Dec, per bulan berdiri sendiri
    // 2026 -> monthly Jan sampai bulan today, bulan today sampai today
    if (month === "All Month" && periodType === "MTD") {
      const lastMonthIndex = getLastVisibleMonthIndex()

      if (lastMonthIndex < 0) {
        trendPeriods = []
      } else {
        trendPeriods = monthNames
          .slice(0, lastMonthIndex + 1)
          .map((monthName, monthIndex) => {
            const startDate = new Date(selectedYear, monthIndex, 1)
            const endDate = getSafeMonthEndDate(selectedYear, monthIndex)

            return {
              label: monthName,
              month: monthName,
              startDate,
              endDate,
            }
          })
      }
    }

    // CASE 4:
    // All Month + YTD
    // Contoh:
    // 2025 -> Jan, Jan-Feb, ..., Jan-Dec
    // 2026 -> Jan, Jan-Feb, ..., Jan-today
    if (month === "All Month" && periodType === "YTD") {
      const lastMonthIndex = getLastVisibleMonthIndex()

      if (lastMonthIndex < 0) {
        trendPeriods = []
      } else {
        trendPeriods = monthNames
          .slice(0, lastMonthIndex + 1)
          .map((monthName, monthIndex) => {
            const startDate = new Date(selectedYear, 0, 1)
            const endDate = getSafeMonthEndDate(selectedYear, monthIndex)

            return {
              label: monthName,
              month: monthName,
              startDate,
              endDate,
            }
          })
      }
    }

    const trend = await Promise.all(
      trendPeriods.map(async (period) => {
        const where = buildWhere(period.startDate, period.endDate)

        const bookedSessions = await prisma.facilityTransaction.count({
          where,
        })

        const availableSessions = getAvailableSessions(
          period.startDate,
          period.endDate,
          fieldCount
        )

        const rate =
          availableSessions > 0
            ? (bookedSessions / availableSessions) * 100
            : 0

        return {
          label: period.label,
          month: period.month,
          date: period.date,
          bookedSessions,
          availableSessions,
          rate: Number(rate.toFixed(1)),
        }
      })
    )

    return res.json({
      success: true,
      message: "Occupancy trend fetched successfully.",
      data: trend,
    })
  } catch (error) {
    next(error)
  }
})
})
