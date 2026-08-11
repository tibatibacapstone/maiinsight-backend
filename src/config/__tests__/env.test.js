import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import {
  getRequiredJwtSecret,
  requireEnvironmentSecret,
  validateRuntimeEnvironment,
} from "../env.js"

const runCleanImport = (moduleUrl) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "maiinsight-env-test-"))
  const childEnvironment = { ...process.env }
  delete childEnvironment.JWT_SECRET
  try {
    return spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(moduleUrl)})`],
      {
        cwd: temporaryDirectory,
        env: childEnvironment,
        encoding: "utf8",
      }
    )
  } finally {
    const resolvedTemporaryDirectory = resolve(temporaryDirectory)
    const resolvedTempRoot = resolve(tmpdir())
    assert.equal(resolvedTemporaryDirectory.startsWith(resolvedTempRoot), true)
    rmSync(resolvedTemporaryDirectory, { recursive: true, force: true })
  }
}

test("env module remains importable without JWT_SECRET in a clean environment", () => {
  const result = runCleanImport(new URL("../env.js", import.meta.url).href)
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`)
})

test("runtime validation rejects missing JWT secret and accepts explicit configuration", () => {
  assert.throws(
    () => validateRuntimeEnvironment({ jwtSecret: "" }),
    /Invalid runtime environment: JWT_SECRET is required/
  )
  assert.doesNotThrow(() =>
    validateRuntimeEnvironment({ jwtSecret: "explicit-test-secret" })
  )
})

test("required JWT accessor rejects empty values and never supplies a fallback", () => {
  assert.throws(() => getRequiredJwtSecret(""), /JWT_SECRET is required/)
  assert.throws(() => requireEnvironmentSecret(undefined, "JWT_SECRET"), /JWT_SECRET is required/)
  assert.equal(
    getRequiredJwtSecret(" explicit-test-secret "),
    "explicit-test-secret"
  )
})

test("server startup fails before listening when JWT_SECRET is missing", () => {
  const result = runCleanImport(new URL("../../server.js", import.meta.url).href)
  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stderr}${result.stdout}`,
    /Invalid runtime environment: JWT_SECRET is required/
  )
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /MaiinSight API is running/)
})
