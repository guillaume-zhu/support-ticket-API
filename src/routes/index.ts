import type { Express } from "express"
import type { PrismaClient } from "../generated/prisma/client.js"
import { authController } from "../controllers/auth.controller.js"
import { ticketsController } from "../controllers/tickets.controller.js"

export function registerRoutes(app: Express, prisma: PrismaClient) {
  const auth = authController(prisma)
  const tickets = ticketsController(prisma)

  app.post("/auth/login", auth.login)
  app.post("/auth/refresh", auth.refresh)
  app.get("/tickets", tickets.list)
  app.get("/tickets/:id", tickets.getById)
  app.post("/tickets", tickets.create)
  app.patch("/tickets/:id/status", tickets.updateStatus)
}
