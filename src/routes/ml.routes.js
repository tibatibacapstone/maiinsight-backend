import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { runPlaytimeClustering } from "../services/ml.service.js"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SESSION_WINDOWS = [
  { key: "Pagi", label: "Morning", startHour: 6, endHour: 11 },
  { key: "Siang", label: "Afternoon", startHour: 12, endHour: 15 },
  { key: "Evening", label: "Evening", startHour: 16, endHour: 18 },
  { key: "Malam", label: "Night", startHour: 19, endHour: 23 },
]

const summarizeHeatmap = (heatmapData = []) => {
  const slotCounts = new Map()

  heatmapData.forEach((item) => {
    const day = String(item.day_short || "").trim()
    const startHour = String(item.startHour || "").trim()
    const count = Number(item.session_count || 0)
    if (!day || !startHour) return
    slotCounts.set(`${day}|${startHour}`, count)
  })

  const allSlots = []
  DAY_LABELS.forEach((day) => {
    SESSION_WINDOWS.forEach((session) => {
      for (let hour = session.startHour; hour <= session.endHour; hour += 1) {
        allSlots.push({
          day_short: day,
          startHour: `${hour.toString().padStart(2, "0")}:00`,
          session_count: slotCounts.get(`${day}|${`${hour.toString().padStart(2, "0")}:00`}`) || 0,
          session_label: session.label,
        })
      }
    })
  })

  const mostEmptySlot = [...allSlots].sort((left, right) => {
    if (left.session_count !== right.session_count) return left.session_count - right.session_count
    return DAY_LABELS.indexOf(left.day_short) - DAY_LABELS.indexOf(right.day_short)
  })[0] || null

  return {
    slots: allSlots,
    mostEmptySlot: mostEmptySlot
      ? {
          dayLabel: mostEmptySlot.day_short,
          hourLabel: mostEmptySlot.startHour,
          sessionLabel: mostEmptySlot.session_label,
          sessionCount: mostEmptySlot.session_count,
        }
      : null,
  }
}

export const mlRouter = Router()

mlRouter.use(authenticate)

mlRouter.post(
  "/playtime/run",
  authorize("operational", "it_support"),
  async (req, res, next) => {
    try {
      const result = await runPlaytimeClustering()

      res.json({
        success: true,
        message: "Playtime clustering completed successfully.",
        data: result,
      })
    } catch (error) {
      next(error)
    }
  }
)

mlRouter.get("/playtime/latest", async (req, res, next) => {
  try {
    const latestRun = await prisma.playtimeMlRun.findFirst({
      orderBy: {
        createdAt: "desc",
      },
      include: {
        segmentSummaries: true,
        customerSegments: {
          take: 100,
          orderBy: {
            totalSesi: "desc",
          },
        },
      },
    })

    if (!latestRun) {
      return res.status(404).json({
        success: false,
        message: "No playtime ML result found.",
      })
    }

    res.json({
      success: true,
      message: "Latest playtime ML result retrieved successfully.",
      data: {
        ...latestRun,
        heatmapSummary: summarizeHeatmap(latestRun.heatmapData || []),
      },
    })
  } catch (error) {
    next(error)
  }
})
