import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const SPORTS = new Map([
  ["mini soccer", { court: "Mini Soccer", courtType: "mini_soccer" }],
  ["basketball", { court: "Basketball", courtType: "basketball" }],
]);

const normalizeText = (value) => (value == null ? "" : String(value).trim());

const cleanKey = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ");

const normalizeEmail = (value) => {
  const raw = normalizeText(value).toLowerCase();
  if (!raw || !raw.includes("@")) return null;
  return raw;
};

const normalizePhone = (value) => {
  const digits = normalizeText(value).replace(/[^\d+]/g, "");
  if (!digits) return null;
  return digits.startsWith("+") ? digits : digits.replace(/^0+/, "");
};

const parseDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const fallback = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

const parseMoney = (value) => {
  if (value == null || value === "") return 0;
  const normalized = String(value).replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", ".");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
};

const formatHour = (date) => `${String(date.getHours()).padStart(2, "0")}:00`;

const parseJamMain = (value) => {
  const text = normalizeText(value);
  const match = text.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  const start = match[1];
  const end = match[2] === "00:00" ? "24:00" : match[2];
  const [startHour] = start.split(":");
  const [endHourRaw] = end.split(":");
  const startNum = Number(startHour);
  const endNum = Number(endHourRaw);
  const durationHours = endNum >= startNum ? endNum - startNum : 0;
  return { start, end: match[2], durationHours };
};

const getRowValue = (row, candidates) => {
  for (const key of candidates) {
    if (row[key] != null && String(row[key]).trim() !== "") return row[key];
  }
  return null;
};

const normalizeCourt = (value) => {
  const raw = cleanKey(value);
  if (raw.includes("basket")) return SPORTS.get("basketball");
  return SPORTS.get("mini soccer");
};

const buildCustomerKey = (rowId, email, phone, name) => {
  if (email) return { key: `EMAIL:${email}`, type: "email", confidence: 1 };
  if (phone) return { key: `PHONE:${phone}`, type: "phone", confidence: 0.9 };
  if (name) return { key: `NAME:${cleanKey(name)}`, type: "name", confidence: 0.7 };
  return { key: `UNKNOWN:${rowId}`, type: "unknown", confidence: 0.1 };
};

const buildBookingEventKey = ({ orderId, customerKey, transactionDate, bookingType }) => {
  if (orderId) return `ORDER:${orderId}`;
  const datePart = transactionDate ? transactionDate.toISOString().slice(0, 10) : "NO_DATE";
  return `${customerKey}|${datePart}|${bookingType}`;
};

const buildBookingRangeKey = ({ bookingEventKey, playDate, playTime, court }) =>
  `${bookingEventKey}|${playDate?.toISOString().slice(0, 10) ?? "NO_PLAY_DATE"}|${playTime}|${court}`;

const buildCourtHourKeys = (playDate, startHour, durationHours, court) => {
  if (!playDate || !startHour || !durationHours) return [];
  const [hour] = startHour.split(":");
  const startNum = Number(hour);
  const keys = [];
  for (let offset = 0; offset < durationHours; offset += 1) {
    const hourValue = (startNum + offset) % 24;
    const hh = `${String(hourValue).padStart(2, "0")}:00`;
    keys.push({
      courtHourKey: `${playDate.toISOString().slice(0, 10)}|${hh}|${court}`,
      hourStart: hh,
    });
  }
  return keys;
};

