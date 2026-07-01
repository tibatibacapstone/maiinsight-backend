const UNKNOWN_CUSTOMER_PREFIX = "UNKNOWN";

const getValue = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return null;
};

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeText = (value) => normalizeWhitespace(value).toLowerCase();

const normalizeName = (value) => {
  const text = normalizeWhitespace(value);
  return text ? text.toLowerCase() : null;
};

const normalizeEmail = (value) => {
  const text = normalizeText(value);

  if (!text || !text.includes("@")) return null;

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(text) ? text : null;
};

const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/[^\d+]/g, "");

  if (!digits) return null;

  if (digits.startsWith("+")) {
    return digits;
  }

  return digits.replace(/^0+/, "") || digits;
};

const parseAmount = (value) => {
  if (value === null || value === undefined || value === "") return 0;

  const normalized = String(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const parseDate = (value) => {
  if (!value) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const date = new Date(excelEpoch + value * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const raw = normalizeWhitespace(value);
  if (!raw) return null;

  const dayMonthTextMatch = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);

  if (dayMonthTextMatch) {
    const [, day, monthText, yearText] = dayMonthTextMatch;
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
    };

    const month = monthMap[monthText.toLowerCase()];
    const yearNumber = Number(yearText);
    const year = yearNumber < 100 ? 2000 + yearNumber : yearNumber;

    if (month !== undefined) {
      const date = new Date(year, month, Number(day));
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  const dayMonthYearMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);

  if (dayMonthYearMatch) {
    const [, day, month, year] = dayMonthYearMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(date.getTime())) return date;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatTimeLabel = (hour, minute = 0) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const parseStoredHourValue = (value) => {
  const text = normalizeWhitespace(value);
  if (!text) return null;

  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return hour + minute / 60;
};

const parseJamMain = (value) => {
  const text = normalizeWhitespace(value);

  if (!text) {
    return {
      playTime: null,
      startHour: null,
      endHour: null,
      startHourNumber: null,
      endHourNumber: null,
      durationHours: 0,
    };
  }

  const match = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);

  if (!match) {
    return {
      playTime: text,
      startHour: null,
      endHour: null,
      startHourNumber: null,
      endHourNumber: null,
      durationHours: 0,
    };
  }

  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  let endHour = Number(match[3]);
  const endMinute = Number(match[4]);

  if (endHour === 0 && endMinute === 0) {
    endHour = 24;
  }

  const startValue = startHour + startMinute / 60;
  const endValue = endHour + endMinute / 60;
  const durationHours = Math.max(0, endValue - startValue);

  return {
    playTime: `${formatTimeLabel(startHour, startMinute)} - ${formatTimeLabel(
      endHour,
      endMinute
    )}`,
    startHour: formatTimeLabel(startHour, startMinute),
    endHour: formatTimeLabel(endHour, endMinute),
    startHourNumber: startValue,
    endHourNumber: endValue,
    durationHours,
  };
};

const classifyPlayTime = (hourNumber) => {
  if (hourNumber === null || hourNumber === undefined) return null;
  if (hourNumber >= 6 && hourNumber < 12) return "Pagi";
  if (hourNumber >= 12 && hourNumber < 18) return "Siang";
  if (hourNumber >= 18 && hourNumber <= 23) return "Malam";
  return "Di Luar Jam Operasional";
};

const normalizeCourt = (value) => {
  const text = normalizeText(value);

  if (text.includes("basket")) {
    return {
      court: "Basketball",
      courtType: "basketball",
    };
  }

  if (text.includes("soccer") || text.includes("mini")) {
    return {
      court: "Mini Soccer",
      courtType: "mini_soccer",
    };
  }

  return {
    court: normalizeWhitespace(value) || null,
    courtType: null,
  };
};

const getPeriod = (date) => {
  if (!date) return null;

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

const getDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const isPaymentCompleted = (status) => normalizeText(status) === "payment completed";
const isManualWalkIn = (status) => normalizeText(status) === "manual/walk-in";

const buildCustomerIdentity = ({
  rawRowId,
  normalizedEmailValue,
  normalizedPhoneValue,
  normalizedNameValue,
}) => {
  if (normalizedEmailValue) {
    return {
      customerKey: `EMAIL:${normalizedEmailValue}`,
      customerKeyType: "email",
      customerKeyConfidence: "high",
    };
  }

  if (normalizedPhoneValue) {
    return {
      customerKey: `PHONE:${normalizedPhoneValue}`,
      customerKeyType: "phone",
      customerKeyConfidence: "medium",
    };
  }

  if (normalizedNameValue) {
    return {
      customerKey: `NAME:${normalizedNameValue}`,
      customerKeyType: "name",
      customerKeyConfidence: "low",
    };
  }

  return {
    customerKey: `${UNKNOWN_CUSTOMER_PREFIX}:${rawRowId}`,
    customerKeyType: "unknown",
    customerKeyConfidence: "unknown",
  };
};

const buildBookingType = ({ status, orderId }) => {
  const normalizedOrderId = normalizeWhitespace(orderId);

  if (isPaymentCompleted(status) && normalizedOrderId) {
    return "regular_booking";
  }

  if (isManualWalkIn(status) || !normalizedOrderId) {
    return "member_internal_booking";
  }

  return "other";
};

const buildBookingEventKey = ({ orderId, customerKey, transactionDate, bookingType }) => {
  const normalizedOrderId = normalizeWhitespace(orderId);

  if (normalizedOrderId) return `ORDER:${normalizedOrderId}`;

  const transactionDateKey = transactionDate ? getDateKey(transactionDate) : "no-transaction-date";
  return `${customerKey}|${transactionDateKey}|${bookingType}`;
};

const buildBookingRangeKey = ({ bookingEventKey, playDate, playTime, court }) => {
  const playDateKey = playDate ? getDateKey(playDate) : "no-play-date";
  return `${bookingEventKey}|${playDateKey}|${playTime || "no-play-time"}|${court || "no-court"}`;
};

const resolveRawRowId = ({ rawRowId, batchId, rowNumber }) => {
  const numericValue = Number(rawRowId);

  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  if (Number.isFinite(Number(rowNumber)) && Number(rowNumber) > 0) {
    return Number(rowNumber);
  }

  if (Number.isFinite(Number(batchId)) && Number(batchId) > 0) {
    return Number(batchId);
  }

  return 0;
};

const buildFacilityTransactionPayload = (
  row,
  { batchId, rowNumber, rawRowId, includeRawData = true } = {}
) => {
  const resolvedBatchId = Number(batchId);
  const resolvedRowNumber = Number(rowNumber);
  const resolvedRawRowId = resolveRawRowId({ rawRowId, batchId, rowNumber });

  const transactionDate = parseDate(
    getValue(row, [
      "Tanggal Transaksi",
      "tanggal_transaksi",
      "tanggalTransaksi",
      "transactionDate",
    ])
  );

  const playDate = parseDate(
    getValue(row, ["Tanggal Main", "tanggal_main", "tanggalMain", "playDate"])
  );

  const jamMainRaw = getValue(row, ["Jam Main", "jam_main", "jamMain", "playTime"]);
  const parsedJamMain = parseJamMain(jamMainRaw);
  const orderId = normalizeWhitespace(
    getValue(row, ["Order ID", "Order Id", "order_id", "orderId"])
  ) || null;
  const status = normalizeWhitespace(getValue(row, ["Status", "status"])) || null;

  const courtSource =
    getValue(row, ["Lapangan", "lapangan", "Court", "court", "Venue", "venue"]) || null;
  const { court, courtType } = normalizeCourt(courtSource);

  const customerName =
    normalizeWhitespace(
      getValue(row, ["Nama", "nama", "Customer Name", "customer_name", "customerName", "Team", "team"])
    ) || null;
  const normalizedNameValue = normalizeName(customerName);
  const normalizedEmailValue = normalizeEmail(
    getValue(row, ["Email", "email", "normalizedEmail"])
  );
  const normalizedPhoneValue = normalizePhone(
    getValue(row, [
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
  );

  const { customerKey, customerKeyType, customerKeyConfidence } = buildCustomerIdentity({
    rawRowId: resolvedRawRowId,
    normalizedEmailValue,
    normalizedPhoneValue,
    normalizedNameValue,
  });

  const baseRevenue = parseAmount(
    getValue(row, ["Harga Bersih", "harga_bersih", "hargaBersih", "netRevenue"])
  );

  const addOnRevenue = parseAmount(
    getValue(row, [
      "Harga Add Ons Bersih",
      "harga_add_ons_bersih",
      "hargaAddOnsBersih",
      "Harga Add Ons",
      "harga_add_ons",
      "hargaAddOns",
    ])
  );

  const voucherDiscount = parseAmount(
    getValue(row, [
      "Harga Voucher",
      "harga_voucher",
      "hargaVoucher",
      "Voucher Discount",
      "voucherDiscount",
      "Discount",
    ])
  );

  const bookingType = buildBookingType({ status, orderId });
  const validBooking = isPaymentCompleted(status) || isManualWalkIn(status);
  const bookingEventKey = buildBookingEventKey({
    orderId,
    customerKey,
    transactionDate,
    bookingType,
  });
  const bookingRangeKey = buildBookingRangeKey({
    bookingEventKey,
    playDate,
    playTime: parsedJamMain.playTime,
    court,
  });

  const netRevenue = baseRevenue + addOnRevenue;
  const venue = normalizeWhitespace(getValue(row, ["Venue", "venue"])) || null;
  const playTimeGroup = classifyPlayTime(parsedJamMain.startHourNumber);
  const promoName =
    normalizeWhitespace(getValue(row, ["Promosi", "promosi", "Promo", "promoName"])) || null;
  const sportPurpose =
    normalizeWhitespace(getValue(row, ["Keperluan", "keperluan", "Keperluan Olahraga", "keperluan_olahraga", "Sport Purpose", "sportPurpose"])) || null;
  const description =
    normalizeWhitespace(getValue(row, ["Deskripsi", "deskripsi", "Description", "description"])) || null;

  return {
    batchId: Number.isFinite(resolvedBatchId) ? resolvedBatchId : 0,
    rawRowId: resolvedRawRowId,
    rowNumber: Number.isFinite(resolvedRowNumber) ? resolvedRowNumber : 0,
    orderId,
    customerId: Number.isFinite(Number(row?.customerId)) ? Number(row.customerId) : null,
    customerKey,
    customerName,
    normalizedName: normalizedNameValue,
    normalizedEmail: normalizedEmailValue,
    normalizedPhone: normalizedPhoneValue,
    customerKeyType,
    customerKeyConfidence,

    nama: customerName,
    email: normalizedEmailValue,
    noTelepon: normalizedPhoneValue,
    customerProfile:
      normalizeWhitespace(
        getValue(row, ["Customer Profile", "customer_profile", "customerProfile"])
      ) || null,

    tanggalTransaksi: transactionDate,
    tanggalMain: playDate,
    jamMain: parsedJamMain.playTime || normalizeWhitespace(jamMainRaw) || null,
    transactionDate,
    playDate,
    playTime: parsedJamMain.playTime || normalizeWhitespace(jamMainRaw) || null,
    startHour: parsedJamMain.startHour,
    endHour: parsedJamMain.endHour,
    durationHours: parsedJamMain.durationHours,

    venue,
    lapangan: court,
    court: court || "Unknown Court",
    courtType,

    hargaBersih: baseRevenue,
    addOns: normalizeWhitespace(getValue(row, ["Add Ons", "add_ons", "addOns"])) || null,
    hargaAddOns: addOnRevenue,
    netRevenue,
    addOnRevenue,
    tipeVoucher:
      normalizeWhitespace(getValue(row, ["Tipe Voucher", "tipe_voucher", "tipeVoucher"])) || null,
    hargaVoucher: voucherDiscount,
    voucherDiscount,

    status,
    promoName,
    sportPurpose,
    description,
    reschedule: normalizeWhitespace(getValue(row, ["Reschedule", "reschedule"])) || null,
    promosi: promoName,
    keperluan: sportPurpose,
    deskripsi: description,

    period: getPeriod(playDate),
    playTimeGroup,
    bookingType,
    validBooking,
    bookingEventKey,
    bookingRangeKey,
    rawData: includeRawData ? row : undefined,
  };
};

const getHourSlots = (transaction) => {
  const startHourValue = parseStoredHourValue(transaction.startHour);
  const endHourValue = parseStoredHourValue(transaction.endHour);

  if (
    startHourValue === null ||
    endHourValue === null ||
    !Number.isFinite(startHourValue) ||
    !Number.isFinite(endHourValue) ||
    endHourValue <= startHourValue
  ) {
    return [];
  }

  const slots = [];

  for (let hour = Math.floor(startHourValue); hour < Math.floor(endHourValue); hour += 1) {
    slots.push(formatTimeLabel(hour));
  }

  return slots;
};

export const buildCourtHourUsageEntries = (transaction) => {
  if (
    !transaction?.validBooking ||
    !transaction.playDate ||
    !transaction.court ||
    !transaction.courtType ||
    !transaction.batchId ||
    !transaction.id
  ) {
    return [];
  }

  const date =
    transaction.playDate instanceof Date ? transaction.playDate : new Date(transaction.playDate);

  if (Number.isNaN(date.getTime())) return [];

  const hourSlots = getHourSlots(transaction);

  if (!hourSlots.length) return [];

  const durationHours = Number(transaction.durationHours || hourSlots.length);
  const netRevenue = Number(transaction.netRevenue || 0);
  const hourlyRevenue =
    durationHours > 0 ? Number((netRevenue / durationHours).toFixed(2)) : netRevenue;
  const dateKey = getDateKey(date);

  return hourSlots.map((hourStart) => ({
    transactionId: transaction.id,
    batchId: transaction.batchId,
    playDate: date,
    hourStart,
    court: transaction.court,
    courtType: transaction.courtType,
    courtHourKey: `${dateKey}|${hourStart}|${transaction.court}`,
    hourlyRevenue,
  }));
};

export const mapRawRowToFacilityTransaction = (row, batchId, rowNumber, rawRowId) =>
  buildFacilityTransactionPayload(row, {
    batchId,
    rowNumber,
    rawRowId,
    includeRawData: true,
  });

export const mapFacilityTransactionToCanonicalUpdate = (transaction) => {
  const mergedSource = {
    ...(transaction?.rawData && typeof transaction.rawData === "object" ? transaction.rawData : {}),
    ...transaction,
  };

  return buildFacilityTransactionPayload(mergedSource, {
    batchId: transaction.batchId,
    rowNumber: transaction.rowNumber,
    rawRowId: transaction.rawRowId || transaction.id,
    includeRawData: false,
  });
};

