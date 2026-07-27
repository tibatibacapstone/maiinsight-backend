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

test("status aliases map to canonical customer categories without changing membership", () => {
  const completed = classifyTransactionStatus(" Payment   Completed ")
  const manual = classifyTransactionStatus("Manual Booking")

  assert.equal(completed.category, TRANSACTION_ROW_CATEGORIES.CUSTOMER)
  assert.equal(completed.bookingType, "membership")
  assert.equal(manual.canonicalStatus, "Manual/Walk-in")
  assert.equal(manual.bookingType, "non_membership")
})

test("operational statuses map to canonical STATUS and SYS identities", () => {
  assert.deepEqual(
    [
      classifyTransactionStatus("Internal"),
      classifyTransactionStatus("Tutup"),
      classifyTransactionStatus("Maintenance"),
      classifyTransactionStatus("Tutup / Maintenance"),
    ].map(({ customerIdentity, customerKey }) => ({ customerIdentity, customerKey })),
    [
      { customerIdentity: "STATUS|INTERNAL", customerKey: "SYS-INTERNAL" },
      { customerIdentity: "STATUS|TUTUP", customerKey: "SYS-TUTUP" },
      { customerIdentity: "STATUS|MAINTENANCE", customerKey: "SYS-MAINTENANCE" },
      {
        customerIdentity: "STATUS|TUTUP_MAINTENANCE",
        customerKey: "SYS-TUTUP-MAINTENANCE",
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
  assert.equal(getDashboardTransactionGroup("Payment Completed"), "membership")
  assert.equal(getDashboardTransactionGroup("Manual Booking"), "non_membership")

  for (const status of [
    "Internal",
    "Tutup",
    "Maintenance",
    "Tutup/Maintenance",
    "Closed/Maintenance",
  ]) {
    assert.equal(getDashboardTransactionGroup(status), "internal")
  }

  assert.equal(getDashboardTransactionGroup("Booking Cancelled"), "excluded")
})

test("dashboard group filter accepts canonical values and compatibility labels", () => {
  assert.equal(normalizeDashboardTransactionGroup("All"), DASHBOARD_TRANSACTION_GROUPS.ALL)
  assert.equal(
    normalizeDashboardTransactionGroup("Membership"),
    DASHBOARD_TRANSACTION_GROUPS.MEMBERSHIP
  )
  assert.equal(
    normalizeDashboardTransactionGroup("Non Membership"),
    DASHBOARD_TRANSACTION_GROUPS.NON_MEMBERSHIP
  )
  assert.equal(
    normalizeDashboardTransactionGroup("internal"),
    DASHBOARD_TRANSACTION_GROUPS.INTERNAL
  )
  assert.equal(normalizeDashboardTransactionGroup("unknown"), null)
})
