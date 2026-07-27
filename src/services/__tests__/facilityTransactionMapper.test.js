import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCourtHourUsageEntries,
  mapRawRowToFacilityTransaction,
  mapRawRowToFacilityTransactionResult,
} from "../facilityTransactionMapper.js"

const buildRow = (overrides = {}) => ({
  "Order ID": "ORD-001",
  Nama: "John Doe",
  Email: "john@example.com",
  "Tanggal Transaksi": "24-Jun-2026",
  "Tanggal Main": "25-Jun-2026",
  "Jam Main": "08:00 - 10:00",
  Lapangan: "Mini Soccer A",
  Status: "Payment Completed",
  "Harga Bersih": "300000",
  "Harga Add Ons": "0",
  "Customer Profile": "member",
  ...overrides,
})

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

  assert.equal(transaction.customerIdentity, "EMAIL|john.doe@example.com")
  assert.equal(transaction.bookingType, "membership")
  assert.equal(transaction.validBooking, true)
  assert.equal(transaction.courtType, "mini_soccer")
  assert.equal(transaction.netRevenue, 350000)
  assert.equal(transaction.durationHours, 2)
  assert.equal(transaction.playTimeGroup, "Pagi")
})

test("positive completed payments are accepted as customer transactions", () => {
  const result = mapRawRowToFacilityTransactionResult(buildRow(), 5, 1, 10)

  assert.equal(result.outcome, "customer")
  assert.equal(result.payload.customerIdentity, "EMAIL|john@example.com")
  assert.equal(result.payload.bookingType, "membership")
})

for (const [label, status, revenue] of [
  ["zero completed payment", "Payment Completed", "0"],
  ["negative completed payment", "Payment Completed", "-1000"],
  ["zero manual booking", "Manual/Walk-in", "0"],
  ["empty completed payment", "Payment Completed", ""],
  ["invalid completed payment", "Payment Completed", "not-money"],
]) {
  test(`${label} is intentionally skipped during cleaning`, () => {
    const result = mapRawRowToFacilityTransactionResult(
      buildRow({ Status: status, "Harga Bersih": revenue }),
      5,
      1,
      10
    )

    assert.deepEqual(result, {
      outcome: "skipped",
      reason: "non_positive_or_invalid_customer_revenue",
      payload: null,
    })
  })
}

test("Internal without customer details is accepted as an operational row", () => {
  const result = mapRawRowToFacilityTransactionResult(
    buildRow({
      Nama: "",
      Email: "",
      "No. Telepon": "",
      Status: "Internal",
      "Harga Bersih": "0",
    }),
    5,
    1,
    10
  )

  assert.equal(result.outcome, "operational")
  assert.equal(result.payload.customerIdentity, "STATUS|INTERNAL")
  assert.equal(result.payload.customerKey, "SYS-INTERNAL")
  assert.equal(result.payload.customerId, null)
  assert.equal(result.payload.validBooking, true)
  assert.equal(
    buildCourtHourUsageEntries({
      ...result.payload,
      id: 99,
    }).length,
    2
  )
})

test("Tutup and Maintenance receive distinct canonical operational identities", () => {
  const tutup = mapRawRowToFacilityTransaction(
    buildRow({ Nama: "", Email: "", Status: "Tutup", "Harga Bersih": "0" }),
    5,
    1,
    10
  )
  const maintenance = mapRawRowToFacilityTransaction(
    buildRow({ Nama: "", Email: "", Status: "Maintenance", "Harga Bersih": "0" }),
    5,
    2,
    11
  )

  assert.equal(tutup.customerIdentity, "STATUS|TUTUP")
  assert.equal(tutup.customerKey, "SYS-TUTUP")
  assert.equal(maintenance.customerIdentity, "STATUS|MAINTENANCE")
  assert.equal(maintenance.customerKey, "SYS-MAINTENANCE")
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

test("the same physical court hour produces the same occupancy deduplication key", () => {
  const transaction = {
    id: 101,
    batchId: 10,
    playDate: new Date("2026-06-25T00:00:00.000Z"),
    startHour: "08:00",
    endHour: "09:00",
    durationHours: 1,
    court: "Basketball",
    courtType: "basketball",
    validBooking: true,
    netRevenue: 0,
  }
  const first = buildCourtHourUsageEntries(transaction)
  const second = buildCourtHourUsageEntries({ ...transaction, id: 102 })

  assert.equal(first[0].courtHourKey, second[0].courtHourKey)
})