const mapRowToCanonical = (row, rowId) => {
  const orderId = normalizeText(getRowValue(row, ["Order ID", "orderId", "order_id"])) || null;
  const customerName = normalizeText(
    getRowValue(row, ["Customer Name", "customerName", "Nama Customer", "Customer", "Nama"])
  );
  const normalizedEmail = normalizeEmail(getRowValue(row, ["Email", "email", "E-mail"]));
  const normalizedPhone = normalizePhone(getRowValue(row, ["Phone", "phone", "No HP", "No. HP", "WhatsApp", "No WA"]));
  const rawPlayDate = getRowValue(row, ["Tanggal Main", "Play Date", "playDate", "Tanggal"]);
  const playDate = parseDateValue(rawPlayDate);
  const transactionDate = parseDateValue(getRowValue(row, ["Transaction Date", "Tanggal Transaksi", "transactionDate"]));
  const jamMain = parseJamMain(getRowValue(row, ["Jam Main", "playTime", "Play Time"]));
  const courtInfo = normalizeCourt(getRowValue(row, ["Sport", "Court", "Lapangan", "Facility"]));
  const status = normalizeText(getRowValue(row, ["Status", "status"])) || null;
  const promoName = normalizeText(getRowValue(row, ["Promo Name", "promoName", "Promo"])) || null;
  const sportPurpose = normalizeText(getRowValue(row, ["Sport Purpose", "Purpose", "Tujuan"])) || null;
  const description = normalizeText(getRowValue(row, ["Description", "Keterangan", "Catatan"])) || null;
  const addOnRevenue = parseMoney(getRowValue(row, ["Harga Add Ons Bersih", "Add On Revenue", "addOnRevenue"]));
  const netRevenueBase = parseMoney(getRowValue(row, ["Harga Bersih", "Net Revenue", "netRevenue"]));
  const voucherDiscount = parseMoney(getRowValue(row, ["Voucher Discount", "Discount", "voucherDiscount"]));
  const bookingType =
    status === "Payment Completed" && orderId
      ? "regular_booking"
      : status === "Manual/Walk-in" || !orderId
        ? "member_internal_booking"
        : "other";
  const validBooking = status === "Payment Completed" || status === "Manual/Walk-in";
  const customerIdentity = buildCustomerKey(rowId, normalizedEmail, normalizedPhone, customerName);
  const bookingEventKey = buildBookingEventKey({
    orderId,
    customerKey: customerIdentity.key,
    transactionDate,
    bookingType,
  });
  const playTime = jamMain ? `${jamMain.start} - ${jamMain.end}` : normalizeText(getRowValue(row, ["Jam Main", "playTime"])) || null;
  const startHour = jamMain?.start ?? null;
  const endHour = jamMain?.end ?? null;
  const durationHours = jamMain?.durationHours ?? 0;
  const bookingRangeKey = buildBookingRangeKey({
    bookingEventKey,
    playDate,
    playTime,
    court: courtInfo.court,
  });

  return {
    orderId: orderId || null,
    customerName: customerName || null,
    normalizedEmail,
    normalizedPhone,
    transactionDate,
    playDate,
    playTime,
    startHour,
    endHour,
    durationHours,
    court: courtInfo.court,
    courtType: courtInfo.courtType,
    bookingType,
    validBooking,
    bookingEventKey,
    bookingRangeKey,
    netRevenue: netRevenueBase + addOnRevenue,
    addOnRevenue,
    voucherDiscount,
    status,
    promoName,
    sportPurpose,
    description,
    customerIdentity,
  };
};

