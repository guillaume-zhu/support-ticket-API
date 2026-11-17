import type { Express } from "express"
import type { PrismaClient } from "../generated/prisma/client.js"
import type { RateLimiters } from "../middlewares/rate-limit.js"
import { aiRoutes } from "./ai/index.js"
import { auditRoutes } from "./audit/index.js"
import { authRoutes } from "./auth/index.js"
import { ticketsRoutes } from "./tickets/index.js"
import { usersRoutes } from "./users/index.js"

export function registerRoutes(app: Express, prisma: PrismaClient, limiters: RateLimiters) {
  // Enregistrer un routeur par domaine.
  app.use("/ai", aiRoutes(prisma, limiters))
  app.use("/audit-logs", auditRoutes(prisma))
  app.use("/auth", authRoutes(prisma, limiters))
  app.use("/tickets", ticketsRoutes(prisma))
  app.use("/users", usersRoutes(prisma))
}
