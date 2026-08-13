import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import PptxGenJS from "pptxgenjs"

import { prisma } from "../config/prisma.js"
import { buildConfigSnapshot } from "./appConfig.service.js"

const PRESENTATION_THEMES = {
  executive: {
    id: "executive",
    label: "Executive Navy",
    description: "Navy gelap dengan aksen emas — klasik untuk boardroom",
    colors: {
      background: "0B1F3A",
      surface: "132B4E",
      primary: "FFFFFF",
      accent: "F5C451",
      text: "D9E2F0",
      muted: "9FB0CC",
      border: "2A4468",
      negative: "F87171",
    },
  },
  emerald: {
    id: "emerald",
    label: "Forest Emerald",
    description: "Hijau hutan dengan aksen lime segar dan modern",
    colors: {
      background: "0F3D2E",
      surface: "14513B",
      primary: "FFFFFF",
      accent: "D9F99D",
      text: "E2F4EA",
      muted: "A9CDB8",
      border: "23624A",
      negative: "FCA5A5",
    },
  },
  slate: {
    id: "slate",
    label: "Slate Modern",
    description: "Slate gelap dengan aksen biru langit — bersih & futuristik",
    colors: {
      background: "0F172A",
      surface: "1E293B",
      primary: "FFFFFF",
      accent: "38BDF8",
      text: "E2E8F0",
      muted: "94A3B8",
      border: "334155",
      negative: "F87171",
    },
  },
  burgundy: {
    id: "burgundy",
    label: "Burgundy Classic",
    description: "Merah anggur dengan aksen krem — premium & elegan",
    colors: {
      background: "43101F",
      surface: "571B2C",
      primary: "FFFFFF",
      accent: "E8C4A0",
      text: "F3E4DA",
      muted: "C9A79B",
      border: "6E2438",
      negative: "FCA5A5",
    },
  },
}

const VALID_THEME_IDS = Object.keys(PRESENTATION_THEMES)

export const getPresentationThemes = () =>
  Object.values(PRESENTATION_THEMES).map((theme) => ({
    id: theme.id,
    label: theme.label,
    description: theme.description,
    colors: theme.colors,
  }))

export const isValidPresentationTheme = (themeId) => VALID_THEME_IDS.includes(themeId)

const getTheme = (themeId) => PRESENTATION_THEMES[themeId] || PRESENTATION_THEMES.executive

const MAIIN_CONTACT = {
  address: "Jl. Ciputat Raya No. 2A, Kebayoran Lama Utara, Jakarta Selatan",
  phone: "(021) 582-1303 / (021) 582-0476",
  instagram: "@maiin.gandaria",
  booking: "Booking online: Gelora.id",
  hours: "Senin“Jumat 08.00“22.00 WIB · Sabtu“Minggu 06.00“22.00 WIB",
}

const SESSION_LABELS = {
  Morning: "Pagi (06“10)",
  Afternoon: "Siang (11“14)",
  Evening: "Sore (15“18)",
  Night: "Malam (19“23)",
}

const toNumber = (value) => Number(value || 0)

const fmtCompactIdr = (value) => {
  const amount = toNumber(value)
  if (Math.abs(amount) >= 1000000000) {
    return `Rp ${(amount / 1000000000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} M`
  }
  if (Math.abs(amount) >= 1000000) {
    return `Rp ${(amount / 1000000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} Jt`
  }
  return `Rp ${Math.round(amount).toLocaleString("id-ID")}`
}

const fmtPct = (value) => `${String(Number(value || 0)).replace(".", ",")}%`

const fmtCount = (value) => Math.round(toNumber(value)).toLocaleString("id-ID")

const deltaLabel = (comparison) => {
  if (!comparison || comparison.changePct == null) return "data pembanding belum tersedia"
  const pct = comparison.changePct.toLocaleString("id-ID", { maximumFractionDigits: 1 })
  return comparison.changePct >= 0 ? `▲ +${pct}%` : `▼ ${pct}%`
}

const formatPeriodLabel = (data) => {
  const fmt = (iso) =>
    new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric" }).format(
      new Date(iso)
    )
  try {
    return `${fmt(data.period.startDate)} “ ${fmt(data.period.endDate)}`
  } catch {
    return data.period.label || ""
  }
}

