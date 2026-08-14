import {
  CANONICAL_TRANSACTION_STATUSES,
  DASHBOARD_TRANSACTION_GROUPS,
  getDashboardTransactionGroup,
} from "./transactionStatus.service.js"

export const HEATMAP_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const HEATMAP_SESSION_DEFINITIONS = [
  { name: "Morning", startHour: 6, endHour: 10 },
  { name: "Afternoon", startHour: 11, endHour: 14 },
  { name: "Evening", startHour: 15, endHour: 18 },
  { name: "Night", startHour: 19, endHour: 23 },
]

export const getHeatmapSessionNameByHour = (hourValue) => {
  const hour = Number(String(hourValue ?? "").split(":")[0])
  if (!Number.isFinite(hour)) return null

  return (
    HEATMAP_SESSION_DEFINITIONS.find(
      (session) => hour >= session.startHour && hour <= session.endHour
    )?.name || null
  )
}

const getHeatmapDayLabel = (date) => {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
  }).format(date)
  return HEATMAP_DAY_LABELS.includes(weekday) ? weekday : null
}

const toCellKey = (dayLabel, hour) =>
  `${dayLabel}|${String(hour).padStart(2, "0")}:00`

export const buildEmptySlotHeatmap = ({
  usageRows,
  startDate,
  endDate,
  courtCount,
}) => {
  const capacityByCell = new Map()
  const cursor = new Date(startDate)
  cursor.setHours(0, 0, 0, 0)
  const last = new Date(endDate)
  last.setHours(0, 0, 0, 0)

  while (cursor.getTime() <= last.getTime()) {
    const dayLabel = getHeatmapDayLabel(cursor)
    if (dayLabel) {
      for (let hour = 6; hour <= 23; hour += 1) {
        const key = toCellKey(dayLabel, hour)
        capacityByCell.set(key, (capacityByCell.get(key) || 0) + courtCount)
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }

  const occupiedByCell = new Map()
  const internalByCell = new Map()
  const blockedByCell = new Map()
  const seenCourtHours = new Set()

  usageRows.forEach((row) => {
    if (!row.playDate || !row.hourStart) return

    const dayLabel = getHeatmapDayLabel(new Date(row.playDate))
    const hour = Number(String(row.hourStart).split(":")[0])
    if (!dayLabel || !Number.isFinite(hour) || hour < 6 || hour > 23) return

    const physicalSlotKey =
      row.courtHourKey ||
      `${new Date(row.playDate).toISOString()}|${row.hourStart}|${row.court || row.courtType || ""}`
    if (seenCourtHours.has(physicalSlotKey)) return
    seenCourtHours.add(physicalSlotKey)

    const cellKey = toCellKey(dayLabel, hour)
    const group = getDashboardTransactionGroup(row.transaction?.status)

    if (row.transaction?.status === CANONICAL_TRANSACTION_STATUSES.INTERNAL) {
      internalByCell.set(cellKey, (internalByCell.get(cellKey) || 0) + 1)
    } else if (group === DASHBOARD_TRANSACTION_GROUPS.TUTUP_MAINTENANCE) {
      blockedByCell.set(cellKey, (blockedByCell.get(cellKey) || 0) + 1)
    } else if (
      group === DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING ||
      group === DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN
    ) {
      occupiedByCell.set(cellKey, (occupiedByCell.get(cellKey) || 0) + 1)
    }
  })

  const slots = [...capacityByCell.entries()].map(([key, grossCapacity]) => {
    const [day_short, startHour] = key.split("|")
    const customerSlots = occupiedByCell.get(key) || 0
    const internalSessions = internalByCell.get(key) || 0
    const tutupSessions = blockedByCell.get(key) || 0
    const occupiedSlots = customerSlots + internalSessions
    const blockedSlots = tutupSessions
    const unavailableSlots = internalSessions + blockedSlots
    const totalPossibleSlots = Math.max(0, grossCapacity - blockedSlots)
    const emptySlots = Math.max(0, totalPossibleSlots - occupiedSlots)
    const occupancyRate = totalPossibleSlots > 0
      ? (occupiedSlots / totalPossibleSlots) * 100
      : null

    return {
      dayOfWeek: day_short,
      day_short,
      hour: startHour,
      startHour,
      session_count: emptySlots,
      session_label: getHeatmapSessionNameByHour(startHour),
      grossCapacity,
      totalCapacity: totalPossibleSlots,
      totalPossibleSlots,
      totalPossibleSessions: totalPossibleSlots,
      occupiedSlots,
      occupiedCustomerSessions: customerSlots,
      internalSessions,
      blockedSlots,
      tutupSessions,
      unavailableSlots,
      emptySlots,
      emptySessions: emptySlots,
      occupancyRate,
      emptyRate: totalPossibleSlots > 0 ? emptySlots / totalPossibleSlots : null,
      internalRate: grossCapacity > 0 ? internalSessions / grossCapacity : 0,
      tutupRate: grossCapacity > 0 ? tutupSessions / grossCapacity : 0,
    }
  })

  const mostEmpty = [...slots].sort((left, right) => {
    if (right.emptySlots !== left.emptySlots) {
      return right.emptySlots - left.emptySlots
    }
    if (left.startHour !== right.startHour) {
      return left.startHour.localeCompare(right.startHour)
    }
    return (
      HEATMAP_DAY_LABELS.indexOf(left.day_short) -
      HEATMAP_DAY_LABELS.indexOf(right.day_short)
    )
  })[0] || null

  return {
    slots,
    mostEmptySlot: mostEmpty
      ? {
          dayLabel: mostEmpty.day_short,
          hourLabel: mostEmpty.startHour,
          sessionLabel: mostEmpty.session_label,
          sessionCount: mostEmpty.emptySlots,
        }
      : null,
  }
}
