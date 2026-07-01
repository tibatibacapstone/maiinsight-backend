import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { env } from "../config/env.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { logActivity } from "../services/activityLog.service.js"
import { getAiProviderStatus } from "../services/aiProvider.service.js"
import { APP_SETTING_KEYS, buildConfigSnapshot, parseDatabaseName, writeAppSettings } from "../services/appConfig.service.js"
import { sendActivationEmail } from "../services/email.service.js"
import { createNotificationsForRoles } from "../services/notification.service.js"

const router = Router()

router.use(authenticate)
router.use(authorize("operational", "it_support"))

router.get("/summary", async (req, res, next) => {
  try {
    const [aiProviderStatus, config] = await Promise.all([
      getAiProviderStatus(),
      buildConfigSnapshot(),
    ])
    const [
      users,
      latestImport,
      latestMlRun,
      latestSegmentationRun,
      latestMetaSync,
    ] = await Promise.all([
      prisma.user.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.importBatch.findFirst({
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          fileName: true,
          status: true,
          updatedAt: true,
          rowCount: true,
        },
      }),
      prisma.playtimeMlRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          totalSessions: true,
        },
      }),
      prisma.segmentationRun.findFirst({
        orderBy: { runDate: "desc" },
        select: {
          id: true,
          status: true,
          runDate: true,
          totalCustomers: true,
        },
      }),
      prisma.metaSyncLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          status: true,
          startedAt: true,
          message: true,
        },
      }),
    ])

    return res.json({
      success: true,
      data: {
        currentUser: {
          userId: req.user.userId,
          email: req.user.email,
          role: req.user.role,
        },
        api: {
          connected: true,
          baseUrl: env.clientUrl,
        },
        database: {
          name: parseDatabaseName(env.databaseUrl) || "Unknown database",
          status: "connected",
          subtitle: "Successfully Connected",
        },
        integrations: {
          metaConfigured: Boolean(config.metaAccessToken && config.metaIgUserId),
          aiConfigured: aiProviderStatus.configured,
          aiProvider: aiProviderStatus.provider,
          aiProviderLabel: aiProviderStatus.providerLabel,
          aiModel: aiProviderStatus.model,
          geminiApiKey: config.geminiApiKey,
          geminiModel: config.geminiModel,
          metaIgUserId: config.metaIgUserId,
          metaAccessToken: config.metaAccessToken,
          metaGraphVersion: config.metaGraphVersion,
        },
        latestImport,
        latestMlRun: latestMlRun
          ? {
              ...latestMlRun,
              lastRunningAt: latestMlRun.createdAt,
              lastRunningLabel: latestMlRun.createdAt,
            }
          : null,
        latestSegmentationRun,
        latestMetaSync,
        tokenManagementMode: "database",
        users,
      },
    })
  } catch (error) {
    next(error)
  }
})

router.put("/integrations", authorize("it_support"), async (req, res, next) => {
  try {
    const {
      geminiApiKey,
      geminiModel,
      metaIgUserId,
      metaAccessToken,
      metaGraphVersion,
    } = req.body || {}

    await writeAppSettings({
      [APP_SETTING_KEYS.GEMINI_API_KEY]: geminiApiKey,
      [APP_SETTING_KEYS.GEMINI_MODEL]: geminiModel,
      [APP_SETTING_KEYS.META_IG_USER_ID]: metaIgUserId,
      [APP_SETTING_KEYS.META_ACCESS_TOKEN]: metaAccessToken,
      [APP_SETTING_KEYS.META_GRAPH_VERSION]: metaGraphVersion,
    })

    await logActivity(req, "INTEGRATIONS_UPDATED", {
      status: "success",
    })

    return res.json({
      success: true,
      message: "Integration settings updated successfully.",
    })
  } catch (error) {
    next(error)
  }
})

router.get("/users", async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return res.json({
      success: true,
      data: users,
    })
  } catch (error) {
    next(error)
  }
})

