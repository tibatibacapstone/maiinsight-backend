import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import crypto from "crypto"
import { Router } from "express"

import { env } from "../config/env.js"
import { prisma } from "../config/prisma.js"
import { authenticate } from "../middleware/auth.js"
import { sendConfirmationCodeEmail, sendPasswordResetEmail } from "../services/email.service.js"

const router = Router()

const PUBLIC_USER_FIELDS = { id: true, email: true, name: true, role: true, avatar: true }

const CODE_TTL_MS = 10 * 60 * 1000
const RESEND_COOLDOWN_MS = 60 * 1000
const MAX_ATTEMPTS = 5

const generateConfirmationCode = () => {
  const buffer = crypto.randomBytes(3)
  return String(buffer.readUIntBE(0, 3) % 1000000).padStart(6, "0")
}

const createToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    env.jwtSecret,
    {
      expiresIn: "8h",
    },
  )
}

router.post("/register", async (req, res, next) => {
  try {
    const { inviteToken, password } = req.body

    if (!inviteToken) {
      return res.status(400).json({ error: "Invite token is required" })
    }

    let invitePayload
    try {
      invitePayload = jwt.verify(inviteToken, env.jwtSecret)
    } catch {
      return res.status(400).json({ error: "Invalid or expired invite token" })
    }

    if (invitePayload?.purpose !== "user_invite") {
      return res.status(400).json({ error: "Invalid invite token" })
    }

    const invite = await prisma.userInvite.findUnique({ where: { token: inviteToken } })

    if (!invite || invite.usedAt) {
      return res.status(400).json({ error: "Invalid or expired invite token" })
    }

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invite token has expired" })
    }

    const existingUser = await prisma.user.findUnique({ where: { email: invite.email } })

    if (existingUser) {
      return res.status(409).json({ error: "User already exists" })
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null

    const user = await prisma.user.create({
      data: {
        email: invite.email,
        name: invite.name,
        password: hashedPassword,
        role: invite.role,
      },
    })

    await prisma.userInvite.update({
      where: { token: inviteToken },
      data: { usedAt: new Date() },
    })

    const token = createToken(user)

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar },
    })
  } catch (error) {
    next(error)
  }
})

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    if (!user.password) {
      return res.status(401).json({ error: "This account uses Google login. Please sign in with Google." })
    }

    const passwordMatch = await bcrypt.compare(password, user.password)

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    const token = createToken(user)

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar } })
  } catch (error) {
    next(error)
  }
})

