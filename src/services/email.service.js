import nodemailer from "nodemailer"

import { prisma } from "../config/prisma.js"
import { env } from "../config/env.js"

const hasSmtpConfig = Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPass)

export const createTransporter = () => {
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

export const sendBulkRoleEmail = async ({ roles, subject, html, text }) => {
  if (!roles || !roles.length || !subject) {
    return { sent: 0, skipped: true }
  }

  const transporter = createTransporter()

  if (!transporter) {
    console.warn("[mail] SMTP is not configured. Bulk email not sent to roles:", roles)
    return { sent: 0, skipped: true }
  }

  const users = await prisma.user.findMany({
    where: { role: { in: roles } },
    select: { email: true, name: true },
  })

  if (!users.length) {
    return { sent: 0, skipped: true }
  }

  let sent = 0
  for (const user of users) {
    try {
      const personalizedHtml = (html || "").replace(/\{\{name\}\}/g, user.name).replace(/\{\{email\}\}/g, user.email)
      const personalizedText = (text || "").replace(/\{\{name\}\}/g, user.name).replace(/\{\{email\}\}/g, user.email)

      await transporter.sendMail({
        from: env.smtpFrom,
        to: user.email,
        subject,
        text: personalizedText || personalizedHtml.replace(/<[^>]*>/g, ""),
        html: personalizedHtml,
      })
      sent++
    } catch (error) {
      console.warn(`[mail] Failed to send to ${user.email}:`, error instanceof Error ? error.message : error)
    }
  }

  return { sent, skipped: false }
}

export const sendPasswordResetEmail = async ({ to, name, resetUrl }) => {
  if (!to || !name || !resetUrl) {
    throw new Error("Password reset email requires recipient, name, and reset URL")
  }

  const transporter = createTransporter()
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
    console.warn("[mail] SMTP is not configured. Password reset email not sent:", { to, resetUrl })
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

export const sendConfirmationCodeEmail = async ({ to, name, code }) => {
  if (!to || !code) {
    throw new Error("Confirmation code email requires recipient and code")
  }

  const transporter = createTransporter()
  const subject = "Your MaiinSight confirmation code"
  const text = [
    `Hi ${name || "there"},`,
    "",
    `Your confirmation code is: ${code}`,
    "",
    "This code expires in 10 minutes. If you did not request this, you can safely ignore this email.",
  ].join("\n")

  const html = `
    <p>Hi ${name || "there"},</p>
    <p>Your confirmation code is:</p>
    <p style="font-size:24px;font-weight:bold;letter-spacing:4px;padding:12px 16px;background:#f4f7f6;border-radius:8px;display:inline-block;">${code}</p>
    <p>This code expires in <strong>10 minutes</strong>. If you did not request this, you can safely ignore this email.</p>
  `

  if (!transporter) {
    console.warn("[mail] SMTP is not configured. Confirmation code email not sent:", { to })
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
