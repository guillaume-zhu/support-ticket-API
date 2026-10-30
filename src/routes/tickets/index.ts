import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { ticketsController } from "../../controllers/tickets/tickets.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"

export function ticketsRoutes(prisma: PrismaClient) {
  const router = Router()
  const tickets = ticketsController(prisma)
  const authenticated = authenticate(prisma)
  const staff = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT")
  const allRoles = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT", "USER")

  // Réserver la lecture et le changement de statut aux rôles internes.
  // Permettre la création de tickets à tous les comptes connectés.
  router.get("/", authenticated, staff, tickets.list)
  router.get("/:id", authenticated, staff, tickets.getById)
  router.post("/", authenticated, allRoles, tickets.create)
  router.patch("/:id/status", authenticated, staff, tickets.updateStatus)

  return router
}