export async function processTransactionBatch(batchId) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
  });

  if (!batch) {
    throw new Error("Import batch not found.");
  }

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status: "processing", errorMessage: null },
  });

  const rows = await prisma.rawTransactionTable.findMany({
    where: { batchId },
    orderBy: { rowNumber: "asc" },
  });

  const summary = {
    totalRawRows: rows.length,
    processedTransactions: 0,
    validTransactions: 0,
    invalidTransactions: 0,
    customersUpserted: 0,
    courtHoursCreated: 0,
    errors: [],
  };

  const seenCustomerKeys = new Set();

  try {
    for (const rawRow of rows) {
      const mapped = mapRowToCanonical(rawRow.data, rawRow.id);

      const customer = await prisma.customer.upsert({
        where: { customerKey: mapped.customerIdentity.key },
        create: {
          customerKey: mapped.customerIdentity.key,
          name: mapped.customerName,
          email: mapped.normalizedEmail,
          phone: mapped.normalizedPhone,
          customerProfile: {
            orderId: mapped.orderId,
            bookingType: mapped.bookingType,
            status: mapped.status,
            sportPurpose: mapped.sportPurpose,
          },
          customerKeyType: mapped.customerIdentity.type,
          customerKeyConfidence: mapped.customerIdentity.confidence,
        },
        update: {
          name: mapped.customerName ?? undefined,
          email: mapped.normalizedEmail ?? undefined,
          phone: mapped.normalizedPhone ?? undefined,
          customerProfile: {
            orderId: mapped.orderId,
            bookingType: mapped.bookingType,
            status: mapped.status,
            sportPurpose: mapped.sportPurpose,
          },
          customerKeyType: mapped.customerIdentity.type,
          customerKeyConfidence: mapped.customerIdentity.confidence,
        },
      });

      if (!seenCustomerKeys.has(customer.customerKey)) {
        seenCustomerKeys.add(customer.customerKey);
        summary.customersUpserted += 1;
      }

      const createTransactionData = {
        batchId,
        rawRowId: rawRow.id,
        rowNumber: rawRow.rowNumber,
        orderId: mapped.orderId,
        customerId: customer.id,
        customerKey: mapped.customerIdentity.key,
        customerName: mapped.customerName,
        normalizedEmail: mapped.normalizedEmail,
        normalizedPhone: mapped.normalizedPhone,
        transactionDate: mapped.transactionDate,
        playDate: mapped.playDate,
        playTime: mapped.playTime,
        startHour: mapped.startHour,
        endHour: mapped.endHour,
        durationHours: mapped.durationHours,
        court: mapped.court,
        courtType: mapped.courtType,
        bookingType: mapped.bookingType,
        validBooking: mapped.validBooking,
        bookingEventKey: mapped.bookingEventKey,
        bookingRangeKey: mapped.bookingRangeKey,
        netRevenue: new Prisma.Decimal(mapped.netRevenue),
        addOnRevenue: new Prisma.Decimal(mapped.addOnRevenue),
        voucherDiscount: new Prisma.Decimal(mapped.voucherDiscount),
        status: mapped.status,
        promoName: mapped.promoName,
        sportPurpose: mapped.sportPurpose,
        description: mapped.description,
      };

      const existingTransaction = await prisma.facilityTransaction.findUnique({
        where: { bookingRangeKey: mapped.bookingRangeKey },
      });

      let transaction;
      if (existingTransaction) {
        transaction = existingTransaction;
      } else {
        transaction = await prisma.facilityTransaction.upsert({
          where: { rawRowId: rawRow.id },
          create: createTransactionData,
          update: createTransactionData,
        });
      }

      summary.processedTransactions += 1;
      if (mapped.validBooking) summary.validTransactions += 1;
      else summary.invalidTransactions += 1;

      if (!existingTransaction) {
        const courtHourEntries = buildCourtHourKeys(
          mapped.playDate,
          mapped.startHour,
          mapped.durationHours,
          mapped.court
        );

        for (const entry of courtHourEntries) {
          try {
            await prisma.courtHourUsage.create({
              data: {
                transactionId: transaction.id,
                batchId,
                playDate: mapped.playDate,
                hourStart: entry.hourStart,
                court: mapped.court,
                courtType: mapped.courtType,
                courtHourKey: entry.courtHourKey,
                hourlyRevenue: new Prisma.Decimal(
                  mapped.durationHours ? mapped.netRevenue / mapped.durationHours : mapped.netRevenue
                ),
              },
            });
            summary.courtHoursCreated += 1;
          } catch (error) {
            if (error?.code !== "P2002") {
              throw error;
            }
          }
        }
      }
    }

    await prisma.importBatch.update({
      where: { id: batchId },
      data: { status: "completed", errorMessage: null },
    });

    return summary;
  } catch (error) {
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Transaction cleaning failed.",
      },
    });

    summary.errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