router.post("/users", authorize("it_support"), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {}

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Please complete the required user details.",
        suggestion: "Enter a name, email, password, and role before saving.",
      })
    }

    const existingUser = await prisma.user.findUnique({ where: { email } })

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
        suggestion: "Use a different email address or update the existing user account.",
      })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    await logActivity(req, "USER_CREATED", {
      targetUserId: user.id,
      targetUserEmail: user.email,
      status: "success",
    })
    await createNotificationsForRoles(prisma, ["it_support"], {
      title: "User Account Created",
      message: `${user.name} (${user.email}) was added to MaiinSight.`,
    })

    return res.status(201).json({
      success: true,
      message: "User account created successfully.",
      data: user,
    })
  } catch (error) {
    next(error)
  }
})

router.post("/user-invites", authorize("it_support"), async (req, res, next) => {
  try {
    const { name, email, role } = req.body || {}

    if (!name || !email || !role) {
      return res.status(400).json({
        success: false,
        message: "Please complete the required invite details.",
        suggestion: "Enter a name, email, and role before creating the invite.",
      })
    }

    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      })
    }

    const inviteToken = jwt.sign(
      {
        purpose: "user_invite",
        email,
        name,
        role,
        createdBy: req.user.userId,
      },
      env.jwtSecret,
      { expiresIn: "7d" }
    )
    const activationUrl = `${env.appUrl}/activate?token=${encodeURIComponent(inviteToken)}`

    await prisma.userInvite.create({
      data: {
        token: inviteToken,
        email,
        name,
        role,
        createdById: req.user.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        expiresAt: true,
      },
    })

    await sendActivationEmail({
      to: email,
      name,
      role,
      activationUrl,
    })

    await logActivity(req, "USER_INVITE_CREATED", {
      targetUserEmail: email,
      status: "success",
    })

    return res.status(201).json({
      success: true,
      message: "User invite created successfully.",
      data: { activationUrl },
    })
  } catch (error) {
    next(error)
  }
})

router.post("/user-invites/resend", authorize("it_support"), async (req, res, next) => {
  try {
    const { activationUrl } = req.body || {}

    if (!activationUrl) {
      return res.status(400).json({
        success: false,
        message: "Activation link is required.",
      })
    }

    const url = new URL(activationUrl)
    const inviteToken = url.searchParams.get("token")

    if (!inviteToken) {
      return res.status(400).json({
        success: false,
        message: "Activation link is invalid.",
      })
    }

    const invite = await prisma.userInvite.findUnique({ where: { token: inviteToken } })
    if (!invite || invite.usedAt) {
      return res.status(400).json({
        success: false,
        message: "Invite is no longer available.",
      })
    }

    const refreshedActivationUrl = `${env.appUrl}/activate?token=${encodeURIComponent(inviteToken)}`

    await sendActivationEmail({
      to: invite.email,
      name: invite.name,
      role: invite.role,
      activationUrl: refreshedActivationUrl,
    })

    await logActivity(req, "USER_INVITE_RESENT", {
      targetUserEmail: invite.email,
      status: "success",
    })

    return res.json({
      success: true,
      message: "Activation email sent again.",
      data: { activationUrl: refreshedActivationUrl },
    })
  } catch (error) {
    next(error)
  }
})

router.patch("/users/:id", authorize("it_support"), async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const { name, email, role, password } = req.body || {}

    if (!Number.isFinite(id)) {
      return res.status(400).json({
        success: false,
        message: "This user account could not be updated.",
      })
    }

    const updateData = {}
    if (name) updateData.name = name
    if (email) updateData.email = email
    if (role) updateData.role = role
    if (password) {
      updateData.password = await bcrypt.hash(password, 10)
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    await logActivity(req, "USER_UPDATED", {
      targetUserId: user.id,
      targetUserEmail: user.email,
      status: "success",
    })

    return res.json({
      success: true,
      message: "User account updated successfully.",
      data: user,
    })
  } catch (error) {
    next(error)
  }
})

router.post("/service-token", authorize("it_support"), async (req, res, next) => {
  try {
    const label = req.body?.label || "MaiinSight Service Token"
    const token = jwt.sign(
      {
        type: "service_token",
        label,
        createdBy: req.user.userId,
        role: req.user.role,
      },
      env.jwtSecret,
      { expiresIn: "12h" }
    )

    await logActivity(req, "SERVICE_TOKEN_GENERATED", {
      label,
      status: "success",
    })

    return res.status(201).json({
      success: true,
      message: "Service token generated successfully.",
      data: {
        token,
        label,
      },
    })
  } catch (error) {
    next(error)
  }
})

export { router as systemRouter }
