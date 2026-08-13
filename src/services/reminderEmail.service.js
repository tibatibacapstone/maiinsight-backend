import { env } from "../config/env.js"
import { createTransporter } from "./email.service.js"

const SEVERITY = {
  critical: {
    label: "Critical",
    badgeBg: "#dc2626",
    badgeBgLight: "#fef2f2",
    badgeBorder: "#fecaca",
    dot: "#dc2626",
  },
  warning: {
    label: "Warning",
    badgeBg: "#d97706",
    badgeBgLight: "#fffbeb",
    badgeBorder: "#fde68a",
    dot: "#d97706",
  },
  resolved: {
    label: "Resolved",
    badgeBg: "#059669",
    badgeBgLight: "#ecfdf5",
    badgeBorder: "#a7f3d0",
    dot: "#059669",
  },
}

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const rowHtml = (row) => `
  <tr>
    <td style="padding:12px 16px;font-size:14px;color:#334155;border-top:1px solid #e2e8f0;">
      <span style="font-weight:600;color:#0f172a;">${esc(row.name)}</span>
      ${row.note ? `<br/><span style="font-size:12px;color:#64748b;">${esc(row.note)}</span>` : ""}
    </td>
    <td style="padding:12px 16px;font-size:14px;color:#334155;border-top:1px solid #e2e8f0;white-space:nowrap;">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${row.color};vertical-align:middle;margin-right:6px;"></span>
      <span style="vertical-align:middle;font-weight:600;color:${row.color === "#059669" ? "#047857" : row.color};">${esc(row.label)}</span>
    </td>
    <td style="padding:12px 16px;font-size:14px;color:#475569;border-top:1px solid #e2e8f0;">${esc(row.detail)}</td>
  </tr>
`

export const buildReminderEmailHtml = ({
  severity,
  title,
  intro,
  rows,
  note = null,
  checkedAt,
  ctaUrl = env.appUrl || env.clientUrl,
}) => {
  const meta = SEVERITY[severity] || SEVERITY.warning
  const rowsContent = rows?.length
    ? `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:10px 16px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e2e8f0;">Integration</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e2e8f0;">Status</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:1px solid #e2e8f0;">Detail</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(rowHtml).join("")}
      </tbody>
    </table>
  `
    : ""

  const noteContent = note
    ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;">${esc(note)}</p>`
    : ""

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#065f46 0%,#064e3b 100%);padding:32px 40px 28px;">
              <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.28em;color:#38bdf8;font-weight:700;">MAIIN GANDARIA</p>
              <p style="margin:0;font-size:28px;color:#ffffff;font-weight:800;letter-spacing:-0.02em;">MaiinSight</p>
              <p style="margin:4px 0 0;font-size:13px;color:#a7f3d0;">Marketing Decision Support System</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 8px;">
              <span style="display:inline-block;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.06em;color:${meta.badgeBg};background:${meta.badgeBgLight};border:1px solid ${meta.badgeBorder};">${meta.label}</span>
              <h1 style="margin:16px 0 8px;font-size:22px;color:#0f172a;line-height:1.3;">${esc(title)}</h1>
              <p style="margin:0;font-size:15px;color:#475569;line-height:1.6;">${esc(intro)}</p>
              ${rowsContent}
              ${noteContent}
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
                <tr>
                  <td style="border-radius:8px;">
                    <a href="${esc(ctaUrl)}" style="display:inline-block;padding:12px 28px;background:#059669;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">Open MaiinSight</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 28px;font-size:12px;color:#94a3b8;line-height:1.6;">
              <p style="margin:16px 0 0;border-top:1px solid #e2e8f0;padding-top:16px;">
                Checked at ${esc(checkedAt)}. This is an automated system health reminder — please do not reply to this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#64748b;">&copy; 2026 MAIIN Gandaria. All rights reserved.</p>
              <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">MaiinSight — Marketing Decision Support System</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export const buildReminderEmailText = ({ title, intro, rows, note, checkedAt, ctaUrl }) => {
  const lines = [title, "", intro, ""]
  if (rows?.length) {
    lines.push("Integration | Status | Detail")
    lines.push("-----------|--------|-------")
    for (const row of rows) {
      lines.push(`${row.name} | ${row.label} | ${row.detail}`)
    }
    lines.push("")
  }
  if (note) {
    lines.push(note, "")
  }
  lines.push(`Open MaiinSight: ${ctaUrl}`)
  lines.push("", `Checked at ${checkedAt}. This is an automated system health reminder.`)
  return lines.join("\n")
}

export const sendIntegrationReminderEmail = async (
  {
    to,
    subject,
    severity,
    title,
    intro,
    rows,
    note = null,
    checkedAt,
  },
  { transporter = createTransporter(), logger = console } = {},
) => {
  if (!to || !subject) {
    throw new Error("Reminder email requires a recipient and subject")
  }

  const ctaUrl = env.appUrl || env.clientUrl

  if (!transporter) {
    logger.warn("[mail] Reminder email delivery skipped.", {
      type: "integration_reminder",
      delivery: "skipped",
      reason: "smtp_not_configured",
      to,
    })
    return { skipped: true, to }
  }

  const html = buildReminderEmailHtml({ severity, title, intro, rows, note, checkedAt, ctaUrl })
  const text = buildReminderEmailText({ title, intro, rows, note, checkedAt, ctaUrl })

  await transporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
    html,
  })

  return { skipped: false, to }
}
