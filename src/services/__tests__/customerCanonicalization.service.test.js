import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCustomerUpsertCandidates,
  syncCustomersForTransactions,
} from "../customerCanonicalization.service.js"

test("buildCustomerUpsertCandidates keeps the richest candidate per customer key", () => {
  const candidates = buildCustomerUpsertCandidates([
    {
      customerKey: "EMAIL:test@example.com",
      customerName: "Test User",
      normalizedEmail: "test@example.com",
      customerKeyType: "email",
      customerKeyConfidence: "high",
    },
    {
      customerKey: "EMAIL:test@example.com",
      customerName: "Test User",
      normalizedEmail: "test@example.com",
      normalizedPhone: "8123456789",
      customerProfile: "vip",
      customerKeyType: "email",
      customerKeyConfidence: "high",
    },
  ])

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].phone, "8123456789")
  assert.equal(candidates[0].customerProfile, "vip")
})

test("syncCustomersForTransactions upserts customers and links transactions", async () => {
  const upsertCalls = []
  const updateManyCalls = []
  const prismaClient = {
    customer: {
      upsert: async (payload) => {
        upsertCalls.push(payload)
        return payload.create
      },
      findMany: async () => [
        { id: 11, customerKey: "EMAIL:test@example.com" },
        { id: 12, customerKey: "PHONE:8123456789" },
      ],
    },
    facilityTransaction: {
      updateMany: async (payload) => {
        updateManyCalls.push(payload)
        return { count: payload.where.id.in.length }
      },
    },
  }

  const summary = await syncCustomersForTransactions(prismaClient, [
    {
      id: 1,
      customerKey: "EMAIL:test@example.com",
      customerName: "Test User",
      normalizedEmail: "test@example.com",
      customerKeyType: "email",
      customerKeyConfidence: "high",
    },
    {
      id: 2,
      customerKey: "PHONE:8123456789",
      customerName: "Phone User",
      normalizedPhone: "8123456789",
      customerKeyType: "phone",
      customerKeyConfidence: "medium",
    },
  ])

  assert.equal(upsertCalls.length, 2)
  assert.equal(updateManyCalls.length, 2)
  assert.deepEqual(summary, {
    customerCount: 2,
    linkedTransactionCount: 2,
  })
})

