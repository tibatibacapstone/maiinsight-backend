import test from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"

import {
  detectOrderIdAnomalies,
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

test("one invalid field returns exactly one validation error", () => {
  assert.throws(
    () => validateTransactionRows([{ ...buildRecord(), "Tanggal Transaksi": "not-a-date" }]),
    (error) => {
      assert.equal(error.validationErrors.length, 1)
      assert.equal(error.validationErrors[0].rowNumber, 2)
      assert.equal(error.validationErrors[0].column, "Tanggal Transaksi")
      assert.equal(
        error.validationErrors[0].message,
        "Invalid date format. Transaction date must contain a valid date."
      )
      return true
    }
  )
})

test("collects invalid fields from different source rows with Excel row numbers", () => {
  const records = [
    { ...buildRecord(), "Tanggal Transaksi": "aaaaaaa" },
    { ...buildRecord(), "Harga Bersih": "bbbbb" },
    { ...buildRecord(), "Jam Main": "evening" },
  ]

  assert.throws(
    () => validateTransactionRows(records),
    (error) => {
      assert.equal(error.errorCode, "INVALID_ROW_DATA")
      assert.deepEqual(
        error.validationErrors.map(({ rowNumber, column }) => ({ rowNumber, column })),
        [
          { rowNumber: 2, column: "Tanggal Transaksi" },
          { rowNumber: 3, column: "Harga Bersih" },
          { rowNumber: 4, column: "Jam Main" },
        ]
      )
      return true
    }
  )
})

test("collects multiple field errors from the same row", () => {
  assert.throws(
    () =>
      validateTransactionRows([
        {
          ...buildRecord(),
          "Tanggal Transaksi": "aaaaaaa",
          "Harga Bersih": "bbbbb",
        },
      ]),
    (error) => {
      assert.equal(error.validationErrors.length, 2)
      assert.ok(error.validationErrors.every((item) => item.rowNumber === 2))
      assert.deepEqual(
        error.validationErrors.map(({ column, message, value }) => ({ column, message, value })),
        [
          {
            column: "Tanggal Transaksi",
            message: "Invalid date format. Transaction date must contain a valid date.",
            value: "aaaaaaa",
          },
          {
            column: "Harga Bersih",
            message: "Invalid numeric value. Net revenue must be a valid number.",
            value: "bbbbb",
          },
        ]
      )
      return true
    }
  )
})

test("collects invalid date and invalid optional numeric value together", () => {
  assert.throws(
    () =>
      validateTransactionRows([
        {
          ...buildRecord(),
          "Tanggal Main": "invalid-date",
          "Harga Add Ons Bersih": "invalid-amount",
        },
      ]),
    (error) => {
      assert.deepEqual(
        error.validationErrors.map((item) => item.column),
        ["Tanggal Main", "Harga Add Ons Bersih"]
      )
      return true
    }
  )
})

test("does not truncate validation errors from large invalid files", () => {
  const records = Array.from({ length: 60 }, () => ({
    ...buildRecord(),
    "Tanggal Transaksi": "invalid-date",
  }))

  assert.throws(
    () => validateTransactionRows(records),
    (error) => {
      assert.equal(error.validationErrors.length, 60)
      assert.equal(error.validationErrors.at(-1).rowNumber, 61)
      return true
    }
  )
})

test("valid rows return no validation errors and continue normally", () => {
  assert.equal(validateTransactionRows([buildRecord(), buildRecord()]), true)
})

test("empty transaction date reports only its required-value reason", () => {
  assert.throws(
    () => validateTransactionRows([{ ...buildRecord(), "Tanggal Transaksi": "" }]),
    (error) => {
      assert.deepEqual(error.validationErrors, [
        {
          rowNumber: 2,
          column: "Tanggal Transaksi",
          value: null,
          message: "Transaction date is required and cannot be empty.",
        },
      ])
      return true
    }
  )
})

test("empty customer net revenue reports only its required-value reason", () => {
  assert.throws(
    () => validateTransactionRows([{ ...buildRecord(), "Harga Bersih": "" }]),
    (error) => {
      assert.deepEqual(error.validationErrors, [
        {
          rowNumber: 2,
          column: "Harga Bersih",
          value: null,
          message: "Net revenue is required and cannot be empty.",
        },
      ])
      return true
    }
  )
})

test("present malformed values retain their raw values and exact format reasons", () => {
  assert.throws(
    () =>
      validateTransactionRows([
        { ...buildRecord(), "Tanggal Transaksi": "aaaaaaa" },
        { ...buildRecord(), "Harga Bersih": "bbbbb" },
      ]),
    (error) => {
      assert.deepEqual(
        error.validationErrors.map(({ rowNumber, column, value, message }) => ({
          rowNumber,
          column,
          value,
          message,
        })),
        [
          {
            rowNumber: 2,
            column: "Tanggal Transaksi",
            value: "aaaaaaa",
            message: "Invalid date format. Transaction date must contain a valid date.",
          },
          {
            rowNumber: 3,
            column: "Harga Bersih",
            value: "bbbbb",
            message: "Invalid numeric value. Net revenue must be a valid number.",
          },
        ]
      )
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

test("detectOrderIdAnomalies flags Payment Completed without Order ID and Manual/Walk-in with Order ID", () => {
  const result = detectOrderIdAnomalies([
    { "Order ID": "ORD-001", Nama: "A", Status: "Payment Completed" },
    { "Order ID": "", Nama: "B", Status: "Payment Completed" },
    { "Order ID": "ORD-002", Nama: "C", Status: "Manual/Walk-in" },
    { "Order ID": "", Nama: "D", Status: "Manual/Walk-in" },
    { Nama: "E", Status: "Internal" },
    { Nama: "F", Status: "Tutup" },
    { Nama: "G", Status: "Maintenance" },
    { Nama: "H", Status: "Random Unknown" },
  ])

  assert.equal(result.paymentCompletedWithoutOrderId, 1)
  assert.equal(result.manualWalkInWithOrderId, 1)
  assert.equal(result.anomalies.length, 2)
  assert.equal(result.anomalies[0].type, "payment_completed_without_order_id")
  assert.equal(result.anomalies[0].rowNumber, 3)
  assert.equal(result.anomalies[0].customerName, "B")
  assert.equal(result.anomalies[0].orderId, null)
  assert.equal(result.anomalies[1].type, "manual_walk_in_with_order_id")
  assert.equal(result.anomalies[1].rowNumber, 4)
  assert.equal(result.anomalies[1].customerName, "C")
  assert.equal(result.anomalies[1].orderId, "ORD-002")
})

test("detectOrderIdAnomalies returns no anomalies for a clean file", () => {
  const result = detectOrderIdAnomalies([
    { "Order ID": "ORD-001", Nama: "A", Status: "Payment Completed" },
    { "Order ID": "", Nama: "D", Status: "Manual/Walk-in" },
  ])

  assert.equal(result.paymentCompletedWithoutOrderId, 0)
  assert.equal(result.manualWalkInWithOrderId, 0)
  assert.equal(result.anomalies.length, 0)
})
