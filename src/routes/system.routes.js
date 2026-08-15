import bcrypt from "bcryptjs"
import { randomUUID } from "node:crypto"
import jwt from "jsonwebtoken"
import { Router } from "express"

import { prisma } from "../config/prisma.js"
import { env, getRequiredJwtSecret } from "../config/env.js"
import {
  authenticate,
  authorize,
  authorizeUserOrService,
  SERVICE_SCOPES,
} from "../middleware/auth.js"
import { logActivity } from "../services/activityLog.service.js"
import { checkGeminiHealth, getAiProviderStatus } from "../services/aiProvider.service.js"
import { buildConfigSnapshot, parseDatabaseName, writeAppSettings } from "../services/appConfig.service.js"
import { sendActivationEmail } from "../services/email.service.js"
import { checkMetaTokenHealth } from "../services/meta.service.js"
import { createNotificationsForRoles } from "../services/notification.service.js"
import { validatePassword } from "../services/passwordPolicy.service.js"
import { countEligibleCanonicalCustomers } from "../services/rfmSegmentation.service.js"
import {
  buildIntegrationSettingsUpdate,
  buildSafeIntegrationConfig,
  buildSafeIntegrationStatus,
} from "../services/systemConfigSecurity.service.js"

const router = Router()
export const SYSTEM_STATUS_ROLES = ["operational", "it_support"]
export const SYSTEM_CONFIG_ROLES = ["it_support"]
export const USER_MANAGEMENT_ROLES = ["it_support"]
export const ALLOWED_SERVICE_TOKEN_SCOPES = Object.freeze([
  SERVICE_SCOPES.SYSTEM_READ_STATUS,
])
export const SAFE_USER_DIRECTORY_SELECT = Object.freeze({
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
})
const IT_SUPPORT_ROLE = "it_support"

const userManagementError = (errorCode, message, statusCode = 400) =>
  Object.assign(new Error(message), { errorCode, statusCode })

const removesActiveItSupportAccess = (targetUser, updateData) =>
  targetUser.role === IT_SUPPORT_ROLE &&
  targetUser.isActive === true &&
  (
    updateData.isActive === false ||
    (updateData.role != null && updateData.role !== IT_SUPPORT_ROLE)
  )

export const assertUserManagementSafety = async ({
  tx,
  actorUserId,
  targetUser,
  updateData = null,
  deleting = false,
}) => {
  if (targetUser.id === actorUserId) {
    if (deleting) {
      throw userManagementError(
        "SELF_DELETION_NOT_ALLOWED",
        "You cannot delete your own account."
      )
    }
    if (updateData?.isActive === false) {
      throw userManagementError(
        "SELF_DEACTIVATION_NOT_ALLOWED",
        "You cannot deactivate your own account."
      )
    }
    if (
      targetUser.role === IT_SUPPORT_ROLE &&
      updateData?.role != null &&
      updateData.role !== IT_SUPPORT_ROLE
    ) {
      throw userManagementError(
        "SELF_ROLE_DOWNGRADE_NOT_ALLOWED",
        "You cannot remove your own IT Support access."
      )
    }
  }

  const removesAccess =
    deleting
      ? targetUser.role === IT_SUPPORT_ROLE && targetUser.isActive === true
      : removesActiveItSupportAccess(targetUser, updateData || {})
  if (!removesAccess) return

  const activeItSupportCount = await tx.user.count({
    where: {
      role: IT_SUPPORT_ROLE,
      isActive: true,
    },
  })
  if (activeItSupportCount <= 1) {
    throw userManagementError(
      "LAST_IT_SUPPORT_REQUIRED",
      "At least one active IT Support account is required."
    )
  }
}

export const updateManagedUser = ({
  db = prisma,
  actorUserId,
  targetUserId,
  updateData,
}) =>
  db.$transaction(async (tx) => {
    const targetUser = await tx.user.findUnique({ where: { id: targetUserId } })
    if (!targetUser) {
      throw userManagementError("USER_NOT_FOUND", "User not found.", 404)
    }
    await assertUserManagementSafety({
      tx,
      actorUserId,
      targetUser,
      updateData,
    })
    return tx.user.update({
      where: { id: targetUserId },
      data: updateData,
      select: SAFE_USER_DIRECTORY_SELECT,
    })
  }, { isolationLevel: "Serializable" })

export const deleteManagedUser = ({
  db = prisma,
  actorUserId,
  targetUserId,
}) =>
  db.$transaction(async (tx) => {
    const targetUser = await tx.user.findUnique({ where: { id: targetUserId } })
    if (!targetUser) {
      throw userManagementError("USER_NOT_FOUND", "User not found.", 404)
    }
    await assertUserManagementSafety({
      tx,
      actorUserId,
      targetUser,
      deleting: true,
    })
    await tx.activityLog.deleteMany({ where: { userId: targetUserId } })
    await tx.userInvite.deleteMany({ where: { createdById: targetUserId } })
    await tx.user.delete({ where: { id: targetUserId } })
    return targetUser
  }, { isolationLevel: "Serializable" })

