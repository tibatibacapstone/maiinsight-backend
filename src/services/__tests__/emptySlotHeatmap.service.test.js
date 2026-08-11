import test from "node:test"
import assert from "node:assert/strict"

import {
  buildEmptySlotHeatmap,
  getHeatmapSessionNameByHour,
} from "../emptySlotHeatmap.service.js"

const monday = new Date(2025, 0, 6, 12)

const usage = ({ key, status, hour = "06:00", courtType = "basketball" }) => ({
  courtHourKey: key,
  courtType,
  playDate: monday,
  hourStart: hour,
  transaction: { status },
})

const build = (usageRows, courtCount = 2) =>
  buildEmptySlotHeatmap({
    usageRows,
    startDate: monday,
    endDate: monday,
    courtCount,
  })

const getMondaySix = (result) =>
  result.slots.find((slot) => slot.day_short === "Mon" && slot.startHour === "06:00")

test("customer occupancy excludes Internal capacity from the denominator", () => {
  const cell = getMondaySix(
    build([
      usage({ key: "customer", status: "Payment Completed" }),
      usage({ key: "internal", status: "Internal", courtType: "mini_soccer" }),
    ])
  )

  assert.equal(cell.grossCapacity, 2)
  assert.equal(cell.totalPossibleSlots, 1)
  assert.equal(cell.occupiedSlots, 1)
  assert.equal(cell.internalSessions, 1)
  assert.equal(cell.emptySlots, 0)
  assert.equal(cell.occupancyRate, 100)
  assert.equal(cell.emptyRate, 0)
  assert.equal(cell.internalRate, 0.5)
  assert.equal(cell.session_count, cell.emptySessions)
})

test("Internal is reported separately from blocked and maintenance capacity", () => {
  for (const status of ["Internal", "Tutup", "Maintenance", "Tutup/Maintenance"]) {
    const cell = getMondaySix(build([usage({ key: status, status })]))
    assert.equal(cell.internalSessions, status === "Internal" ? 1 : 0, status)
    assert.equal(cell.blockedSlots, status === "Internal" ? 0 : 1, status)
    assert.equal(cell.totalPossibleSlots, 1, status)
    assert.equal(cell.emptySlots, 1, status)
  }
})

test("a repeated physical court-hour is counted only once", () => {
  const cell = getMondaySix(
    build([
      usage({ key: "same-slot", status: "Internal" }),
      usage({ key: "same-slot", status: "Maintenance" }),
    ])
  )

  assert.equal(cell.internalSessions, 1)
  assert.equal(cell.blockedSlots, 0)
  assert.equal(cell.emptySlots, 1)
})

test("zero-capacity rates are safe", () => {
  const cell = getMondaySix(build([], 0))
  assert.equal(cell.totalPossibleSlots, 0)
  assert.equal(cell.occupancyRate, null)
  assert.equal(cell.emptyRate, null)
  assert.equal(cell.internalRate, 0)
})

test("twelve Mondays aggregate five occupied slots into 41.6667 percent occupancy", () => {
  const startDate = new Date(2026, 0, 5, 12)
  const endDate = new Date(2026, 2, 23, 12)
  const usageRows = Array.from({ length: 5 }, (_, index) => {
    const playDate = new Date(startDate)
    playDate.setDate(playDate.getDate() + index * 7)
    return { ...usage({ key: `monday-${index}`, status: "Payment Completed" }), playDate }
  })
  const cell = getMondaySix(buildEmptySlotHeatmap({ usageRows, startDate, endDate, courtCount: 1 }))

  assert.equal(cell.totalPossibleSlots, 12)
  assert.equal(cell.occupiedSlots, 5)
  assert.equal(cell.emptySlots, 7)
  assert.ok(Math.abs(cell.occupancyRate - 41.6666666667) < 0.000001)
})

test("twelve Mondays across two courts provide 24 slots and 62.5 percent occupancy", () => {
  const startDate = new Date(2026, 0, 5, 12)
  const endDate = new Date(2026, 2, 23, 12)
  const usageRows = Array.from({ length: 15 }, (_, index) => {
    const mondayIndex = Math.floor(index / 2)
    const courtIndex = index % 2
    const playDate = new Date(startDate)
    playDate.setDate(playDate.getDate() + mondayIndex * 7)
    return {
      ...usage({ key: `monday-${mondayIndex}-court-${courtIndex}`, status: "Payment Completed" }),
      playDate,
      court: courtIndex === 0 ? "Basketball" : "Mini Soccer",
    }
  })
  const cell = getMondaySix(buildEmptySlotHeatmap({ usageRows, startDate, endDate, courtCount: 2 }))

  assert.equal(cell.totalPossibleSlots, 24)
  assert.equal(cell.occupiedSlots, 15)
  assert.equal(cell.emptySlots, 9)
  assert.equal(cell.occupancyRate, 62.5)
})

test("session boundaries remain Morning 06-10, Afternoon 11-14, Evening 15-18, Night 19-23", () => {
  assert.equal(getHeatmapSessionNameByHour("06:00"), "Morning")
  assert.equal(getHeatmapSessionNameByHour("10:00"), "Morning")
  assert.equal(getHeatmapSessionNameByHour("11:00"), "Afternoon")
  assert.equal(getHeatmapSessionNameByHour("14:00"), "Afternoon")
  assert.equal(getHeatmapSessionNameByHour("15:00"), "Evening")
  assert.equal(getHeatmapSessionNameByHour("18:00"), "Evening")
  assert.equal(getHeatmapSessionNameByHour("19:00"), "Night")
  assert.equal(getHeatmapSessionNameByHour("23:00"), "Night")
})
