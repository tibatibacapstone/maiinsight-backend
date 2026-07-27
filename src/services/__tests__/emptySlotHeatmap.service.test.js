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

test("customer and operational slots reduce empty capacity separately", () => {
  const cell = getMondaySix(
    build([
      usage({ key: "customer", status: "Payment Completed" }),
      usage({ key: "internal", status: "Internal", courtType: "mini_soccer" }),
    ])
  )

  assert.equal(cell.totalCapacity, 2)
  assert.equal(cell.occupiedCustomerSessions, 1)
  assert.equal(cell.internalSessions, 1)
  assert.equal(cell.emptySessions, 0)
  assert.equal(cell.emptyRate, 0)
  assert.equal(cell.internalRate, 0.5)
  assert.equal(cell.session_count, cell.emptySessions)
})

test("Internal, Tutup, Maintenance, and combined status are operational", () => {
  for (const status of ["Internal", "Tutup", "Maintenance", "Tutup/Maintenance"]) {
    const cell = getMondaySix(build([usage({ key: status, status })]))
    assert.equal(cell.internalSessions, 1, status)
    assert.equal(cell.occupiedCustomerSessions, 0, status)
    assert.equal(cell.emptySessions, 1, status)
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
  assert.equal(cell.emptySessions, 1)
})

test("zero-capacity rates are safe", () => {
  const cell = getMondaySix(build([], 0))
  assert.equal(cell.totalCapacity, 0)
  assert.equal(cell.emptyRate, 0)
  assert.equal(cell.internalRate, 0)
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
