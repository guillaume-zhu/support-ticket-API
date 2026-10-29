import type { Express } from "express"
import type { PrismaClient } from "../generated/prisma/client.js"
import { authController } from "../controllers/auth.controller.js"
import { ticketsController } from "../controllers/tickets.controller.js"
import { usersController } from "../controllers/users.controller.js"
import { authenticate, requireRoles } from "../middlewares/auth.js"

export function registerRoutes(app: Express, prisma: PrismaClient) {
  // Préparer les controllers et les contrôles communs aux routes.
  const auth = authController(prisma)
  const tickets = ticketsController(prisma)
  const users = usersController(prisma)
  const authenticated = authenticate(prisma)
  const staff = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT")
  const allRoles = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT", "USER")

  // Laisser les opérations d'authentification et d'activation accessibles sans access token.
  app.post("/auth/login", auth.login)
  app.post("/auth/accept-invitation", auth.acceptInvitation)
  app.post("/auth/refresh", auth.refresh)
  app.post("/auth/logout", auth.logout)

  // Réserver la lecture et le changement de statut aux rôles internes.
  // Permettre la création de tickets à tous les comptes connectés.
  app.get("/tickets", authenticated, staff, tickets.list)
  app.get("/tickets/:id", authenticated, staff, tickets.getById)
  app.post("/tickets", authenticated, allRoles, tickets.create)
  app.patch("/tickets/:id/status", authenticated, staff, tickets.updateStatus)

  // Réserver la création des comptes et l'envoi des invitations au Super Admin connecté.
  app.post("/users", authenticated, requireRoles("SUPER_ADMIN"), users.create)
  app.post("/users/:id/invitation", authenticated, requireRoles("SUPER_ADMIN"), users.invite)
}
