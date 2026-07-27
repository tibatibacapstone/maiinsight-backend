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

test("missing email uses normalized uppercase name before phone", () => {
  const first = buildCustomerIdentity({
    name: "  Aditya   25 Basketball ",
    phone: "081315235649",
  })
  const second = buildCustomerIdentity({
    name: "aditya 25 basketball",
    phone: "0000000000",
  })

  assert.equal(first.customerIdentity, "NAME|ADITYA 25 BASKETBALL")
  assert.equal(second.customerIdentity, first.customerIdentity)
})

test("valid phone is used only when email and name are unavailable", () => {
  assert.equal(
    buildCustomerIdentity({ email: "n/a", name: "-", phone: "(0813) 1523-5649" })
      .customerIdentity,
    "PHONE|81315235649"
  )
  assert.equal(normalizeCustomerPhone("8.1315235649E+10"), "81315235649")
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
