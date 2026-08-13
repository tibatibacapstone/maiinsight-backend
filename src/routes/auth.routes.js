import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { Router } from "express"

import { env, getRequiredJwtSecret } from "../config/env.js"
import { prisma } from "../config/prisma.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { sendPasswordResetEmail } from "../services/email.service.js"
import {
  createPasswordResetToken,
  resetPasswordWithToken,
} from "../services/passwordReset.service.js"
import { authenticateGoogleCredential } from "../services/googleAuth.service.js"
import { registerInvitedUser } from "../services/invitedRegistration.service.js"
import { validatePassword } from "../services/passwordPolicy.service.js"
import {
  googleAuthRateLimit,
  loginRateLimit,
  passwordResetAccountRateLimit,
  passwordResetConfirmationRateLimit,
  passwordResetIpRateLimit,
  registrationRateLimit,
} from "../middleware/auth-rate-limit.js"

const router = Router()

const MAX_AVATAR_BYTES = 1024 * 1024

export const createToken = (user) => {
  return jwt.sign(
    {
      tokenType: "access",
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    getRequiredJwtSecret(),
    {
      expiresIn: "8h",
    },
  )
}

router.post("/register", registrationRateLimit, async (req, res, next) => {
  try {
    const { inviteToken, password } = req.body

    if (!inviteToken) {
      return res.status(400).json({ error: "Invite token is required" })
    }

    const passwordValidation = validatePassword(password)
    if (!passwordValidation.valid) {
      return res.status(400).json({
        errorCode: passwordValidation.errorCode,
        error: passwordValidation.message,
      })
    }

    let invitePayload
    try {
      invitePayload = jwt.verify(inviteToken, getRequiredJwtSecret())
    } catch {
      return res.status(400).json({ error: "Invalid or expired invite token" })
    }

    if (invitePayload?.purpose !== "user_invite") {
      return res.status(400).json({ error: "Invalid invite token" })
    }

    let user
    try {
      user = await registerInvitedUser({ inviteToken, password })
    } catch (error) {
      if (error?.errorCode) {
        return res.status(error.statusCode || 400).json({
          errorCode: error.errorCode,
          error: error.message,
        })
      }
      throw error
    }

    const token = createToken(user)

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
  } catch (error) {
    next(error)
  }
})

router.post("/login", loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    if (user.isActive === false) {
      return res.status(401).json({
        errorCode: "ACCOUNT_INACTIVE",
        error: "Account is inactive",
      })
    }

    if (!user.password) {
      return res.status(401).json({ error: "This account uses Google login. Please sign in with Google." })
    }

    const passwordMatch = await bcrypt.compare(password, user.password)

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    const token = createToken(user)

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } catch (error) {
    next(error)
  }
})

router.post("/google", googleAuthRateLimit, async (req, res, next) => {
  try {
    const { credential } = req.body

    if (!credential) {
      return res.status(400).json({ error: "Google credential is required" })
    }

    let user
    try {
      user = await authenticateGoogleCredential({
        idToken: credential,
        db: prisma,
      })
    } catch (error) {
      if (error?.errorCode) {
        return res.status(error.statusCode || 401).json({
          errorCode: error.errorCode,
          error: error.message,
        })
      }
      throw error
    }

    const token = createToken(user)

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } catch (error) {
    next(error)
  }
})

router.post(
  "/forgot-password",
  passwordResetIpRateLimit,
  passwordResetAccountRateLimit,
  async (req, res, next) => {
    try {
      const { email } = req.body || {}

      if (!email) {
        return res.status(400).json({ error: "Email is required." })
      }

      const user = await prisma.user.findUnique({ where: { email } })

      if (!user || !user.password) {
        return res.json({ success: true, message: "If the email exists, a reset link has been sent." })
      }

      const resetToken = createPasswordResetToken(user)

      const resetUrl = `${env.appUrl}/reset-password?token=${encodeURIComponent(resetToken)}`

      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
      })

      return res.json({ success: true, message: "If the email exists, a reset link has been sent." })
    } catch (error) {
      next(error)
    }
  },
)

router.post("/reset-password", passwordResetConfirmationRateLimit, async (req, res, next) => {
  try {
    const { token, password } = req.body || {}

    if (!token || !password) {
      return res.status(400).json({ error: "Token and password are required." })
    }

    try {
      await resetPasswordWithToken({ token, password })
    } catch (error) {
      if (error?.errorCode) {
        return res.status(error.statusCode || 400).json({
          errorCode: error.errorCode,
          error: error.message,
        })
      }
      throw error
    }

    return res.json({ success: true, message: "Password reset successfully." })
  } catch (error) {
    next(error)
  }
})

router.get("/me", authenticate, authorize("operational", "management", "it_support"), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, avatar: true, isActive: true },
    })

    if (!user) {
      return res.status(404).json({ error: "Account not found" })
    }

    return res.json({ success: true, data: user })
  } catch (error) {
    next(error)
  }
})

router.patch("/me", authenticate, authorize("operational", "management", "it_support"), async (req, res, next) => {
  try {
    const { name, avatar } = req.body || {}

    if (name === undefined && avatar === undefined) {
      return res.status(400).json({ error: "Nothing to update" })
    }

    const data = {}

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Name cannot be empty" })
      }
      const trimmedName = name.trim()
      if (trimmedName.length > 100) {
        return res.status(400).json({ error: "Name must be 100 characters or fewer" })
      }
      data.name = trimmedName
    }

    if (avatar !== undefined) {
      if (avatar === null) {
        data.avatar = null
      } else if (typeof avatar !== "string" || !avatar.startsWith("data:image/") || !avatar.includes(";base64,")) {
        return res.status(400).json({ error: "Invalid profile photo" })
      } else if (Buffer.byteLength(avatar, "utf8") > MAX_AVATAR_BYTES) {
        return res.status(400).json({ error: "Profile photo must be 1 MB or smaller" })
      } else {
        data.avatar = avatar
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, email: true, name: true, role: true, avatar: true, isActive: true },
    })

    return res.json({ success: true, data: user })
  } catch (error) {
    next(error)
  }
})

export const authRouter = router