const formatComparisonPeriodLabel = (data) => {
  const fmt = (iso) =>
    new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric" }).format(
      new Date(iso)
    )
  try {
    return `${fmt(data.comparisonPeriod.startDate)} “ ${fmt(data.comparisonPeriod.endDate)}`
  } catch {
    return data.comparisonPeriod.label || "periode sebelumnya"
  }
}

const sessionLabel = (sessionName) => SESSION_LABELS[sessionName] || sessionName || "—"

const SOFFICE_CANDIDATES = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
]

const findSoffice = () => SOFFICE_CANDIDATES.find((candidate) => existsSync(candidate)) || null

const convertPptxToPdf = (pptxPath, outDir) =>
  new Promise((resolve, reject) => {
    const soffice = findSoffice()

    if (!soffice) {
      return reject(new Error("LibreOffice tidak ditemukan di server."))
    }

    execFile(
      soffice,
      ["--headless", "--convert-to", "pdf", "--outdir", outDir, pptxPath],
      { timeout: 120000 },
      (error) => {
        if (error) return reject(error)

        const pdfPath = path.join(outDir, `${path.basename(pptxPath, ".pptx")}.pdf`)
        return resolve(pdfPath)
      }
    )
  })

const buildGeminiPrompt = (data) => {
  const compactContext = {
    period: data.period.label,
    summary: data.summary,
    comparison: {
      revenue: data.comparison.revenue,
      bookings: data.comparison.bookings,
      occupancyRate: data.comparison.occupancyRate,
      avgRevenuePerBooking: data.comparison.avgRevenuePerBooking,
    },
    courtTypePerformance: data.courtTypePerformance.slice(0, 6).map((item) => ({
      courtLabel: item.courtLabel,
      revenue: item.revenue,
      bookings: item.bookings,
      occupancyRate: item.occupancyRate,
    })),
    sessionOccupancy: data.sessionOccupancy.map((item) => ({
      sessionName: item.sessionName,
      occupancyRate: item.occupancyRate,
      revenue: item.revenue,
    })),
    segmentContribution: data.segmentContribution.slice(0, 5).map((item) => ({
      segmentName: item.segmentName,
      revenue: item.revenue,
      revenueShare: item.revenueShare,
      bookings: item.bookings,
    })),
    revenueTrend: data.revenueTrend.slice(-14).map((item) => ({
      label: item.label,
      revenue: item.revenue,
      bookings: item.bookings,
    })),
    bookingTypeBreakdown: data.bookingTypeBreakdown,
    existingKeyFindings: data.insights.keyFindings,
    existingActionPlan: data.insights.actionPlan,
  }

  return `Kamu adalah analis bisnis untuk MAIIN Gandaria, sport complex (Mini Soccer & Basketball) di Jakarta Selatan.
Kamu membuat slide isi untuk "Management Report" yang disajikan di rapat manajemen.

Data nyata periode berjalan (agregat, tanpa data pribadi):
${JSON.stringify(compactContext, null, 2)}

Tugas: tulis konten slide yang TIDAK berupa informasi umum, tetapi interpretasi data nyata di atas disertai langkah kongkrit ke depan. Semua angka harus berasal dari data yang diberikan. Jangan membuat klaim tentang metrik yang tidak ada di data.

Kembalikan HANYA valid JSON dengan struktur persis berikut (jangan pakai markdown fence):
{
  "executiveSummary": "Ringkasan eksekutif 2-3 kalimat, menyebut angka nyata (revenue, bookings, occupancy, pertumbuhan vs periode sebelumnya) dan pesan utama untuk rapat.",
  "trendNarrative": "1-2 kalimat tentang pola tren revenue/bookings yang benar-benar terlihat di data (mis. hari/sesi yang naik atau turun paling tajam).",
  "courtNarrative": "1-2 kalimat membandingkan performa Mini Soccer vs Basketball berdasarkan angka nyata (revenue, occupancy, bookings).",
  "sessionNarrative": "1-2 kalimat tentang sesi terkuat vs terlemah berdasarkan occupancy dan revenue nyata.",
  "segmentNarrative": "1-2 kalimat tentang segmen pelanggan yang paling berkontribusi berdasarkan revenueShare nyata dan implikasinya.",
  "insights": [
    { "title": "judul insight singkat (maks 8 kata)", "detail": "interpretasi data nyata maks 2 kalimat", "action": "langkah kongkrit 1 kalimat (promo/slot/segmen/channel)" },
    { "title": "", "detail": "", "action": "" },
    { "title": "", "detail": "", "action": "" }
  ],
  "actionPlan": ["langkah kongkrit ke-1 1 kalimat", "langkah 2", "langkah 3", "langkah 4"]
}

Aturan:
- Bahasa Indonesia formal, cocok untuk rapat manajemen.
- Tepat 3 insight dan 4 item actionPlan.
- Insight bukan opini umum; harus interpretasi angka nyata (mis. "Sesi pagi hanya terisi 28% tetapi menyumbang margin terbaik" jika memang data mendukung).
- Action harus kongkrit: sebut slot/sesi, segmen, channel promosi, atau periode, bila didukung data.
- Semua field string biasa. Jangan kembalikan array/objek di luar struktur di atas.`
}

