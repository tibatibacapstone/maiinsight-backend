import { parse as parseCsv } from "csv-parse/sync"
import * as XLSX from "xlsx"
import { buildCustomerIdentity } from "./transactionFeatureEngineering.service.js"
import {
  classifyTransactionRevenue,
  classifyTransactionStatus,
  parseTransactionAmount,
  TRANSACTION_ROW_CATEGORIES,
} from "./transactionStatus.service.js"

const SUPPORTED_UPLOAD_EXTENSIONS = [".csv", ".xlsx", ".xls"]
const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
])

const REQUIRED_COLUMN_GROUPS = [
  ["Order ID", "Order Id", "order_id", "orderId"],
  ["Nama", "nama", "Customer Name", "customer_name", "customerName", "Team", "team"],
  ["Email", "email", "normalizedEmail"],
  [
    "No. Telep",
    "No Telep",
    "No. Telepon",
    "No Telepon",
    "no_telepon",
    "Phone",
    "phone",
    "No HP",
    "No. HP",
    "normalizedPhone",
  ],
  ["Customer Profile", "customer_profile", "customerProfile"],
  ["Tanggal Transaksi", "tanggal_transaksi", "tanggalTransaksi", "transactionDate"],
  ["Tanggal Main", "tanggal_main", "tanggalMain", "playDate"],
  ["Jam Main", "jam_main", "jamMain", "playTime"],
  ["Venue", "venue"],
  ["Lapangan", "lapangan", "Court", "court"],
  ["Harga Bersih", "harga_bersih", "hargaBersih", "netRevenue"],
  [
    "Harga Add Ons Bersih",
    "harga_add_ons_bersih",
    "hargaAddOnsBersih",
    "Harga Add Ons",
    "harga_add_ons",
    "hargaAddOns",
  ],
  ["Status", "status"],
]

const normalizeHeader = (value) => String(value ?? "").trim().toLowerCase()

const normalizeCell = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const getFileExtension = (fileName = "") => {
  const lowerName = String(fileName).toLowerCase()
  const matchedExtension = SUPPORTED_UPLOAD_EXTENSIONS.find((extension) =>
    lowerName.endsWith(extension)
  )

  return matchedExtension || null
}

const getRowValue = (row, aliases) => {
  for (const alias of aliases) {
    const value = row?.[alias]

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value
    }
  }

  return null
}

export const createImportError = ({
  statusCode = 400,
  errorCode = "IMPORT_FAILED",
  message = "The uploaded file could not be processed.",
  suggestion = "Please check the file format and required columns, then try again.",
  technicalMessage = null,
  validationErrors = [],
}) => {
  const error = new Error(message)
  error.statusCode = statusCode
  error.errorCode = errorCode
  error.suggestion = suggestion
  error.technicalMessage = technicalMessage
  error.validationErrors = validationErrors
  return error
}

export const isSupportedImportFile = (file) => {
  if (!file?.originalname) return false

  const extension = getFileExtension(file.originalname)
  if (!extension) return false

  const mimetype = String(file.mimetype || "").toLowerCase().trim()
  if (!mimetype) return true

  if (SUPPORTED_UPLOAD_MIME_TYPES.has(mimetype)) {
    return true
  }

  return extension === ".csv" || extension === ".xlsx" || extension === ".xls"
}

const parseCsvBuffer = (buffer) => {
  const csvText = buffer.toString("utf8")
  return parseCsv(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  })
}

const parseExcelBuffer = (buffer) => {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
  })

  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    return []
  }

  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    defval: "",
    raw: false,
  })
}

export const parseUploadedTransactionFile = (file) => {
  const extension = getFileExtension(file?.originalname)

  if (!extension || !isSupportedImportFile(file)) {
    throw createImportError({
      errorCode: "UNSUPPORTED_FILE_TYPE",
      message: "MaiinSight only supports CSV and Excel transaction files.",
      suggestion: "Please upload a .csv, .xlsx, or .xls file.",
      technicalMessage: `Unsupported file: ${file?.originalname || "unknown"} (${file?.mimetype || "unknown mimetype"})`,
    })
  }

  try {
    return extension === ".csv" ? parseCsvBuffer(file.buffer) : parseExcelBuffer(file.buffer)
  } catch (error) {
    throw createImportError({
      errorCode: "IMPORT_FAILED",
      message: "The uploaded file could not be processed.",
      suggestion: "Please check the file format and required columns, then try again.",
      technicalMessage: error instanceof Error ? error.message : "Failed to parse uploaded transaction file.",
    })
  }
}

