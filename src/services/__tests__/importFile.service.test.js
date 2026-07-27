import test from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"

import {
  isSupportedImportFile,
  parseUploadedTransactionFile,
  validateTransactionRows,
  validateTransactionTemplate,
} from "../importFile.service.js"

const buildRecord = () => ({
  "Order ID": "ORD-001",
  Nama: "Jane Doe",
  Email: "jane@example.com",
  "No. Telepon": "08123456789",
  "Customer Profile": "Member",
  "Tanggal Transaksi": "2026-06-01",
  "Tanggal Main": "2026-06-02",
  "Jam Main": "08:00 - 09:00",
  Venue: "Maiin Club",
  Lapangan: "Court 1",
  "Harga Bersih": "100000",
  "Harga Add Ons Bersih": "15000",
  Status: "Payment Completed",
})

const buildUploadFile = ({ name, mimeType, buffer }) => ({
  originalname: name,
  mimetype: mimeType,
  buffer,
})

const buildWorkbookBuffer = (bookType) => {
  const worksheet = XLSX.utils.json_to_sheet([buildRecord()])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, "Transactions")

  return XLSX.write(workbook, { type: "buffer", bookType })
}

test("supports csv uploads and preserves csv parsing", () => {
  const csv = [
    "Order ID,Nama,Email,No. Telepon,Customer Profile,Tanggal Transaksi,Tanggal Main,Jam Main,Venue,Lapangan,Harga Bersih,Harga Add Ons Bersih,Status",
    "ORD-001,Jane Doe,jane@example.com,08123456789,Member,2026-06-01,2026-06-02,08:00 - 09:00,Maiin Club,Court 1,100000,15000,Payment Completed",
  ].join("\n")

  const file = buildUploadFile({
    name: "transactions.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  })

  assert.equal(isSupportedImportFile(file), true)

  const records = parseUploadedTransactionFile(file)
  const headers = validateTransactionTemplate(records)

  assert.equal(records.length, 1)
  assert.equal(records[0].Nama, "Jane Doe")
  assert.ok(headers.includes("Order ID"))
})

test("supports xlsx uploads by parsing the first worksheet", () => {
  const file = buildUploadFile({
    name: "transactions.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: buildWorkbookBuffer("xlsx"),
  })

  const records = parseUploadedTransactionFile(file)
  const headers = validateTransactionTemplate(records)

  assert.equal(records.length, 1)
  assert.equal(records[0].Venue, "Maiin Club")
  assert.ok(headers.includes("Tanggal Main"))
})

test("supports xls uploads", () => {
  const file = buildUploadFile({
    name: "transactions.xls",
    mimeType: "application/vnd.ms-excel",
    buffer: buildWorkbookBuffer("biff8"),
  })

  const records = parseUploadedTransactionFile(file)
  validateTransactionTemplate(records)

  assert.equal(records.length, 1)
  assert.equal(records[0].Status, "Payment Completed")
})

test("rejects unsupported file types with a business-friendly error", () => {
  const file = buildUploadFile({
    name: "transactions.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("plain text", "utf8"),
  })

  assert.throws(
    () => parseUploadedTransactionFile(file),
    (error) => {
      assert.equal(error.errorCode, "UNSUPPORTED_FILE_TYPE")
      assert.match(error.message, /supports CSV and Excel/i)
      return true
    }
  )
})

test("rejects invalid templates when required columns are missing", () => {
  const records = [
    {
      Nama: "Jane Doe",
      Email: "jane@example.com",
    },
  ]

  assert.throws(
    () => validateTransactionTemplate(records),
    (error) => {
      assert.equal(error.errorCode, "INVALID_TEMPLATE")
      assert.match(error.message, /required MaiinSight transaction template/i)
      return true
    }
  )
})

test("existing templates do not require generated identity or booking columns", () => {
  const record = buildRecord()
  const headers = validateTransactionTemplate([record])

  assert.equal(headers.includes("customerIdentity"), false)
  assert.equal(headers.includes("customerKey"), false)
  assert.equal(headers.includes("bookingEventKey"), false)
})

test("invalid play dates and times retain row-numbered validation reasons", () => {
  assert.throws(
    () =>
      validateTransactionRows([
        {
          ...buildRecord(),
          "Tanggal Main": "not-a-date",
          "Jam Main": "evening",
        },
      ]),
    (error) => {
      assert.equal(error.errorCode, "INVALID_ROW_DATA")
      assert.ok(error.validationErrors.some((item) => item.rowNumber === 2))
      assert.ok(error.validationErrors.some((item) => item.column === "Tanggal Main"))
      assert.ok(error.validationErrors.some((item) => item.column === "Jam Main"))
      return true
    }
  )
})

test("zero-revenue customer rows do not require identity during validation", () => {
  assert.equal(
    validateTransactionRows([
      {
        ...buildRecord(),
        Nama: "",
        Email: "",
        "No. Telepon": "",
        "Harga Bersih": "0",
      },
    ]),
    true
  )
})

test("positive customer rows without identity retain the row-level customer error", () => {
  assert.throws(
    () =>
      validateTransactionRows([
        {
          ...buildRecord(),
          Nama: "",
          Email: "",
          "No. Telepon": "",
          "Harga Bersih": "100000",
        },
      ]),
    (error) => {
      const customerError = error.validationErrors.find((item) => item.column === "Customer")
      assert.equal(error.errorCode, "INVALID_ROW_DATA")
      assert.equal(customerError.rowNumber, 2)
      assert.match(customerError.message, /usable identity/i)
      return true
    }
  )
})

test("operational rows allow zero revenue and missing customer details", () => {
  assert.equal(
    validateTransactionRows([
      {
        ...buildRecord(),
        Nama: "",
        Email: "",
        "No. Telepon": "",
        Status: "Internal",
        "Harga Bersih": "",
      },
    ]),
    true
  )
})