const parseJsonObject = (text) => {
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

const buildFallbackDeckContent = (data) => {
  const insights = data.insights.keyFindings.slice(0, 3).map((finding, index) => ({
    title: `Temuan ${index + 1}`,
    detail: finding,
    action: data.insights.actionPlan[index] || data.insights.recommendations[0] || "",
  }))

  return {
    usedAi: false,
    executiveSummary: data.insights.executiveSummary,
    trendNarrative: data.insights.revenueInsight,
    courtNarrative:
      data.insights.keyFindings[1] || "Perbandingan performa lapangan tersedia di tabel data.",
    sessionNarrative:
      data.insights.keyFindings[3] || "Perbandingan sesi tersedia di tabel data.",
    segmentNarrative:
      data.insights.keyFindings[4] || data.insights.segmentationInsight || "",
    insights,
    actionPlan: data.insights.actionPlan,
  }
}

const generateDeckContent = async ({ data, userId }) => {
  try {
    const config = await buildConfigSnapshot()

    if (!config.geminiApiKey || !config.geminiEnabled) {
      return buildFallbackDeckContent(data)
    }

    const { GoogleGenAI } = await import("@google/genai")
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })
    const model = config.geminiModel || "gemini-1.5-flash"

    const response = await ai.models.generateContent({
      model,
      contents: buildGeminiPrompt(data),
      config: {
        temperature: 0.6,
        maxOutputTokens: 2800,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    })

    const rawText =
      typeof response?.text === "string"
        ? response.text
        : typeof response?.text === "function"
          ? await response.text()
          : Array.isArray(response?.candidates?.[0]?.content?.parts)
            ? response.candidates[0].content.parts
                .map((part) => (typeof part?.text === "string" ? part.text : ""))
                .join("")
                .trim()
            : ""

    const usage = response?.usageMetadata
    if (usage) {
      await prisma.aiUsageLog
        .create({
          data: {
            userId: userId || null,
            model,
            feature: "management_report_presentation",
            promptTokens: usage.promptTokenCount ?? 0,
            candidatesTokens: usage.candidatesTokenCount ?? 0,
            totalTokens: usage.totalTokenCount ?? 0,
          },
        })
        .catch(() => null)
    }

    const parsed = parseJsonObject(rawText)

    if (!parsed) {
      return buildFallbackDeckContent(data)
    }

    const asString = (value, fallback) =>
      typeof value === "string" && value.trim() ? value.trim() : fallback

    const insights = Array.isArray(parsed.insights)
      ? parsed.insights
          .filter((item) => item && typeof item === "object")
          .slice(0, 3)
          .map((item) => ({
            title: asString(item.title, "Insight"),
            detail: asString(item.detail, ""),
            action: asString(item.action, ""),
          }))
      : []

    const actionPlan = Array.isArray(parsed.actionPlan)
      ? parsed.actionPlan.filter((item) => typeof item === "string" && item.trim()).slice(0, 4)
      : []

    const content = {
      usedAi: true,
      executiveSummary: asString(parsed.executiveSummary, data.insights.executiveSummary),
      trendNarrative: asString(parsed.trendNarrative, data.insights.revenueInsight),
      courtNarrative: asString(parsed.courtNarrative, ""),
      sessionNarrative: asString(parsed.sessionNarrative, ""),
      segmentNarrative: asString(parsed.segmentNarrative, ""),
      insights,
      actionPlan,
    }

    if (!content.insights.length && !content.actionPlan.length) {
      return buildFallbackDeckContent(data)
    }

    return content
  } catch {
    return buildFallbackDeckContent(data)
  }
}