router.use(authenticate)

const getSystemSummary = async (req, res, next) => {
  try {
    const [aiProviderStatus, config] = await Promise.all([
      getAiProviderStatus(),
      buildConfigSnapshot(),
    ])
    const [latestImport, latestSegmentationRun, latestMetaSync, eligibleCustomerCount] = await Promise.all([
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
      countEligibleCanonicalCustomers(),
    ])

    return res.json({
      success: true,
      data: {
        currentUser:
          req.user.principalType === "user"
            ? {
                userId: req.user.userId,
                email: req.user.email,
                role: req.user.role,
              }
            : null,
        currentService:
          req.user.principalType === "service"
            ? {
                serviceId: req.user.serviceId,
                scopes: req.user.scopes,
              }
            : null,
        api: {
          connected: true,
          baseUrl: env.clientUrl,
        },
        database: {
          name: parseDatabaseName(env.databaseUrl) || "Unknown database",
          status: "connected",
          lastUpdated: latestImport?.updatedAt || null,
        },
        integrations: {
          ...buildSafeIntegrationStatus({ config, aiProviderStatus }),
          metaConfigured: Boolean(config.metaAccessToken && config.metaIgUserId) && config.metaEnabled,
          metaEnabled: config.metaEnabled,
          aiConfigured: aiProviderStatus.configured,
          aiEnabled: config.geminiEnabled,
          aiProvider: aiProviderStatus.provider,
          aiProviderLabel: aiProviderStatus.providerLabel,
          aiModel: aiProviderStatus.model,
          geminiModel: config.geminiModel,
          metaGraphVersion: config.metaGraphVersion,
          geminiApiKeyConfigured: Boolean(config.geminiApiKey),
          metaAccessTokenConfigured: Boolean(config.metaAccessToken),
        },
        latestImport,
        latestSegmentationRun,
        latestMetaSync,
        eligibleCustomerCount,
        tokenManagementMode: "database",
      },
    })
  } catch (error) {
    next(error)
  }
}

const startOfDay = (date) => {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

const startOfMonth = (date) => {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

const aggregateAiUsage = async (from) => {
  const rows = await prisma.aiUsageLog.findMany({
    where: from ? { createdAt: { gte: from } } : {},
    select: { promptTokens: true, candidatesTokens: true, totalTokens: true },
  })
  return rows.reduce(
    (acc, row) => {
      acc.promptTokens += row.promptTokens
      acc.candidatesTokens += row.candidatesTokens
      acc.totalTokens += row.totalTokens
      acc.count += 1
      return acc
    },
    { promptTokens: 0, candidatesTokens: 0, totalTokens: 0, count: 0 }
  )
}

router.get("/summary", authorize(...SYSTEM_STATUS_ROLES), getSystemSummary)
router.get(
  "/status",
  authorizeUserOrService({
    userRoles: SYSTEM_STATUS_ROLES,
    serviceScopes: [SERVICE_SCOPES.SYSTEM_READ_STATUS],
  }),
  getSystemSummary
)

router.post("/check-tokens", authorize(...SYSTEM_STATUS_ROLES), async (req, res, next) => {
  try {
    const [meta, gemini] = await Promise.all([
      checkMetaTokenHealth(),
      checkGeminiHealth(),
    ])
    await writeAppSettings({ LAST_TOKEN_CHECK: new Date().toISOString() })
    return res.json({
      success: true,
      data: { meta, gemini },
    })
  } catch (error) {
    next(error)
  }
})

router.post("/check-meta", authorize(...SYSTEM_STATUS_ROLES), async (req, res, next) => {
  try {
    const meta = await checkMetaTokenHealth()
    return res.json({
      success: true,
      data: { meta },
    })
  } catch (error) {
    next(error)
  }
})

router.post("/check-gemini", authorize(...SYSTEM_STATUS_ROLES), async (req, res, next) => {
  try {
    const gemini = await checkGeminiHealth()
    return res.json({
      success: true,
      data: { gemini, checkedAt: new Date().toISOString() },
    })
  } catch (error) {
    next(error)
  }
})

router.get("/gemini-usage", authorize(...SYSTEM_STATUS_ROLES), async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365)
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const since = new Date()
    since.setDate(since.getDate() - days)

    const [logs, today, month, allTime] = await Promise.all([
      prisma.aiUsageLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { user: { select: { name: true, email: true } } },
      }),
      aggregateAiUsage(startOfDay(new Date())),
      aggregateAiUsage(startOfMonth(new Date())),
      aggregateAiUsage(null),
    ])

    return res.json({
      success: true,
      data: { logs, today, month, allTime },
    })
  } catch (error) {
    next(error)
  }
})

