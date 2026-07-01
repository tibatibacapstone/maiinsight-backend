import { parse as parseCsv } from "csv-parse/sync"
import * as XLSX from "xlsx"

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

const getFileExtension = (fileName = "") => {
  const lowerName = String(fileName).toLowerCase()
  const matchedExtension = SUPPORTED_UPLOAD_EXTENSIONS.find((extension) =>
    lowerName.endsWith(extension)
  )

  return matchedExtension || null
}

export const createImportError = ({
  statusCode = 400,
  errorCode = "IMPORT_FAILED",
  message = "The uploaded file could not be processed.",
  suggestion = "Please check the file format and required columns, then try again.",
  technicalMessage = null,
}) => {
  const error = new Error(message)
  error.statusCode = statusCode
  error.errorCode = errorCode
  error.suggestion = suggestion
  error.technicalMessage = technicalMessage
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

  // Some browsers and exported spreadsheets use generic MIME types.
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
    }
  }

  return {
    success: false,
    errorCode: "IMPORT_FAILED",
    message: "The uploaded file could not be processed.",
    suggestion: "Please check the file format and required columns, then try again.",
    technicalMessage,
  }
}

export const IMPORT_UPLOAD_LIMIT_MESSAGE =
  "The uploaded file is too large to process. Please upload a smaller transaction file."
