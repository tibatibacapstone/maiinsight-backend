import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCourtHourUsageEntries,
  mapRawRowToFacilityTransaction,
} from "../facilityTransactionMapper.js"

test("mapRawRowToFacilityTransaction builds canonical booking fields", () => {
  const transaction = mapRawRowToFacilityTransaction(
    {
      "Order ID": "ORD-001",
      Nama: "John Doe",
      Email: "John.Doe@example.com",
      "Tanggal Transaksi": "24-Jun-2026",
      "Tanggal Main": "25-Jun-2026",
      "Jam Main": "08:00 - 10:00",
      Lapangan: "Mini Soccer A",
      Status: "Payment Completed",
      "Harga Bersih": "300000",
      "Harga Add Ons": "50000",
      "Customer Profile": "member",
    },
    5,
    1,
    10
  )

  assert.equal(transaction.customerKey, "EMAIL:john.doe@example.com")
  assert.equal(transaction.bookingType, "regular_booking")
  assert.equal(transaction.validBooking, true)
  assert.equal(transaction.courtType, "mini_soccer")
  assert.equal(transaction.netRevenue, 350000)
  assert.equal(transaction.durationHours, 2)
  assert.equal(transaction.playTimeGroup, "Pagi")
})

test("buildCourtHourUsageEntries expands one transaction into hourly occupancy rows", () => {
  const entries = buildCourtHourUsageEntries({
    id: 7,
    batchId: 5,
    playDate: new Date("2026-06-25T00:00:00.000Z"),
    startHour: "08:00",
    endHour: "10:00",
    durationHours: 2,
    court: "Mini Soccer",
    courtType: "mini_soccer",
    validBooking: true,
    netRevenue: 400000,
  })

  assert.equal(entries.length, 2)
  assert.equal(entries[0].hourStart, "08:00")
  assert.equal(entries[1].hourStart, "09:00")
  assert.equal(entries[0].hourlyRevenue, 200000)
})