const addSlideHeader = (pptx, colors, title, subtitle) => {
  const slide = pptx.addSlide()
  slide.background = { color: colors.background }
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.1, fill: { color: colors.accent } })
  slide.addText("MAIIN GANDARIA", {
    x: 0.7,
    y: 0.26,
    w: 6,
    h: 0.32,
    fontSize: 11,
    color: colors.accent,
    bold: true,
    charSpacing: 2,
  })
  slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 0.6, w: 0.14, h: 0.9, fill: { color: colors.accent } })
  slide.addText(title, {
    x: 0.98,
    y: 0.55,
    w: 11.5,
    h: 0.85,
    fontSize: 27,
    color: colors.primary,
    bold: true,
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: 1.0,
      y: 1.38,
      w: 11.6,
      h: 0.4,
      fontSize: 13,
      color: colors.muted,
    })
  }
  return slide
}

const addSlideFooter = (pptx, slide, colors, pageNo, total) => {
  slide.addShape(pptx.ShapeType.line, {
    x: 0.7,
    y: 6.92,
    w: 11.93,
    h: 0,
    line: { color: colors.border, width: 1 },
  })
  slide.addText("MAIIN GANDARIA ”¢ Management Report", {
    x: 0.7,
    y: 6.98,
    w: 8,
    h: 0.35,
    fontSize: 10,
    color: colors.muted,
  })
  slide.addText(`${pageNo} / ${total}`, {
    x: 11.6,
    y: 6.98,
    w: 1.03,
    h: 0.35,
    fontSize: 10,
    color: colors.muted,
    align: "right",
  })
}

const addKpiCard = (pptx, slide, colors, x, y, w, h, label, value, deltaText, deltaColor) => {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.12,
    fill: { color: colors.surface },
    line: { color: colors.border, width: 1 },
  })
  slide.addText(label.toUpperCase(), {
    x: x + 0.25,
    y: y + 0.2,
    w: w - 0.5,
    h: 0.3,
    fontSize: 10.5,
    color: colors.muted,
    bold: true,
    charSpacing: 1,
  })
  slide.addText(value, {
    x: x + 0.25,
    y: y + 0.52,
    w: w - 0.5,
    h: 0.85,
    fontSize: 27,
    color: colors.primary,
    bold: true,
  })
  slide.addText(deltaText, {
    x: x + 0.25,
    y: y + 1.62,
    w: w - 0.5,
    h: 0.4,
    fontSize: 12,
    color: deltaColor,
    bold: true,
  })
}

const addBulletList = (slide, colors, items, x, y, w, h, fontSize = 16, gap = 0.12) => {
  slide.addText(
    items.map((item) => ({
      text: item,
      options: {
        color: colors.text,
        fontSize,
        breakLine: false,
        paraSpaceAfter: gap,
      },
    })),
    { x, y, w, h, valign: "top" }
  )
}

const addTitleSlide = (pptx, data, colors, aiContent) => {
  const slide = pptx.addSlide()
  slide.background = { color: colors.background }
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.14, fill: { color: colors.accent } })

  slide.addText("MAIIN GANDARIA", {
    x: 0.9,
    y: 1.0,
    w: 11.5,
    h: 0.7,
    fontSize: 20,
    color: colors.accent,
    bold: true,
    charSpacing: 6,
  })
  slide.addText("MANAGEMENT REPORT", {
    x: 0.9,
    y: 1.75,
    w: 11.5,
    h: 1.4,
    fontSize: 54,
    color: colors.primary,
    bold: true,
  })
  slide.addShape(pptx.ShapeType.line, {
    x: 0.9,
    y: 3.35,
    w: 3.2,
    h: 0,
    line: { color: colors.accent, width: 2 },
  })
  slide.addText(`Periode: ${formatPeriodLabel(data)}`, {
    x: 0.9,
    y: 3.6,
    w: 11.5,
    h: 0.6,
    fontSize: 20,
    color: colors.text,
  })

  if (aiContent?.usedAi) {
    slide.addText("Disusun dengan bantuan AI (Gemini) dari data transaksi nyata", {
      x: 0.9,
      y: 4.35,
      w: 11.5,
      h: 0.5,
      fontSize: 13,
      color: colors.muted,
      italic: true,
    })
  }

  slide.addText("Created by Management Team", {
    x: 0.9,
    y: 6.35,
    w: 11.5,
    h: 0.5,
    fontSize: 15,
    color: colors.muted,
    italic: true,
  })
}