router.get("/config", authorize(...SYSTEM_CONFIG_ROLES), async (_req, res, next) => {
  try {
    const config = await buildConfigSnapshot()
    return res.json({
      success: true,
      data: buildSafeIntegrationConfig(config),
    })
  } catch (error) {
    next(error)
  }
})

const updateIntegrationConfig = async (req, res, next) => {
  try {
    const currentConfig = await buildConfigSnapshot()
    await writeAppSettings(
      buildIntegrationSettingsUpdate(req.body || {}, currentConfig)
    )

    await logActivity(req, "INTEGRATIONS_UPDATED", {
      status: "success",
    })

    return res.json({
      success: true,
      message: "Integration settings updated successfully.",
      data: buildSafeIntegrationConfig({
        ...currentConfig,
        geminiApiKey: String(req.body?.geminiApiKey || "").trim() || currentConfig.geminiApiKey,
        geminiModel: req.body?.geminiModel ?? currentConfig.geminiModel,
        geminiEnabled:
          req.body?.geminiEnabled === undefined
            ? currentConfig.geminiEnabled
            : req.body.geminiEnabled === true || req.body.geminiEnabled === "true",
        metaIgUserId: req.body?.metaIgUserId ?? currentConfig.metaIgUserId,
        metaAccessToken:
          String(req.body?.metaAccessToken || "").trim() || currentConfig.metaAccessToken,
        metaGraphVersion:
          req.body?.metaGraphVersion ?? currentConfig.metaGraphVersion,
        metaEnabled:
          req.body?.metaEnabled === undefined
            ? currentConfig.metaEnabled
            : req.body.metaEnabled === true || req.body.metaEnabled === "true",
      }),
    })
  } catch (error) {
    next(error)
  }
}

router.put("/integrations", authorize(...SYSTEM_CONFIG_ROLES), updateIntegrationConfig)
router.put("/config", authorize(...SYSTEM_CONFIG_ROLES), updateIntegrationConfig)

router.get("/users", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: SAFE_USER_DIRECTORY_SELECT,
    })

    return res.json({
      success: true,
      data: users,
    })
  } catch (error) {
    next(error)
  }
})

router.post("/users", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {}

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Please complete the required user details.",
        suggestion: "Enter a name, email, password, and role before saving.",
      })
    }

    const passwordValidation = validatePassword(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        errorCode: passwordValidation.errorCode,
        message: passwordValidation.message,
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

router.post("/user-invites", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
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
      getRequiredJwtSecret(),
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

router.post("/user-invites/resend", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
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

router.patch("/users/:id", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const { name, role, password, isActive } = req.body || {}

    if (!Number.isFinite(id)) {
      return res.status(400).json({
        success: false,
        message: "This user account could not be updated.",
      })
    }

    const updateData = {}
    if (name) updateData.name = name
    if (role) updateData.role = role
    if (typeof isActive === "boolean") updateData.isActive = isActive
    if (password) {
      const passwordValidation = validatePassword(password)
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          errorCode: passwordValidation.errorCode,
          message: passwordValidation.message,
        })
      }
      updateData.password = await bcrypt.hash(password, 10)
    }

    const user = await updateManagedUser({
      actorUserId: req.user.userId,
      targetUserId: id,
      updateData,
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

router.delete("/users/:id", authorize(...USER_MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id)

    if (!Number.isFinite(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
      })
    }

    const user = await deleteManagedUser({
      actorUserId: req.user.userId,
      targetUserId: id,
    })

    await logActivity(req, "USER_DELETED", {
      targetUserId: user.id,
      targetUserEmail: user.email,
      status: "success",
    })

    return res.json({
      success: true,
      message: "User account deleted successfully.",
    })
  } catch (error) {
    next(error)
  }
})

export const createServiceToken = ({
  createdByUserId,
  label,
  scopes,
  serviceId = randomUUID(),
  secret = getRequiredJwtSecret(),
}) =>
  jwt.sign(
    {
      tokenType: "service",
      serviceId,
      createdByUserId,
      scopes,
      label,
    },
    secret,
    { expiresIn: "12h" }
  )

router.post("/service-token", authorize("it_support"), async (req, res, next) => {
  try {
    const label = req.body?.label || "MaiinSight Service Token"
    const scopes = Array.isArray(req.body?.scopes)
      ? [...new Set(req.body.scopes.map(String))]
      : [...ALLOWED_SERVICE_TOKEN_SCOPES]
    if (
      !scopes.length ||
      scopes.some((scope) => !ALLOWED_SERVICE_TOKEN_SCOPES.includes(scope))
    ) {
      return res.status(400).json({
        success: false,
        errorCode: "INVALID_SERVICE_TOKEN_SCOPE",
        message: "One or more requested service-token scopes are unsupported.",
      })
    }
    const serviceId = randomUUID()
    const token = createServiceToken({
      createdByUserId: req.user.userId,
      label,
      scopes,
      serviceId,
    })

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
        serviceId,
        scopes,
      },
    })
  } catch (error) {
    next(error)
  }
})

export { router as systemRouter }
