import type { Express } from "express"
import type { PrismaClient } from "../generated/prisma/client.js"
import { authRoutes } from "./auth/index.js"
import { ticketsRoutes } from "./tickets/index.js"
import { usersRoutes } from "./users/index.js"

export function registerRoutes(app: Express, prisma: PrismaClient) {
  // Enregistrer un routeur par domaine.
  app.use("/auth", authRoutes(prisma))
  app.use("/tickets", ticketsRoutes(prisma))
  app.use("/users", usersRoutes(prisma))
}
