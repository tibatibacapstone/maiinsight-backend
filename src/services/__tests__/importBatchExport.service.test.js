import test from "node:test"
import assert from "node:assert/strict"

import {
  buildTransformedBatchColumns,
  buildTransformedBatchCsv,
  buildTransformedBatchRows,
  IMPORT_BATCH_PREVIEW_LIMIT,
  TRANSFORMED_EXPORT_COLUMNS,
} from "../importBatchExport.service.js"

const buildRawRow = (rowNumber) => ({
  id: rowNumber,
  batchId: 7,
  rowNumber,
  data: {
    Nama: `Customer ${rowNumber}`,
    Email: `customer${rowNumber}@example.com`,
    "Harga Bersih": rowNumber === 1 ? 0 : 100000,
    Deskripsi: rowNumber === 1 ? "Court, ball, and \"drinks\"" : "",
  },
  status: "processed",
  errorMessage: null,
})

const buildGeneratedTransaction = (rowNumber) => ({
  id: 10000 + rowNumber,
  batchId: 7,
  rawRowId: rowNumber,
  rowNumber,
  customerId: rowNumber,
  customerIdentity: `EMAIL|customer${rowNumber}@example.com`,
  customerKey: `CUST-${String(rowNumber).padStart(5, "0")}`,
  bookingEventKey: `SES-${rowNumber}`,
  bookingRangeKey: `RNG-${rowNumber}`,
  normalizedEmail: `customer${rowNumber}@example.com`,
  normalizedPhone: `812345${String(rowNumber).padStart(4, "0")}`,
  normalizedName: `CUSTOMER ${rowNumber}`,
  customerKeyType: "email",
  customerKeyConfidence: "high",
  transactionDate: new Date("2026-01-01T01:00:00.000Z"),
  playDate: new Date("2026-01-02T01:00:00.000Z"),
  startHour: "15:00",
  endHour: "16:00",
  durationHours: 1,
  playTimeGroup: "Siang",
  period: "2026-01",
  courtType: "basketball",
  status: "Selesai",
  bookingType: "non_membership",
  validBooking: true,
  netRevenue: rowNumber === 1 ? 0 : 100000,
  addOnRevenue: 0,
  voucherDiscount: null,
  promoName: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
})

test("preview limit remains 100 while full transformed export retains all 5,575 rows", () => {
  const rawRows = Array.from({ length: 5575 }, (_, index) => buildRawRow(index + 1))
  const transactions = Array.from(
    { length: 5575 },
    (_, index) => buildGeneratedTransaction(index + 1)
  )
  const transformedRows = buildTransformedBatchRows(rawRows, transactions)

  assert.equal(IMPORT_BATCH_PREVIEW_LIMIT, 100)
  assert.equal(transformedRows.length, 5575)
  assert.equal(transformedRows[0].rowNumber, 1)
  assert.equal(transformedRows.at(-1).rowNumber, 5575)
})

test("preview and download share the stable curated schema and transformed values", () => {
  const rawRows = [buildRawRow(1), buildRawRow(2)]
  const transactions = [buildGeneratedTransaction(1), buildGeneratedTransaction(2)]
  const rows = buildTransformedBatchRows(rawRows, transactions)
  const columns = buildTransformedBatchColumns()

  assert.deepEqual(columns, TRANSFORMED_EXPORT_COLUMNS)
  assert.equal(columns.length, 26)
  assert.equal(rows[0].data["Customer Identity"], transactions[0].customerIdentity)
  assert.equal(rows[0].data["Customer Key"], transactions[0].customerKey)
  assert.equal(rows[0].data["Customer Key Type"], transactions[0].customerKeyType)
  assert.equal(rows[0].data["Booking Event Key"], transactions[0].bookingEventKey)
  assert.equal(rows[0].data["Booking Range Key"], transactions[0].bookingRangeKey)
  assert.equal(rows[0].data["Booking Type"], transactions[0].bookingType)

  const csvLines = buildTransformedBatchCsv(columns, rows).split("\r\n")
  assert.equal(csvLines.length, 3)
  assert.equal(
    csvLines[0],
    ["Row", ...columns].map((column) => `"${column}"`).join(",")
  )
  assert.match(csvLines[1], /^"1","","Customer 1","customer1@example.com"/)
  assert.match(csvLines[1], /"0"/)
  assert.match(csvLines[1], /"Court, ball, and ""drinks"""/)
  assert.match(csvLines[2], /^"2","","Customer 2","customer2@example.com"/)
})

test("preview and export omit presentation-only technical calculation fields", () => {
  const transaction = buildGeneratedTransaction(1)
  const [row] = buildTransformedBatchRows([buildRawRow(1)], [transaction])
  const columns = buildTransformedBatchColumns()
  const hiddenColumns = [
    "Valid Booking",
    "Net Revenue",
    "Add-On Revenue",
    "Voucher Discount",
    "Promo Name",
    "Customer Key Confidence",
    "Normalized Name",
    "Normalized Email",
    "Normalized Phone",
    "Transaction Date",
    "Play Date",
    "Start Hour",
    "End Hour",
    "Duration Hours",
    "Play Time Group",
    "Period",
    "Court Type",
  ]

  for (const hiddenColumn of hiddenColumns) {
    assert.equal(columns.includes(hiddenColumn), false)
    assert.equal(Object.hasOwn(row.data, hiddenColumn), false)
  }

  const csvHeader = buildTransformedBatchCsv(columns, [row]).split("\r\n")[0]
  for (const hiddenColumn of hiddenColumns) assert.doesNotMatch(csvHeader, new RegExp(hiddenColumn))

  // Projection does not mutate or remove internal FacilityTransaction values.
  assert.equal(transaction.validBooking, true)
  assert.equal(transaction.netRevenue, 0)
  assert.equal(transaction.normalizedEmail, "customer1@example.com")
  assert.equal(transaction.startHour, "15:00")
  assert.equal(transaction.courtType, "basketball")
})

test("visible column order remains source-first followed by required lineage fields", () => {
  assert.deepEqual(buildTransformedBatchColumns(), [
    "Order ID",
    "Nama",
    "Email",
    "No. Telepon",
    "Customer Profile",
    "Tanggal Transaksi",
    "Tanggal Main",
    "Jam Main",
    "Venue",
    "Lapangan",
    "Status",
    "Harga Bersih",
    "Add Ons",
    "Harga Add Ons Bersih",
    "Tipe Voucher",
    "Harga Voucher",
    "Reschedule",
    "Promosi",
    "Keperluan Olahraga",
    "Deskripsi",
    "Customer Identity",
    "Customer Key",
    "Customer Key Type",
    "Booking Type",
    "Booking Event Key",
    "Booking Range Key",
  ])
})

test("curated schema removes confirmed source and mapped aliases", () => {
  const columns = buildTransformedBatchColumns()
  const removedAliases = [
    "orderId",
    "customerName",
    "nama",
    "email",
    "noTelepon",
    "customerProfile",
    "tanggalTransaksi",
    "tanggalMain",
    "jamMain",
    "playTime",
    "addOns",
    "venue",
    "court",
    "lapangan",
    "hargaBersih",
    "hargaAddOns",
    "hargaVoucher",
    "tipeVoucher",
    "promosi",
    "sportPurpose",
    "keperluan",
    "description",
    "deskripsi",
    "rawData",
  ]

  for (const alias of removedAliases) assert.equal(columns.includes(alias), false)
  assert.equal(columns.filter((column) => column === "Nama").length, 1)
  assert.equal(columns.filter((column) => column === "Harga Bersih").length, 1)
})