router.post("/google", async (req, res, next) => {
  try {
    const { credential } = req.body

    if (!credential) {
      return res.status(400).json({ error: "Google credential is required" })
    }

    let email

    if (env.googleClientId) {
      // Try as ID token first (from GoogleLogin component)
      try {
        const { OAuth2Client } = await import("google-auth-library")
        const client = new OAuth2Client(env.googleClientId)
        const ticket = await client.verifyIdToken({
          idToken: credential,
          audience: env.googleClientId,
        })
        const payload = ticket.getPayload()
        email = payload?.email
      } catch {
        // Not an ID token — try as access token (from useGoogleLogin)
      }
    }

    // If ID token verification didn't work, try as access token
    if (!email) {
      try {
        const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${credential}` },
        })
        if (resp.ok) {
          const userInfo = await resp.json()
          email = userInfo.email
        }
      } catch {
        // Failed both methods
      }
    }

    if (!email) {
      return res.status(401).json({ error: "Invalid Google credential" })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user) {
      return res.status(401).json({ error: "Account not found. Please contact IT Support to get registered." })
    }

    const token = createToken(user)

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar } })
  } catch (error) {
    next(error)
  }
})

router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: "Email is required." })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user || !user.password) {
      return res.json({ success: true, message: "If the email exists, a reset link has been sent." })
    }

    const resetToken = jwt.sign(
      { purpose: "password_reset", userId: user.id, email: user.email },
      env.jwtSecret,
      { expiresIn: "1h" }
    )

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
})

router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body || {}

    if (!token || !password) {
      return res.status(400).json({ error: "Token and password are required." })
    }

    let payload
    try {
      payload = jwt.verify(token, env.jwtSecret)
    } catch {
      return res.status(400).json({ error: "Invalid or expired reset token." })
    }

    if (payload?.purpose !== "password_reset") {
      return res.status(400).json({ error: "Invalid reset token." })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    await prisma.user.update({
      where: { id: payload.userId },
      data: { password: hashedPassword },
    })

    return res.json({ success: true, message: "Password reset successfully." })
  } catch (error) {
    next(error)
  }
})

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: PUBLIC_USER_FIELDS,
    })

    if (!user) {
      return res.status(401).json({ error: "User not found." })
    }

    return res.json({ success: true, data: user })
  } catch (error) {
    next(error)
  }
})

router.patch("/me", authenticate, async (req, res, next) => {
  try {
    const { name, avatar } = req.body || {}
    const updateData = {}

    if (name !== undefined && name !== null) {
      const trimmedName = String(name).trim()
      if (!trimmedName) {
        return res.status(400).json({ success: false, error: "Name cannot be empty." })
      }
      if (trimmedName.length > 100) {
        return res.status(400).json({ success: false, error: "Name is too long (max 100 characters)." })
      }
      updateData.name = trimmedName
    }

    if (avatar !== undefined) {
      if (avatar === null || avatar === "") {
        updateData.avatar = null
      } else {
        const avatarString = String(avatar)
        if (!avatarString.startsWith("data:image/")) {
          return res.status(400).json({ success: false, error: "Avatar must be a valid image data URL." })
        }
        if (Buffer.byteLength(avatarString, "utf8") > 1024 * 1024) {
          return res.status(400).json({ success: false, error: "Avatar image is too large (max 1 MB)." })
        }
        updateData.avatar = avatarString
      }
    }

    if (!Object.keys(updateData).length) {
      return res.status(400).json({ success: false, error: "Nothing to update." })
    }

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: updateData,
      select: PUBLIC_USER_FIELDS,
    })

    return res.json({ success: true, data: user })
  } catch (error) {
    next(error)
  }
})

router.post("/change-password/request", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: PUBLIC_USER_FIELDS,
    })

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found." })
    }

    const recentCode = await prisma.passwordResetCode.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: "desc" },
    })

    if (recentCode) {
      const elapsedMs = Date.now() - new Date(recentCode.createdAt).getTime()
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000)
        return res.status(429).json({
          success: false,
          error: `Please wait ${waitSeconds}s before requesting a new code.`,
        })
      }
    }

    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    })

    const code = generateConfirmationCode()
    const codeHash = await bcrypt.hash(code, 10)

    await prisma.passwordResetCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    })

    const emailResult = await sendConfirmationCodeEmail({
      to: user.email,
      name: user.name,
      code,
    })

    if (emailResult?.skipped) {
      return res.status(500).json({
        success: false,
        error: "Email service is not configured. Please contact IT Support.",
      })
    }

    return res.json({ success: true, message: "Confirmation code sent to your email." })
  } catch (error) {
    next(error)
  }
})

router.post("/change-password/confirm", authenticate, async (req, res, next) => {
  try {
    const { code, newPassword } = req.body || {}

    if (!code || !newPassword) {
      return res.status(400).json({ success: false, error: "Code and new password are required." })
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: "New password must be at least 6 characters." })
    }

    const resetCode = await prisma.passwordResetCode.findFirst({
      where: { userId: req.user.userId, usedAt: null },
      orderBy: { createdAt: "desc" },
    })

    if (!resetCode) {
      return res.status(400).json({ success: false, error: "No active confirmation code. Request a new one." })
    }

    if (new Date(resetCode.expiresAt).getTime() < Date.now()) {
      await prisma.passwordResetCode.update({ where: { id: resetCode.id }, data: { usedAt: new Date() } })
      return res.status(400).json({ success: false, error: "Confirmation code has expired. Request a new one." })
    }

    if (resetCode.attempts >= MAX_ATTEMPTS) {
      await prisma.passwordResetCode.update({ where: { id: resetCode.id }, data: { usedAt: new Date() } })
      return res.status(400).json({ success: false, error: "Too many failed attempts. Request a new code." })
    }

    const codeMatches = await bcrypt.compare(String(code).trim(), resetCode.codeHash)

    if (!codeMatches) {
      await prisma.passwordResetCode.update({
        where: { id: resetCode.id },
        data: { attempts: { increment: 1 } },
      })
      return res.status(400).json({ success: false, error: "Incorrect confirmation code." })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10)

    await prisma.$transaction([
      prisma.passwordResetCode.update({ where: { id: resetCode.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: req.user.userId }, data: { password: hashedPassword } }),
    ])

    return res.json({ success: true, message: "Password updated successfully." })
  } catch (error) {
    next(error)
  }
})

export const authRouter = router
