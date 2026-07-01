import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { Router } from "express"

import { env } from "../config/env.js"
import { prisma } from "../config/prisma.js"

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

    if (!inviteToken || !password) {
      return res.status(400).json({ error: "Invite token and password are required" })
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

    const hashedPassword = await bcrypt.hash(password, 10)

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
      return res.status(401).json({ error: "Invalid" })
    }

    const passwordMatch = await bcrypt.compare(password, user.password)

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    const token = createToken(user)

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } catch (error) {
    next(error)
  }
})

export const authRouter = router
