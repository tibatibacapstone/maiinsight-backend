import test from "node:test"
import assert from "node:assert/strict"

import {
  DASHBOARD_TRANSACTION_GROUPS,
  classifyTransactionRevenue,
  classifyTransactionStatus,
  getDashboardTransactionGroup,
  normalizeDashboardTransactionGroup,
  TRANSACTION_ROW_CATEGORIES,
} from "../transactionStatus.service.js"

test("status aliases map to canonical customer categories with channel booking types", () => {
  const completed = classifyTransactionStatus(" Payment   Completed ")
  const manual = classifyTransactionStatus("Manual Booking")

  assert.equal(completed.category, TRANSACTION_ROW_CATEGORIES.CUSTOMER)
  assert.equal(completed.bookingType, "GeloraApp Booking")
  assert.equal(manual.canonicalStatus, "Manual/Walk-in")
  assert.equal(manual.bookingType, "Manual/Walk-in")
})

test("operational statuses map to canonical STATUS and SYS identities", () => {
  assert.deepEqual(
    [
      classifyTransactionStatus("Internal"),
      classifyTransactionStatus("Tutup"),
      classifyTransactionStatus("Maintenance"),
      classifyTransactionStatus("Tutup / Maintenance"),
    ].map(({ customerIdentity, customerKey, bookingType }) => ({
      customerIdentity,
      customerKey,
      bookingType,
    })),
    [
      { customerIdentity: "STATUS|INTERNAL", customerKey: "SYS-INTERNAL", bookingType: "Internal" },
      {
        customerIdentity: "STATUS|TUTUP_MAINTENANCE",
        customerKey: "SYS-TUTUP-MAINTENANCE",
        bookingType: "Tutup/Maintenance",
      },
      {
        customerIdentity: "STATUS|TUTUP_MAINTENANCE",
        customerKey: "SYS-TUTUP-MAINTENANCE",
        bookingType: "Tutup/Maintenance",
      },
      {
        customerIdentity: "STATUS|TUTUP_MAINTENANCE",
        customerKey: "SYS-TUTUP-MAINTENANCE",
        bookingType: "Tutup/Maintenance",
      },
    ]
  )
})

test("customer revenue classification separates skipped and accepted rows", () => {
  assert.equal(
    classifyTransactionRevenue({
      baseRevenue: "100000",
      addOnRevenue: "25000",
      category: TRANSACTION_ROW_CATEGORIES.CUSTOMER,
    }).netRevenue,
    125000
  )
  assert.equal(
    classifyTransactionRevenue({
      baseRevenue: "invalid",
      addOnRevenue: "0",
      category: TRANSACTION_ROW_CATEGORIES.CUSTOMER,
    }).shouldSkip,
    true
  )
})

test("dashboard groups reuse canonical status classification", () => {
  assert.equal(getDashboardTransactionGroup("Payment Completed"), "GeloraApp Booking")
  assert.equal(getDashboardTransactionGroup("Manual Booking"), "Manual/Walk-in")

  assert.equal(getDashboardTransactionGroup("Internal"), "Internal")

  for (const status of [
    "Tutup",
    "Maintenance",
    "Tutup/Maintenance",
    "Closed/Maintenance",
  ]) {
    assert.equal(getDashboardTransactionGroup(status), "Tutup/Maintenance")
  }

  assert.equal(getDashboardTransactionGroup("Booking Cancelled"), "excluded")
})

test("dashboard group filter accepts canonical values and compatibility labels", () => {
  assert.equal(normalizeDashboardTransactionGroup("All"), DASHBOARD_TRANSACTION_GROUPS.ALL)
  assert.equal(
    normalizeDashboardTransactionGroup("Membership"),
    DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN
  )
  assert.equal(
    normalizeDashboardTransactionGroup("Non Membership"),
    DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING
  )
  assert.equal(
    normalizeDashboardTransactionGroup("GeloraApp Booking"),
    DASHBOARD_TRANSACTION_GROUPS.GELORA_APP_BOOKING
  )
  assert.equal(
    normalizeDashboardTransactionGroup("Manual/Walk-in"),
    DASHBOARD_TRANSACTION_GROUPS.MANUAL_WALK_IN
  )
  assert.equal(
    normalizeDashboardTransactionGroup("internal"),
    DASHBOARD_TRANSACTION_GROUPS.INTERNAL
  )
  assert.equal(
    normalizeDashboardTransactionGroup("blocked"),
    DASHBOARD_TRANSACTION_GROUPS.TUTUP_MAINTENANCE
  )
  assert.equal(normalizeDashboardTransactionGroup("unknown"), null)
})