const addExecutiveKpiSlide = (pptx, data, colors, totalSlides, pageNo) => {
  const slide = addSlideHeader(
    pptx,
    colors,
    "Ringkasan Eksekutif",
    `Periode ${formatPeriodLabel(data)} · dibandingkan ${formatComparisonPeriodLabel(data)}`
  )
  const comparison = data.comparison || {}
  const kpiConfigs = [
    {
      label: "Total Revenue",
      value: fmtCompactIdr(data.summary.totalRevenue),
      delta: `vs periode sebelumnya ${deltaLabel(comparison.revenue)}`,
    },
    {
      label: "Total Bookings",
      value: fmtCount(data.summary.totalBookings),
      delta: `vs periode sebelumnya ${deltaLabel(comparison.bookings)}`,
    },
    {
      label: "Occupancy",
      value: fmtPct(data.summary.occupancyRate),
      delta: `vs periode sebelumnya ${deltaLabel(comparison.occupancyRate)}`,
    },
    {
      label: "Avg Revenue / Booking",
      value: fmtCompactIdr(data.summary.avgRevenuePerBooking),
      delta: `vs periode sebelumnya ${deltaLabel(comparison.avgRevenuePerBooking)}`,
    },
  ]

  const cardW = 2.8
  const gap = 0.23
  const startX = 0.75
  const cardY = 2.05
  const cardH = 2.55

  kpiConfigs.forEach((kpi, index) => {
    const positive =
      index === 0 ? comparison.revenue?.changePct : index === 1 ? comparison.bookings?.changePct : index === 2 ? comparison.occupancyRate?.changePct : comparison.avgRevenuePerBooking?.changePct
    const deltaColor =
      positive == null ? colors.muted : positive >= 0 ? colors.accent : colors.negative
    addKpiCard(
      pptx,
      slide,
      colors,
      startX + index * (cardW + gap),
      cardY,
      cardW,
      cardH,
      kpi.label,
      kpi.value,
      kpi.delta,
      deltaColor
    )
  })

  slide.addText(
    `Total jam terpakai: ${fmtCount(data.summary.courtHourCount)} dari ${fmtCount(data.summary.availableSessions)} slot tersedia · Rata-rata revenue per booking: ${fmtCompactIdr(data.summary.avgRevenuePerBooking)}`,
    {
      x: 0.75,
      y: 4.95,
      w: 11.8,
      h: 0.6,
      fontSize: 13,
      color: colors.muted,
      align: "center",
    }
  )

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addExecutiveNarrativeSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Narasi Eksekutif", "Pesan utama yang perlu menjadi perhatian rapat")
  const narrative = aiContent.executiveSummary || data.insights.executiveSummary

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.75,
    y: 2.0,
    w: 11.83,
    h: 2.5,
    rectRadius: 0.14,
    fill: { color: colors.surface },
    line: { color: colors.border, width: 1 },
  })
  slide.addText(narrative, {
    x: 1.15,
    y: 2.3,
    w: 11.0,
    h: 1.9,
    fontSize: 19,
    color: colors.text,
    valign: "middle",
    breakLine: false,
  })

  slide.addText("Temuan cepat dari data:", {
    x: 0.75,
    y: 4.85,
    w: 11.8,
    h: 0.5,
    fontSize: 15,
    color: colors.accent,
    bold: true,
  })

  addBulletList(slide, colors, data.insights.keyFindings.slice(0, 4), 0.95, 5.4, 11.6, 1.4, 14, 0.14)

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addTrendSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Tren Revenue & Bookings", `Pergerakan harian pada ${formatPeriodLabel(data)}`)

  slide.addText(aiContent.trendNarrative || data.insights.revenueInsight, {
    x: 0.85,
    y: 1.95,
    w: 11.6,
    h: 1.5,
    fontSize: 17,
    color: colors.text,
    valign: "top",
    breakLine: false,
  })

  const withRevenue = data.revenueTrend.filter((item) => toNumber(item.revenue) > 0)
  const topDays = [...withRevenue].sort((a, b) => b.revenue - a.revenue).slice(0, 3)
  const bottomDays = [...withRevenue].sort((a, b) => a.revenue - b.revenue).slice(0, 3)

  if (topDays.length) {
    slide.addText("3 hari terbaik", {
      x: 0.85,
      y: 3.6,
      w: 5.6,
      h: 0.4,
      fontSize: 14,
      color: colors.accent,
      bold: true,
    })
    addBulletList(
      slide,
      colors,
      topDays.map((item) => `${item.label} · ${fmtCompactIdr(item.revenue)} · ${fmtCount(item.bookings)} booking`),
      0.85,
      4.05,
      5.6,
      2.4,
      13.5,
      0.16
    )
  }

  if (bottomDays.length) {
    slide.addText("3 hari terendah", {
      x: 6.85,
      y: 3.6,
      w: 5.6,
      h: 0.4,
      fontSize: 14,
      color: colors.negative,
      bold: true,
    })
    addBulletList(
      slide,
      colors,
      bottomDays.map((item) => `${item.label} · ${fmtCompactIdr(item.revenue)} · ${fmtCount(item.bookings)} booking`),
      6.85,
      4.05,
      5.6,
      2.4,
      13.5,
      0.16
    )
  }

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addCourtPerformanceSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Performa per Lapangan", "Kontribusi Mini Soccer vs Basketball")

  slide.addText(aiContent.courtNarrative || data.insights.keyFindings[1] || "", {
    x: 0.85,
    y: 1.95,
    w: 11.6,
    h: 1.2,
    fontSize: 16,
    color: colors.text,
    valign: "top",
    breakLine: false,
  })

  const rows = data.courtTypePerformance
    .slice()
    .sort((a, b) => b.revenue - a.revenue)
    .map((item) => [
      { text: item.courtLabel, options: { bold: true, color: colors.primary } },
      { text: fmtCompactIdr(item.revenue), options: { color: colors.text, align: "right" } },
      { text: fmtCount(item.bookings), options: { color: colors.text, align: "right" } },
      { text: fmtCount(item.bookedHours), options: { color: colors.text, align: "right" } },
      { text: fmtPct(item.occupancyRate), options: { color: colors.accent, bold: true, align: "right" } },
    ])

  const headerCells = ["Lapangan", "Revenue", "Bookings", "Jam Terisi", "Occupancy"].map(
    (label, index) => ({
      text: label,
      options: {
        bold: true,
        color: colors.background,
        fill: { color: colors.accent },
        align: index === 0 ? "left" : "right",
      },
    })
  )

  slide.addTable([headerCells, ...rows], {
    x: 0.75,
    y: 3.4,
    w: 11.83,
    colW: [3.23, 2.9, 2.2, 1.8, 1.7],
    rowH: 0.65,
    fontSize: 14,
    border: { type: "solid", color: colors.border, pt: 0.75 },
    fill: { color: colors.surface },
    valign: "middle",
    margin: 0.12,
  })

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addSessionPerformanceSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Performa Sesi", "Kapan venue ramai dan kapan sepi")

  slide.addText(aiContent.sessionNarrative || "", {
    x: 0.85,
    y: 1.95,
    w: 11.6,
    h: 1.1,
    fontSize: 16,
    color: colors.text,
    valign: "top",
    breakLine: false,
  })

  const renderSessionCard = (x, title, items, titleColor) => {
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 3.25,
      w: 5.8,
      h: 3.3,
      rectRadius: 0.14,
      fill: { color: colors.surface },
      line: { color: colors.border, width: 1 },
    })
    slide.addText(title, {
      x: x + 0.3,
      y: 3.5,
      w: 5.2,
      h: 0.45,
      fontSize: 15,
      color: titleColor,
      bold: true,
    })
    slide.addText(
      items.map((item) => ({
        text: `${sessionLabel(item.sessionName)} · ${fmtPct(item.occupancyRate)} okupansi · ${fmtCompactIdr(item.revenue)}`,
        options: { color: colors.text, fontSize: 14, breakLine: false, paraSpaceAfter: 0.14 },
      })),
      { x: x + 0.3, y: 4.05, w: 5.2, h: 2.2, valign: "top" }
    )
  }

  renderSessionCard(
    0.75,
    "Sesi terkuat",
    data.highOccupancySessions.length ? data.highOccupancySessions : [],
    colors.accent
  )
  renderSessionCard(
    6.78,
    "Sesi perlu perhatian",
    data.lowOccupancySessions.length ? data.lowOccupancySessions : [],
    colors.negative
  )

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addSegmentSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Kontribusi Segmen Pelanggan", "Segmen mana yang paling bernilai")

  slide.addText(aiContent.segmentNarrative || "", {
    x: 0.85,
    y: 1.95,
    w: 11.6,
    h: 1.1,
    fontSize: 16,
    color: colors.text,
    valign: "top",
    breakLine: false,
  })

  const rows = data.segmentContribution.slice(0, 4).map((item) => [
    { text: item.segmentName, options: { bold: true, color: colors.primary } },
    { text: fmtCompactIdr(item.revenue), options: { color: colors.text, align: "right" } },
    { text: fmtPct(item.revenueShare), options: { color: colors.accent, bold: true, align: "right" } },
    { text: fmtCount(item.bookings), options: { color: colors.text, align: "right" } },
  ])

  const headerCells = ["Segmen", "Revenue", "Pangsa Revenue", "Bookings"].map((label, index) => ({
    text: label,
    options: {
      bold: true,
      color: colors.background,
      fill: { color: colors.accent },
      align: index === 0 ? "left" : "right",
    },
  }))

  slide.addTable([headerCells, ...rows], {
    x: 0.75,
    y: 3.3,
    w: 11.83,
    colW: [4.63, 2.8, 2.2, 2.2],
    rowH: 0.65,
    fontSize: 14,
    border: { type: "solid", color: colors.border, pt: 0.75 },
    fill: { color: colors.surface },
    valign: "middle",
    margin: 0.12,
  })

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addInsightsSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Insight Kunci", "Interpretasi data nyata + langkah kongkrit")

  const insights = aiContent.insights.length
    ? aiContent.insights
    : data.insights.keyFindings.slice(0, 3).map((finding, index) => ({
        title: `Temuan ${index + 1}`,
        detail: finding,
        action: data.insights.actionPlan[index] || "",
      }))

  const rowY = [2.0, 3.85, 5.7]
  const rowH = 1.6

  insights.slice(0, 3).forEach((insight, index) => {
    const y = rowY[index]
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.75,
      y,
      w: 11.83,
      h: rowH,
      rectRadius: 0.12,
      fill: { color: colors.surface },
      line: { color: colors.border, width: 1 },
    })
    slide.addShape(pptx.ShapeType.rect, { x: 0.75, y: y + 0.2, w: 0.1, h: rowH - 0.4, fill: { color: colors.accent } })
    slide.addText(`${index + 1}. ${insight.title}`, {
      x: 1.1,
      y: y + 0.18,
      w: 11.1,
      h: 0.45,
      fontSize: 15.5,
      color: colors.accent,
      bold: true,
    })
    if (insight.detail) {
      slide.addText(insight.detail, {
        x: 1.1,
        y: y + 0.62,
        w: 11.1,
        h: 0.55,
        fontSize: 13,
        color: colors.text,
        breakLine: false,
      })
    }
    if (insight.action) {
      slide.addText(`→ Aksi: ${insight.action}`, {
        x: 1.1,
        y: y + 1.18,
        w: 11.1,
        h: 0.4,
        fontSize: 12.5,
        color: colors.primary,
        italic: true,
        breakLine: false,
      })
    }
  })

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addActionPlanSlide = (pptx, data, colors, aiContent, totalSlides, pageNo) => {
  const slide = addSlideHeader(pptx, colors, "Rencana Aksi", "Langkah kongkrit ke depan")

  const plan = aiContent.actionPlan.length
    ? aiContent.actionPlan
    : data.insights.actionPlan

  const rowY = [2.05, 3.35, 4.65, 5.95]

  plan.slice(0, 4).forEach((item, index) => {
    const y = rowY[index]
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 0.95,
      y: y + 0.15,
      w: 0.7,
      h: 0.7,
      fill: { color: colors.accent },
    })
    slide.addText(`${index + 1}`, {
      x: 0.95,
      y: y + 0.24,
      w: 0.7,
      h: 0.5,
      fontSize: 18,
      color: colors.background,
      bold: true,
      align: "center",
      valign: "middle",
    })
    slide.addText(item, {
      x: 1.95,
      y: y + 0.08,
      w: 10.6,
      h: 0.95,
      fontSize: 16,
      color: colors.text,
      valign: "middle",
      breakLine: false,
    })
    slide.addShape(pptx.ShapeType.line, {
      x: 0.95,
      y: y + 1.16,
      w: 11.4,
      h: 0,
      line: { color: colors.border, width: 0.75 },
    })
  })

  addSlideFooter(pptx, slide, colors, pageNo, totalSlides)
}