export const validateTransactionTemplate = (records) => {
  if (!Array.isArray(records) || records.length === 0) {
    throw createImportError({
      errorCode: "INVALID_TEMPLATE",
      message: "The uploaded file does not match the required MaiinSight transaction template.",
      suggestion: "Please check the column names and upload the correct transaction file.",
      technicalMessage: "No data rows were found after parsing the file.",
    })
  }

  const headers = Object.keys(records[0] || {})
  const normalizedHeaders = new Set(headers.map(normalizeHeader))
  const missingGroups = REQUIRED_COLUMN_GROUPS.filter(
    (aliases) => !aliases.some((alias) => normalizedHeaders.has(normalizeHeader(alias)))
  )

  if (missingGroups.length > 0) {
    throw createImportError({
      errorCode: "INVALID_TEMPLATE",
      message: "The uploaded file does not match the required MaiinSight transaction template.",
      suggestion: "Please check the column names and upload the correct transaction file.",
      technicalMessage: `Missing required columns: ${missingGroups.map((group) => group[0]).join(", ")}`,
    })
  }

  return headers
}

const isDateInReasonableRange = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false

  const year = date.getFullYear()
  return year >= 2020 && year <= 2035
}

const parseExcelSerialDate = (value) => {
  const serial = Number(value)

  if (!Number.isFinite(serial)) return null

  // Excel serial date biasanya sekitar 40000-an untuk tahun 2009 ke atas.
  // Kita batasi supaya angka random tidak dianggap sebagai tanggal.
  if (serial < 40000 || serial > 60000) return null

  const excelEpoch = Date.UTC(1899, 11, 30)
  const date = new Date(excelEpoch + serial * 86400000)

  return isDateInReasonableRange(date) ? date : null
}

const isValidDateFormat = (value) => {
  if (!value) return false

  if (value instanceof Date) {
    return isDateInReasonableRange(value)
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Boolean(parseExcelSerialDate(value))
  }

  const raw = normalizeCell(value)
  if (!raw) return false

  // Numeric string dari Excel, misalnya "45831"
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Boolean(parseExcelSerialDate(raw))
  }

  const dayMonthTextMatch = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/)

  if (dayMonthTextMatch) {
    const [, day, monthText, yearText] = dayMonthTextMatch

    const monthMap = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    }

    const month = monthMap[monthText.toLowerCase()]
    const yearNumber = Number(yearText)
    const year = yearNumber < 100 ? 2000 + yearNumber : yearNumber

    if (month === undefined) return false

    const date = new Date(year, month, Number(day))
    return isDateInReasonableRange(date)
  }

  const dayMonthYearMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)

  if (dayMonthYearMatch) {
    const [, day, month, year] = dayMonthYearMatch
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    return isDateInReasonableRange(date)
  }

  // Hindari new Date(raw) yang terlalu bebas membaca angka random sebagai tahun.
  const isoDateMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)

  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    return isDateInReasonableRange(date)
  }

  return false
}

const isValidTimeRangeFormat = (value) => {
  const text = normalizeCell(value)
  if (!text) return false

  const match = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!match) return false

  const startHour = Number(match[1])
  const startMinute = Number(match[2])
  let endHour = Number(match[3])
  const endMinute = Number(match[4])

  if (
    !Number.isFinite(startHour) ||
    !Number.isFinite(startMinute) ||
    !Number.isFinite(endHour) ||
    !Number.isFinite(endMinute)
  ) {
    return false
  }

  if (startHour < 0 || startHour > 23) return false
  if (endHour < 0 || endHour > 24) return false
  if (startMinute < 0 || startMinute > 59) return false
  if (endMinute < 0 || endMinute > 59) return false

  if (endHour === 0 && endMinute === 0) {
    endHour = 24
  }

  const startValue = startHour + startMinute / 60
  const endValue = endHour + endMinute / 60

  return endValue > startValue
}

