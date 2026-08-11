import nodemailer from "nodemailer"

import { env } from "../config/env.js"

const hasSmtpConfig = Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPass)

const createTransporter = () => {
  if (!hasSmtpConfig) {
    return null
  }

  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
  })
}

export const sendActivationEmail = async (
  { to, name, role, activationUrl },
  { transporter = createTransporter(), logger = console } = {},
) => {
  if (!to || !name || !activationUrl) {
    throw new Error("Activation email requires recipient, name, and activation URL")
  }

  const subject = "Activate your MaiinSight account"
  const text = [
    `Hi ${name},`,
    "",
    "Your MaiinSight account is ready.",
    `Role: ${role}`,
    "",
    `Activate your account and set your password here: ${activationUrl}`,
    "",
    "This link can only be used once and expires automatically.",
  ].join("\n")

  const html = `
    <p>Hi ${name},</p>
    <p>Your MaiinSight account is ready.</p>
    <p><strong>Role:</strong> ${role}</p>
    <p><a href="${activationUrl}">Activate your account</a> and set your password.</p>
    <p>This link can only be used once and expires automatically.</p>
  `

  if (!transporter) {
    logger.warn("[mail] Email delivery skipped.", {
      type: "activation",
      delivery: "skipped",
      reason: "smtp_not_configured",
    })
    return { skipped: true }
  }

  await transporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
    html,
  })

  return { skipped: false }
}

export const sendPasswordResetEmail = async (
  { to, name, resetUrl },
  { transporter = createTransporter(), logger = console } = {},
) => {
  if (!to || !name || !resetUrl) {
    throw new Error("Password reset email requires recipient, name, and reset URL")
  }

  const subject = "Reset your MaiinSight password"
  const text = [
    `Hi ${name},`,
    "",
    "We received a request to reset your MaiinSight password.",
    "",
    `Click here to reset your password: ${resetUrl}`,
    "",
    "This link expires in 1 hour. If you did not request this, ignore this email.",
  ].join("\n")

  const html = `
    <p>Hi ${name},</p>
    <p>We received a request to reset your MaiinSight password.</p>
    <p><a href="${resetUrl}">Reset your password</a></p>
    <p>This link expires in 1 hour. If you did not request this, ignore this email.</p>
  `

  if (!transporter) {
    logger.warn("[mail] Email delivery skipped.", {
      type: "password_reset",
      delivery: "skipped",
      reason: "smtp_not_configured",
    })
    return { skipped: true }
  }

  await transporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
    html,
  })

  return { skipped: false }
}