const addClosingSlide = (pptx, data, colors, totalSlides, pageNo) => {
  const slide = pptx.addSlide()
  slide.background = { color: colors.background }
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.14, fill: { color: colors.accent } })

  slide.addText("THANK YOU", {
    x: 0.9,
    y: 1.5,
    w: 11.5,
    h: 1.2,
    fontSize: 52,
    color: colors.primary,
    bold: true,
    align: "center",
  })
  slide.addText("Best Regards,", {
    x: 0.9,
    y: 2.75,
    w: 11.5,
    h: 0.5,
    fontSize: 16,
    color: colors.muted,
    align: "center",
  })
  slide.addText("Management Team", {
    x: 0.9,
    y: 3.2,
    w: 11.5,
    h: 0.6,
    fontSize: 22,
    color: colors.accent,
    bold: true,
    align: "center",
  })

  slide.addShape(pptx.ShapeType.line, {
    x: 4.6,
    y: 4.15,
    w: 4.13,
    h: 0,
    line: { color: colors.border, width: 1 },
  })

  const contactLines = [
    `MAIIN Gandaria · ${MAIIN_CONTACT.address}`,
    MAIIN_CONTACT.phone,
    `Instagram ${MAIIN_CONTACT.instagram} · ${MAIIN_CONTACT.booking}`,
    MAIIN_CONTACT.hours,
  ]

  slide.addText(
    contactLines.map((line) => ({
      text: line,
      options: { color: colors.text, fontSize: 14, breakLine: false, paraSpaceAfter: 0.12, align: "center" },
    })),
    { x: 0.9, y: 4.5, w: 11.5, h: 1.5, valign: "top" }
  )

  slide.addText(`${pageNo} / ${totalSlides}`, {
    x: 11.6,
    y: 6.98,
    w: 1.03,
    h: 0.35,
    fontSize: 10,
    color: colors.muted,
    align: "right",
  })
}

