import test from "node:test"
import assert from "node:assert/strict"

import {
  buildBookingEventKey,
  buildCustomerIdentity,
  normalizeCustomerPhone,
  partitionUniqueBookingEvents,
} from "../transactionFeatureEngineering.service.js"

test("same normalized email wins over different customer names", () => {
  const first = buildCustomerIdentity({
    email: " Adityo.Soedigwan @gmail.com ",
    name: "Adityo Wicaksono Soedigwan",
  })
  const second = buildCustomerIdentity({
    email: "adityo.soedigwan@gmail.com",
    name: "Adityo W Soedigwan",
  })

  assert.equal(first.customerIdentity, "EMAIL|adityo.soedigwan@gmail.com")
  assert.equal(second.customerIdentity, first.customerIdentity)
})

test("duplicate booking events are rejected while the first occurrence is accepted", () => {
  const bookingEventKey = "SES-00001-BB-20250101-0800"
  const result = partitionUniqueBookingEvents([
    { rowNumber: 1, bookingEventKey },
    { rowNumber: 2, bookingEventKey },
  ])

  assert.deepEqual(result.accepted.map((item) => item.rowNumber), [1])
  assert.deepEqual(result.duplicates.map((item) => item.rowNumber), [2])
})

test("phone is a strong identity and name is used only when phone is unusable", () => {
  const first = buildCustomerIdentity({
    name: "  Aditya   25 Basketball ",
    phone: "081315235649",
  })
  const second = buildCustomerIdentity({
    name: "aditya 25 basketball",
    phone: "0000000000",
  })

  assert.equal(first.customerIdentity, "PHONE|81315235649")
  assert.equal(second.customerIdentity, "NAME|ADITYA 25 BASKETBALL")
})

test("valid phone is used when email is unavailable", () => {
  assert.equal(
    buildCustomerIdentity({ email: "n/a", name: "-", phone: "(0813) 1523-5649" })
      .customerIdentity,
    "PHONE|81315235649"
  )
})

test("scientific-notation and zero-padded default phone numbers are treated as garbage", () => {
  for (const garbage of [
    "6.28E+12",
    "8.1315235649E+10",
    "6200000000000",
    "6280000000000",
    "6290000000000",
    "629000000000",
    "6200000000",
  ]) {
    assert.equal(normalizeCustomerPhone(garbage), null, garbage)
  }
  assert.equal(normalizeCustomerPhone("081315235649"), "81315235649")
})

test("garbage phone falls back to name or email when building an identity", () => {
  const byName = buildCustomerIdentity({
    email: "n/a",
    name: "Aditya 25 Basketball",
    phone: "6.28E+12",
  })
  assert.equal(byName.customerIdentity, "NAME|ADITYA 25 BASKETBALL")

  const byEmail = buildCustomerIdentity({
    email: "adit@gmail.com",
    name: "Aditya",
    phone: "6.28E+12",
  })
  assert.equal(byEmail.customerIdentity, "EMAIL|adit@gmail.com")
})

test("booking event keys are deterministic per customer, venue, date, and start time", () => {
  const base = {
    customerKey: "CUST-00125",
    court: "Mini-Soccer",
    courtType: "mini_soccer",
    playDate: new Date(2025, 0, 1),
    startHour: "15:00",
  }
  const key = buildBookingEventKey(base)

  assert.equal(key, "SES-00125-MS-20250101-1500")
  assert.equal(buildBookingEventKey(base), key)
  assert.notEqual(buildBookingEventKey({ ...base, startHour: "16:00" }), key)
  assert.notEqual(
    buildBookingEventKey({ ...base, court: "Basketball", courtType: "basketball" }),
    key
  )
})
