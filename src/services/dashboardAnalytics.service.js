import { prisma } from "../config/prisma.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPERATING_HOURS_PER_DAY = 18; // 06:00 to 00:00
const COURT_TYPES = {
  all: null,
  mini_soccer: "mini_soccer",
  basketball: "basketball",
};
const BOOKING_TYPES = {
  all: null,
  regular_booking: "regular_booking",
  member_internal_booking: "member_internal_booking",
};

const toNumber = (value) => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
};

const startOfMonthUTC = (year, monthIndex) => new Date(Date.UTC(year, monthIndex, 1));
const endOfMonthUTC = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 1));
const startOfYearUTC = (year) => new Date(Date.UTC(year, 0, 1));

const getPeriodRange = ({ month, year, periodType }) => {
  const now = new Date();
  const normalizedYear = Number.isInteger(Number(year)) ? Number(year) : now.getUTCFullYear();
  const normalizedMonth = Number.isInteger(Number(month)) ? Number(month) : now.getUTCMonth() + 1;
  const monthIndex = Math.min(Math.max(normalizedMonth - 1, 0), 11);

  const monthStart = startOfMonthUTC(normalizedYear, monthIndex);
  const monthEnd = endOfMonthUTC(normalizedYear, monthIndex);

  if (String(periodType).toUpperCase() === "YTD") {
    return {
      start: startOfYearUTC(normalizedYear),
      end: monthEnd,
      year: normalizedYear,
      month: monthIndex + 1,
    };
  }

  return {
    start: monthStart,
    end: monthEnd,
    year: normalizedYear,
    month: monthIndex + 1,
  };
};

const buildMonthSeries = (year) =>
  MONTH_NAMES.map((name, index) => ({
    month: name,
    revenue: 0,
    target: 0,
    occupancyRate: 0,
    miniSoccer: 0,
    basketball: 0,
    monthIndex: index + 1,
    year,
  }));

const buildHourlySeries = () =>
  Array.from({ length: OPERATING_HOURS_PER_DAY }, (_, index) => {
    const hour = `${String(index + 6).padStart(2, "0")}:00`;
    return { hour, occupiedCourtHours: 0, occupancyRate: 0 };
  });

const buildEmptyResponse = () => ({
  kpis: {
    revenue: 0,
    occupancyRate: 0,
    miniSoccerOccupancyRate: 0,
    basketballOccupancyRate: 0,
    lowSession: "No data",
    atRiskCustomer: 0,
  },
  revenueGap: {
    actualRevenue: 0,
    targetRevenue: 0,
    achievementRate: 0,
  },
  revenueTrend: buildMonthSeries(new Date().getUTCFullYear()).map(({ month, revenue, target }) => ({
    month,
    revenue,
    target,
  })),
  occupancyTrend: buildMonthSeries(new Date().getUTCFullYear()).map(({ month, occupancyRate, miniSoccer, basketball }) => ({
    month,
    occupancyRate,
    miniSoccer,
    basketball,
  })),
  bookingTypeDistribution: [
    { name: "Regular Booking", value: 0 },
    { name: "Member/Internal Booking", value: 0 },
  ],
  courtTypeDistribution: [
    { name: "Mini Soccer", value: 0 },
    { name: "Basketball", value: 0 },
  ],
  hourlyOccupancy: buildHourlySeries(),
});

const distinctCount = (items) => new Set(items).size;