const buildPptx = async ({ data, themeId, aiContent, pptxPath }) => {
  const colors = getTheme(themeId).colors
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 })
  pptx.layout = "WIDE"
  pptx.author = "MaiinSight"
  pptx.company = "MAIIN Gandaria"
  pptx.subject = "Management Report"
  pptx.title = `MAIIN Gandaria Management Report ${formatPeriodLabel(data)}`

  const totalSlides = 10

  addTitleSlide(pptx, data, colors, aiContent)
  addExecutiveKpiSlide(pptx, data, colors, totalSlides, 2)
  addExecutiveNarrativeSlide(pptx, data, colors, aiContent, totalSlides, 3)
  addTrendSlide(pptx, data, colors, aiContent, totalSlides, 4)
  addCourtPerformanceSlide(pptx, data, colors, aiContent, totalSlides, 5)
  addSessionPerformanceSlide(pptx, data, colors, aiContent, totalSlides, 6)
  addSegmentSlide(pptx, data, colors, aiContent, totalSlides, 7)
  addInsightsSlide(pptx, data, colors, aiContent, totalSlides, 8)
  addActionPlanSlide(pptx, data, colors, aiContent, totalSlides, 9)
  addClosingSlide(pptx, data, colors, totalSlides, 10)

  await pptx.writeFile({ fileName: pptxPath })
}

