import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const source = fs.readFileSync(new URL("../importRoutes.js", import.meta.url), "utf8")

test("the attributed job is created before validation but transaction data remains atomic", () => {
  const validationIndex = source.indexOf("validateTransactionRows(parsedRecords)")
  const batchCreateIndex = source.indexOf("batch = await prisma.importBatch.create")
  const actorIndex = source.indexOf("performedByUserId: req.user.userId", batchCreateIndex)
  const rawCreateIndex = source.indexOf("await prisma.rawTransactionTable.createMany")
  const transactionCreateIndex = source.indexOf("await prisma.facilityTransaction.create")

  assert.ok(validationIndex >= 0)
  assert.ok(batchCreateIndex < validationIndex)
  assert.ok(actorIndex > batchCreateIndex && actorIndex < validationIndex)
  assert.ok(rawCreateIndex > validationIndex)
  assert.ok(transactionCreateIndex > validationIndex)
})

test("invalid row data uses the existing friendly validation error contract", () => {
  assert.match(source, /buildFriendlyImportFailure\(error\)/)
  assert.match(source, /return res\.status\(statusCode\)\.json\(friendlyFailure\)/)
})

test("the order-ID anomaly gate runs before raw rows are persisted", () => {
  const scanIndex = source.indexOf("detectOrderIdAnomalies(parsedRecords)")
  const rawCreateIndex = source.indexOf("await prisma.rawTransactionTable.createMany")
  const batchDeleteIndex = source.indexOf("await prisma.importBatch.delete")
  const confirmIndex = source.indexOf("req.body?.confirmImport")
  const conflictIndex = source.indexOf("IMPORT_ORDER_ID_ANOMALY")

  assert.ok(scanIndex >= 0)
  assert.ok(scanIndex < rawCreateIndex)
  assert.ok(confirmIndex >= 0 && confirmIndex < rawCreateIndex)
  assert.ok(batchDeleteIndex >= 0 && batchDeleteIndex < rawCreateIndex)
  assert.ok(conflictIndex >= 0 && conflictIndex > batchDeleteIndex)
})