export async function getDashboardAnalytics(params = {}) {
  const { start, end, year, month } = getPeriodRange(params);
  const courtTypeFilter = COURT_TYPES[params.courtType] ?? null;
  const bookingTypeFilter = BOOKING_TYPES[params.bookingType] ?? null;
  const monthSeries = buildMonthSeries(year);

  const transactionWhere = {
    validBooking: true,
    ...(bookingTypeFilter ? { bookingType: bookingTypeFilter } : {}),
    ...(start && end ? { playDate: { gte: start, lt: end } } : {}),
    ...(courtTypeFilter ? { courtType: courtTypeFilter } : {}),
  };

  const [transactions, courtHours] = await Promise.all([
    prisma.facilityTransaction.findMany({
      where: transactionWhere,
      select: {
        id: true,
        netRevenue: true,
        bookingType: true,
        courtType: true,
        playDate: true,
        playTime: true,
      },
      orderBy: { playDate: "asc" },
    }),
    prisma.courtHourUsage.findMany({
      where: {
        transaction: {
          validBooking: true,
          ...(bookingTypeFilter ? { bookingType: bookingTypeFilter } : {}),
          ...(start && end ? { playDate: { gte: start, lt: end } } : {}),
        },
        ...(courtTypeFilter ? { courtType: courtTypeFilter } : {}),
        ...(start && end ? { playDate: { gte: start, lt: end } } : {}),
      },
      select: {
        courtHourKey: true,
        courtType: true,
        hourStart: true,
        playDate: true,
        hourlyRevenue: true,
      },
    }),
  ]);

  if (transactions.length === 0 && courtHours.length === 0) {
    return buildEmptyResponse();
  }

  const selectedDays = Math.max(0, (end - start) / 86400000);
  const overallAvailableCourtHours = selectedDays * OPERATING_HOURS_PER_DAY * 2;
  const miniAvailableCourtHours = selectedDays * OPERATING_HOURS_PER_DAY;
  const basketballAvailableCourtHours = miniAvailableCourtHours;

  const revenue = transactions.reduce((sum, row) => sum + toNumber(row.netRevenue), 0);

  const courtHourKeys = courtHours.map((row) => row.courtHourKey);
  const occupiedCourtHours = distinctCount(courtHourKeys);
  const occupiedMini = distinctCount(courtHours.filter((row) => row.courtType === "mini_soccer").map((row) => row.courtHourKey));
  const occupiedBasketball = distinctCount(courtHours.filter((row) => row.courtType === "basketball").map((row) => row.courtHourKey));

  const occupancyRate = overallAvailableCourtHours > 0 ? (occupiedCourtHours / overallAvailableCourtHours) * 100 : 0;
  const miniSoccerOccupancyRate = miniAvailableCourtHours > 0 ? (occupiedMini / miniAvailableCourtHours) * 100 : 0;
  const basketballOccupancyRate = basketballAvailableCourtHours > 0 ? (occupiedBasketball / basketballAvailableCourtHours) * 100 : 0;

  const monthlyRevenue = new Map(monthSeries.map((entry) => [entry.monthIndex, 0]));
  const monthlyOccupied = new Map(monthSeries.map((entry) => [entry.monthIndex, { total: 0, mini: 0, basketball: 0 }]));

  for (const row of transactions) {
    if (!row.playDate) continue;
    const monthIndex = new Date(row.playDate).getUTCMonth() + 1;
    monthlyRevenue.set(monthIndex, monthlyRevenue.get(monthIndex) + toNumber(row.netRevenue));
  }

  for (const row of courtHours) {
    if (!row.playDate) continue;
    const monthIndex = new Date(row.playDate).getUTCMonth() + 1;
    const bucket = monthlyOccupied.get(monthIndex);
    if (!bucket) continue;
    bucket.total += 1;
    if (row.courtType === "mini_soccer") bucket.mini += 1;
    if (row.courtType === "basketball") bucket.basketball += 1;
  }

  const revenueTrend = monthSeries.map(({ month, monthIndex }) => ({
    month,
    revenue: monthlyRevenue.get(monthIndex) || 0,
    target: 0,
  }));

  const occupancyTrend = monthSeries.map(({ month, monthIndex }) => {
    const bucket = monthlyOccupied.get(monthIndex) || { total: 0, mini: 0, basketball: 0 };
    const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
    const overallAvailable = daysInMonth * OPERATING_HOURS_PER_DAY * 2;
    const miniAvailable = daysInMonth * OPERATING_HOURS_PER_DAY;
    return {
      month,
      occupancyRate: overallAvailable > 0 ? (bucket.total / overallAvailable) * 100 : 0,
      miniSoccer: miniAvailable > 0 ? (bucket.mini / miniAvailable) * 100 : 0,
      basketball: miniAvailable > 0 ? (bucket.basketball / miniAvailable) * 100 : 0,
    };
  });

  const bookingTypeDistribution = [
    {
      name: "Regular Booking",
      value: transactions.filter((row) => row.bookingType === "regular_booking").length,
    },
    {
      name: "Member/Internal Booking",
      value: transactions.filter((row) => row.bookingType === "member_internal_booking").length,
    },
  ];

  const courtTypeDistribution = [
    {
      name: "Mini Soccer",
      value: courtHours.filter((row) => row.courtType === "mini_soccer").length,
    },
    {
      name: "Basketball",
      value: courtHours.filter((row) => row.courtType === "basketball").length,
    },
  ];

  const hourlyBuckets = buildHourlySeries();
  for (const row of courtHours) {
    const index = Number.parseInt(String(row.hourStart).slice(0, 2), 10) - 6;
    if (Number.isInteger(index) && index >= 0 && index < hourlyBuckets.length) {
      hourlyBuckets[index].occupiedCourtHours += 1;
    }
  }
  for (const bucket of hourlyBuckets) {
    const availableForHour = selectedDays * 2;
    bucket.occupancyRate = availableForHour > 0 ? (bucket.occupiedCourtHours / availableForHour) * 100 : 0;
  }

  let lowSession = "No data";
  if (courtHours.length > 0) {
    const hourlyMin = hourlyBuckets.reduce(
      (lowest, current) => (current.occupiedCourtHours < lowest.occupiedCourtHours ? current : lowest),
      hourlyBuckets[0]
    );
    lowSession = hourlyMin.hour;
  }

  const targetRevenue = 0;
  const achievementRate = targetRevenue > 0 ? (revenue / targetRevenue) * 100 : 0;

  return {
    kpis: {
      revenue,
      occupancyRate,
      miniSoccerOccupancyRate,
      basketballOccupancyRate,
      lowSession,
      atRiskCustomer: 0,
    },
    revenueGap: {
      actualRevenue: revenue,
      targetRevenue,
      achievementRate,
    },
    revenueTrend,
    occupancyTrend,
    bookingTypeDistribution,
    courtTypeDistribution,
    hourlyOccupancy: hourlyBuckets,
  };
}
