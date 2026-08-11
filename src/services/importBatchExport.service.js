export const IMPORT_BATCH_PREVIEW_LIMIT = 100

const sourceColumn = (header, sourceAliases, generatedField = null) => ({
  header,
  sourceAliases,
  generatedField,
})
const generatedColumn = (header, generatedField) => ({ header, generatedField })

export const TRANSFORMED_EXPORT_SCHEMA = Object.freeze([
  // Source transaction information
  sourceColumn("Order ID", ["Order ID", "Order Id", "order_id", "orderId"], "orderId"),
  sourceColumn("Nama", ["Nama", "nama", "Customer Name", "customer_name", "customerName", "Team", "team"], "customerName"),
  sourceColumn("Email", ["Email", "email"]),
  sourceColumn("No. Telepon", ["No. Telep", "No Telep", "No. Telepon", "No Telepon", "no_telepon", "Phone", "phone", "No HP", "No. HP"]),
  sourceColumn("Customer Profile", ["Customer Profile", "customer_profile", "customerProfile"], "customerProfile"),
  sourceColumn("Tanggal Transaksi", ["Tanggal Transaksi", "tanggal_transaksi", "tanggalTransaksi", "transactionDate"]),
  sourceColumn("Tanggal Main", ["Tanggal Main", "tanggal_main", "tanggalMain", "playDate"]),
  sourceColumn("Jam Main", ["Jam Main", "jam_main", "jamMain", "playTime"]),
  sourceColumn("Venue", ["Venue", "venue"]),
  sourceColumn("Lapangan", ["Lapangan", "lapangan", "Court", "court"]),
  sourceColumn("Status", ["Status", "status"]),
  sourceColumn("Harga Bersih", ["Harga Bersih", "harga_bersih", "hargaBersih"]),
  sourceColumn("Add Ons", ["Add Ons", "add_ons", "addOns"], "addOns"),
  sourceColumn("Harga Add Ons Bersih", ["Harga Add Ons Bersih", "harga_add_ons_bersih", "hargaAddOnsBersih", "Harga Add Ons", "harga_add_ons", "hargaAddOns"]),
  sourceColumn("Tipe Voucher", ["Tipe Voucher", "tipe_voucher", "tipeVoucher"]),
  sourceColumn("Harga Voucher", ["Harga Voucher", "harga_voucher", "hargaVoucher", "Voucher Discount", "voucherDiscount", "Discount"]),
  sourceColumn("Reschedule", ["Reschedule", "reschedule"]),
  sourceColumn("Promosi", ["Promosi", "promosi", "Promo", "promoName"]),
  sourceColumn("Keperluan Olahraga", ["Keperluan", "keperluan", "Keperluan Olahraga", "keperluan_olahraga", "Sport Purpose", "sportPurpose"]),
  sourceColumn("Deskripsi", ["Deskripsi", "deskripsi", "Description", "description"]),

  // Customer canonicalization
  generatedColumn("Customer Identity", "customerIdentity"),
  generatedColumn("Customer Key", "customerKey"),
  generatedColumn("Customer Key Type", "customerKeyType"),
  generatedColumn("Booking Type", "bookingType"),

  // Deduplication and lineage
  generatedColumn("Booking Event Key", "bookingEventKey"),
  generatedColumn("Booking Range Key", "bookingRangeKey"),
])

export const TRANSFORMED_EXPORT_COLUMNS = Object.freeze(
  TRANSFORMED_EXPORT_SCHEMA.map((column) => column.header)
)

const hasValue = (value) => value !== undefined && value !== null

const getSourceValue = (rawData, aliases = []) => {
  for (const alias of aliases) {
    if (hasValue(rawData?.[alias])) return rawData[alias]
  }
  return undefined
}

export const buildCuratedTransformedRowData = (rawData = {}, transaction = null) =>
  Object.fromEntries(
    TRANSFORMED_EXPORT_SCHEMA.map(({ header, sourceAliases, generatedField }) => {
      const sourceValue = getSourceValue(rawData, sourceAliases)
      const generatedValue = generatedField ? transaction?.[generatedField] : undefined
      return [header, hasValue(sourceValue) ? sourceValue : generatedValue ?? null]
    })
  )

export const buildTransformedBatchRows = (rawRows = [], generatedTransactions = []) => {
  const generatedByRawRowId = new Map(
    generatedTransactions.map((transaction) => [transaction.rawRowId, transaction])
  )

  return rawRows.map((row) => ({
    ...row,
    data: buildCuratedTransformedRowData(
      row.data || {},
      generatedByRawRowId.get(row.id)
    ),
  }))
}

export const buildTransformedBatchColumns = () => [...TRANSFORMED_EXPORT_COLUMNS]

const serializeCell = (value) => {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

const escapeCsvCell = (value) => `"${serializeCell(value).replace(/"/g, '""')}"`

export const buildTransformedBatchCsv = (columns = [], rows = []) =>
  [
    ["Row", ...columns].map(escapeCsvCell).join(","),
    ...rows.map((row) =>
      [row.rowNumber, ...columns.map((column) => row.data?.[column])]
        .map(escapeCsvCell)
        .join(",")
    ),
  ].join("\r\n")
