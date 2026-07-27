import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { Router } from "express"

import { env } from "../config/env.js"
import { prisma } from "../config/prisma.js"
import { sendPasswordResetEmail } from "../services/email.service.js"

const router = Router()

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
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
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

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
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

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
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

export const authRouter = router
