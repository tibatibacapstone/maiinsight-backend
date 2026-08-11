import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8")
const importRoutes = read("../importRoutes.js")
const metaRoutes = read("../meta.routes.js")
const segmentationRoutes = read("../segmentation.routes.js")
const aiRoutes = read("../aiStrategyRoute.js")
const metaService = read("../../services/meta.service.js")
const segmentationService = read("../../services/rfmSegmentation.service.js")
const schema = read("../../../prisma/schema.prisma")
const migration = read("../../../prisma/migrations/20260811100000_add_sync_job_user_attribution/migration.sql")

test("successful and failed file imports persist the authenticated actor", () => {
  const actorCreateIndex = importRoutes.indexOf("performedByUserId: req.user.userId")
  const parseIndex = importRoutes.indexOf("parsedRecords = parseUploadedTransactionFile(req.file)")
  const validationIndex = importRoutes.indexOf("validateTransactionRows(parsedRecords)")

  assert.ok(actorCreateIndex > -1)
  assert.ok(actorCreateIndex < parseIndex)
  assert.ok(actorCreateIndex < validationIndex)
  assert.match(
    importRoutes,
    /createFailedImportHistory\(\{[\s\S]*?performedByUserId:\s*req\.user\.userId/
  )
  assert.match(importRoutes, /friendlyFailure\.batchId\s*=\s*failedBatch\.id/)
  assert.doesNotMatch(importRoutes, /performedByUserId:\s*req\.user\?\.userId\s*\|\|\s*null/)
})

test("import status updates preserve the actor assigned when the batch was created", () => {
  const failedUpdate = importRoutes.match(
    /if \(batch\?\.id\)[\s\S]*?prisma\.importBatch\.update\([\s\S]*?friendlyFailure\.batchId = batch\.id/
  )?.[0] || ""

  assert.match(failedUpdate, /status:\s*"failed"/)
  assert.doesNotMatch(failedUpdate, /performedByUserId/)
})

test("Meta, segmentation, and AI jobs capture the triggering authenticated user", () => {
  assert.match(metaRoutes, /syncMetaRawToAnalytics\(\{\s*performedByUserId:\s*req\.user\.userId\s*\}\)/)
  assert.match(metaService, /metaSyncLog\.create\([\s\S]*?performedByUserId/)
  assert.match(segmentationRoutes, /runRfmSegmentation\(input,\s*\{[\s\S]*?performedByUserId:\s*req\.user\.userId/)
  assert.match(segmentationService, /segmentationRun\.create\([\s\S]*?performedByUserId/)
  assert.match(aiRoutes, /aiStrategy\.create\([\s\S]*?performedByUserId:\s*req\.user\.userId/)
})

test("Sync Jobs API returns actor summaries without using the current viewer", () => {
  assert.match(importRoutes, /const actorSelect = \{ id: true, name: true, email: true \}/)
  assert.match(importRoutes, /performedBy:\s*\{ select: actorSelect \}/)
  assert.doesNotMatch(importRoutes, /performedBy:\s*req\.user/)
  assert.match(importRoutes, /performedBy:\s*job\.performedBy/)
  assert.match(importRoutes, /performedBy:\s*job\.user/)
})

test("the represented manual database refresh is persisted through its attributed activity", () => {
  assert.match(importRoutes, /"\/manual-sync"[\s\S]*?DATA_CENTER_DATABASE_REFRESH/)
  assert.match(importRoutes, /where:\s*\{ action:\s*"DATA_CENTER_DATABASE_REFRESH" \}/)
  assert.match(importRoutes, /performedBy:\s*job\.user/)
})

test("nullable actor relations preserve legacy rows and migration is non-destructive", () => {
  for (const model of ["ImportBatch", "MetaSyncLog", "SegmentationRun", "AiStrategy"]) {
    const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] || ""
    assert.match(block, /performedByUserId\s+Int\?/)
  }
  assert.doesNotMatch(migration, /DELETE\s+FROM|TRUNCATE|DROP TABLE/i)
  assert.equal((migration.match(/ADD COLUMN `performedByUserId` INTEGER NULL/g) || []).length, 4)
})