export const validateTransactionRows = (records) => {
  const validationErrors = []

  records.forEach((row, index) => {
    const rowNumber = index + 2
    const statusClassification = classifyTransactionStatus(
      getRowValue(row, ["Status", "status"])
    )

    if (statusClassification.category === TRANSACTION_ROW_CATEGORIES.EXCLUDED) {
      return
    }

    const transactionDate = getRowValue(row, [
      "Tanggal Transaksi",
      "tanggal_transaksi",
      "tanggalTransaksi",
      "transactionDate",
    ])

    const playDate = getRowValue(row, [
      "Tanggal Main",
      "tanggal_main",
      "tanggalMain",
      "playDate",
    ])

    const playTime = getRowValue(row, [
      "Jam Main",
      "jam_main",
      "jamMain",
      "playTime",
    ])

    const netRevenue = getRowValue(row, [
      "Harga Bersih",
      "harga_bersih",
      "hargaBersih",
      "netRevenue",
    ])

    const addOnRevenue = getRowValue(row, [
      "Harga Add Ons Bersih",
      "harga_add_ons_bersih",
      "hargaAddOnsBersih",
      "Harga Add Ons",
      "harga_add_ons",
      "hargaAddOns",
    ])

    const email = getRowValue(row, ["Email", "email", "normalizedEmail"])
    const customerName = getRowValue(row, [
      "Nama",
      "nama",
      "Customer Name",
      "customer_name",
      "customerName",
      "Team",
      "team",
    ])
    const phone = getRowValue(row, [
      "No. Telep",
      "No Telep",
      "No. Telepon",
      "No Telepon",
      "no_telepon",
      "Phone",
      "phone",
      "No HP",
      "No. HP",
      "normalizedPhone",
    ])
    const revenue = classifyTransactionRevenue({
      baseRevenue: netRevenue,
      addOnRevenue,
      category: statusClassification.category,
    })
    const parsedNetRevenue = parseTransactionAmount(netRevenue, {
      emptyValue:
        statusClassification.category === TRANSACTION_ROW_CATEGORIES.OPERATIONAL
          ? 0
          : null,
    })
    const parsedAddOnRevenue = parseTransactionAmount(addOnRevenue, { emptyValue: 0 })

    if (transactionDate === null) {
      validationErrors.push({
        rowNumber,
        column: "Tanggal Transaksi",
        value: transactionDate,
        message: "Transaction date is required and cannot be empty.",
      })
    } else if (!isValidDateFormat(transactionDate)) {
      validationErrors.push({
        rowNumber,
        column: "Tanggal Transaksi",
        value: transactionDate,
        message: "Invalid date format. Transaction date must contain a valid date.",
      })
    }

    if (playDate === null) {
      validationErrors.push({
        rowNumber,
        column: "Tanggal Main",
        value: playDate,
        message: "Play date is required and cannot be empty.",
      })
    } else if (!isValidDateFormat(playDate)) {
      validationErrors.push({
        rowNumber,
        column: "Tanggal Main",
        value: playDate,
        message: "Invalid date format. Play date must contain a valid date.",
      })
    }

    if (playTime === null) {
      validationErrors.push({
        rowNumber,
        column: "Jam Main",
        value: playTime,
        message: "Play time is required and cannot be empty.",
      })
    } else if (!isValidTimeRangeFormat(playTime)) {
      validationErrors.push({
        rowNumber,
        column: "Jam Main",
        value: playTime,
        message: "Play time must use format HH:mm - HH:mm, for example 19:00 - 21:00.",
      })
    }

    if (
      statusClassification.category === TRANSACTION_ROW_CATEGORIES.CUSTOMER &&
      !revenue.shouldSkip &&
      !buildCustomerIdentity({
        email,
        name: customerName,
        phone,
      })
    ) {
      validationErrors.push({
        rowNumber,
        column: "Customer",
        value: {
          email: email || null,
          name: customerName || null,
          phone: phone || null,
        },
        message: "Customer email, name, or phone must contain a usable identity value.",
      })
    }

    if (!parsedNetRevenue.valid && netRevenue === null) {
      validationErrors.push({
        rowNumber,
        column: "Harga Bersih",
        value: netRevenue,
        message: "Net revenue is required and cannot be empty.",
      })
    } else if (!parsedNetRevenue.valid) {
      validationErrors.push({
        rowNumber,
        column: "Harga Bersih",
        value: netRevenue,
        message: "Invalid numeric value. Net revenue must be a valid number.",
      })
    }

    if (!parsedAddOnRevenue.valid) {
      validationErrors.push({
        rowNumber,
        column: "Harga Add Ons Bersih",
        value: addOnRevenue,
        message: "Invalid numeric value. Net add-on revenue must be a valid number.",
      })
    }
  })
  if (validationErrors.length > 0) {
    throw createImportError({
      errorCode: "INVALID_ROW_DATA",
      message: "The uploaded file contains invalid row data.",
      suggestion: "Please fix the listed rows and upload the transaction file again.",
      technicalMessage: `${validationErrors.length} row validation error(s) found.`,
      validationErrors,
    })
  }

  return true
}

export const buildFriendlyImportFailure = (error) => {
  const technicalMessage =
    error?.technicalMessage ||
    (error instanceof Error ? error.message : "Unknown import error.")

  if (
    String(technicalMessage).includes("Can't reach database server") ||
    String(technicalMessage).includes("PrismaClientInitializationError")
  ) {
    return {
      success: false,
      errorCode: "SYSTEM_UNAVAILABLE",
      message: "MaiinSight cannot access the data service right now.",
      suggestion: "Please make sure the backend database is running, then try the import again.",
      technicalMessage,
      validationErrors: [],
    }
  }

  if (error?.errorCode && error?.message) {
    return {
      success: false,
      errorCode: error.errorCode,
      message: error.message,
      suggestion:
        error.suggestion ||
        "Please check the file format and required columns, then try again.",
      technicalMessage,
      validationErrors: error.validationErrors || [],
    }
  }

  return {
    success: false,
    errorCode: "IMPORT_FAILED",
    message: "The uploaded file could not be processed.",
    suggestion: "Please check the file format and required columns, then try again.",
    technicalMessage,
    validationErrors: [],
  }
}

export const IMPORT_UPLOAD_LIMIT_MESSAGE =
  "The uploaded file is too large to process. Please upload a smaller transaction file."