export const generateManagementPresentation = async ({
  data,
  themeId,
  userId,
  keepFiles = false,
  outputDir,
}) => {
  const startedAt = Date.now()
  const aiContent = await generateDeckContent({ data, userId })
  const tmpDir = keepFiles && outputDir
    ? outputDir
    : await fs.mkdtemp(path.join(os.tmpdir(), "maiin-presentation-"))

  try {
    const pptxPath = path.join(tmpDir, "management-report.pptx")
    await buildPptx({ data, themeId, aiContent, pptxPath })

    let fileName = `MAIIN-Gandaria-Management-Report-${new Date().toISOString().slice(0, 10)}.pdf`
    let contentType = "application/pdf"
    let buffer

    try {
      const pdfPath = await convertPptxToPdf(pptxPath, tmpDir)
      buffer = await fs.readFile(pdfPath)
    } catch {
      buffer = await fs.readFile(pptxPath)
      contentType =
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      fileName = fileName.replace(/\.pdf$/i, ".pptx")
    }

    return {
      fileName,
      contentType,
      fileData: buffer.toString("base64"),
      fileSizeBytes: buffer.length,
      generatedInMs: Date.now() - startedAt,
      usedAi: aiContent.usedAi,
      ...(keepFiles ? { tmpDir, pptxPath } : {}),
    }
  } finally {
    if (!keepFiles) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
    }
  }
}

