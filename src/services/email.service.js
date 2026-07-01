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

export const sendActivationEmail = async ({ to, name, role, activationUrl }) => {
  if (!to || !name || !activationUrl) {
    throw new Error("Activation email requires recipient, name, and activation URL")
  }

  const transporter = createTransporter()
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
    console.warn("[mail] SMTP is not configured. Activation email not sent:", { to, activationUrl })
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
