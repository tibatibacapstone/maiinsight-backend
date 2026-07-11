import { Router } from "express"

import { authenticate } from "../middleware/auth.js"

export const mlRouter = Router()

mlRouter.use(authenticate)
