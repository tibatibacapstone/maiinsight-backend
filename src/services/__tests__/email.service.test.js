import assert from "node:assert/strict"
import test from "node:test"

import { sendActivationEmail, sendPasswordResetEmail } from "../email.service.js"

const activationToken = "FAKE-ACTIVATION-BEARER-TOKEN-DO-NOT-LOG"
const resetToken = "FAKE-RESET-BEARER-TOKEN-DO-NOT-LOG"
const activationUrl = `https://example.test/activate?token=${activationToken}`
const resetUrl = `https://example.test/reset-password?token=${resetToken}`

const captureLogs = () => {
  const calls = []
  const capture = (...values) => calls.push(values)
  return {
    calls,
    logger: { warn: capture, error: capture, info: capture, log: capture },
    output: () => JSON.stringify(calls),
  }
}

test("missing SMTP logs only sanitized activation metadata", async () => {
  const captured = captureLogs()
  const result = await sendActivationEmail(
    { to: "invitee@example.test", name: "Invitee", role: "operational", activationUrl },
    { transporter: null, logger: captured.logger },
  )

  const output = captured.output()
  assert.deepEqual(result, { skipped: true })
  assert.equal(output.includes(activationUrl), false)
  assert.equal(output.includes(activationToken), false)
  assert.match(output, /activation/)
  assert.match(output, /smtp_not_configured/)
})

test("missing SMTP logs only sanitized password-reset metadata", async () => {
  const captured = captureLogs()
  const result = await sendPasswordResetEmail(
    { to: "user@example.test", name: "User", resetUrl },
    { transporter: null, logger: captured.logger },
  )

  const output = captured.output()
  assert.deepEqual(result, { skipped: true })
  assert.equal(output.includes(resetUrl), false)
  assert.equal(output.includes(resetToken), false)
  assert.match(output, /password_reset/)
  assert.match(output, /smtp_not_configured/)
})

test("SMTP failure propagates without logging token-bearing content", async () => {
  const captured = captureLogs()
  const transporter = {
    sendMail: async () => {
      throw new Error("simulated SMTP failure")
    },
  }

  await assert.rejects(
    sendActivationEmail(
      { to: "invitee@example.test", name: "Invitee", role: "operational", activationUrl },
      { transporter, logger: captured.logger },
    ),
    /simulated SMTP failure/,
  )
  await assert.rejects(
    sendPasswordResetEmail(
      { to: "user@example.test", name: "User", resetUrl },
      { transporter, logger: captured.logger },
    ),
    /simulated SMTP failure/,
  )

  const output = captured.output()
  assert.equal(output.includes(activationToken), false)
  assert.equal(output.includes(resetToken), false)
  assert.equal(output, "[]")
})

test("successful activation and reset delivery remains unchanged", async () => {
  const sent = []
  const captured = captureLogs()
  const transporter = {
    sendMail: async (message) => sent.push(message),
  }

  const activationResult = await sendActivationEmail(
    { to: "invitee@example.test", name: "Invitee", role: "operational", activationUrl },
    { transporter, logger: captured.logger },
  )
  const resetResult = await sendPasswordResetEmail(
    { to: "user@example.test", name: "User", resetUrl },
    { transporter, logger: captured.logger },
  )

  assert.deepEqual(activationResult, { skipped: false })
  assert.deepEqual(resetResult, { skipped: false })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].text.includes(activationUrl), true)
  assert.equal(sent[0].html.includes(activationUrl), true)
  assert.equal(sent[1].text.includes(resetUrl), true)
  assert.equal(sent[1].html.includes(resetUrl), true)
  assert.equal(captured.output(), "[]")
})
