const getValue = (row, keys) => {
  for (const key of keys) {
    const value = row[key]

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value
    }
  }

  return null
}

const parseAmount = (value) => {
  if (value === null || value === undefined || value === "") return null

  const cleaned = String(value).replace(/[^\d.-]/g, "")
  const numberValue = Number(cleaned)

  return Number.isNaN(numberValue) ? null : numberValue
}

const parseDate = (value) => {
  if (!value) return null

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }

  const raw = String(value).trim()

  const match = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/)

  if (match) {
    const [, day, monthText, yearText] = match

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

    if (month !== undefined) {
      const date = new Date(year, month, Number(day))

      if (!Number.isNaN(date.getTime())) {
        return date
      }
    }
  }

  const date = new Date(raw)

  if (Number.isNaN(date.getTime())) return null

  return date
}

const getStartHour = (jamMain) => {
  if (!jamMain) return null

  const startTime = String(jamMain).split("-")[0]?.trim()
  const hourText = startTime?.split(":")[0]
  const hour = Number(hourText)

  return Number.isNaN(hour) ? null : hour
}

const classifyPlayTime = (hour) => {
  if (hour === null || hour === undefined) return null

  if (hour >= 6 && hour < 12) return "Pagi"
  if (hour >= 12 && hour < 18) return "Siang"
  if (hour >= 18 && hour <= 23) return "Malam"

  return "Di Luar Jam Operasional"
}

const getPeriod = (date) => {
  if (!date) return null

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")

  return `${year}-${month}`
}

export const mapRawRowToFacilityTransaction = (row, batchId, rowNumber) => {
  const tanggalTransaksi = parseDate(
    getValue(row, ["Tanggal Transaksi", "tanggal_transaksi", "tanggalTransaksi"])
  )

  const tanggalMain = parseDate(
    getValue(row, ["Tanggal Main", "tanggal_main", "tanggalMain"])
  )

  const jamMain = getValue(row, ["Jam Main", "jam_main", "jamMain"])

  const startHour = getStartHour(jamMain)
  const playTimeGroup = classifyPlayTime(startHour)

  return {
    batchId,
    rowNumber,

    orderId: getValue(row, ["Order ID", "Order Id", "order_id", "orderId"]),

    nama: getValue(row, ["Nama", "nama", "Customer Name", "customer_name"]),
    email: getValue(row, ["Email", "email"]),
    noTelepon: String(
      getValue(row, [
        "No. Telep",
        "No Telep",
        "No. Telepon",
        "No Telepon",
        "no_telepon",
      ]) || ""
    ),

    customerProfile: getValue(row, ["Customer Profile", "customer_profile"]),

    tanggalTransaksi,
    tanggalMain,
    jamMain,

    venue: getValue(row, ["Venue", "venue"]),
    lapangan: getValue(row, ["Lapangan", "lapangan"]),

    hargaBersih: parseAmount(
      getValue(row, ["Harga Bersih", "harga_bersih", "hargaBersih"])
    ),

    addOns: getValue(row, ["Add Ons", "add_ons", "addOns"]),

    hargaAddOns: parseAmount(
      getValue(row, ["Harga Add Ons", "Harga Add", "harga_add_ons", "hargaAddOns"])
    ),

    tipeVoucher: getValue(row, ["Tipe Voucher", "tipe_voucher", "tipeVoucher"]),

    hargaVoucher: parseAmount(
      getValue(row, ["Harga Voucher", "harga_voucher", "hargaVoucher"])
    ),

    status: getValue(row, ["Status", "status"]),
    reschedule: getValue(row, ["Reschedule", "reschedule"]),
    promosi: getValue(row, ["Promosi", "promosi"]),
    keperluan: getValue(row, ["Keperluan", "keperluan"]),
    deskripsi: getValue(row, ["Deskripsi", "deskripsi"]),

    period: getPeriod(tanggalMain),
    startHour,
    playTimeGroup,

    rawData: row,
  }
}