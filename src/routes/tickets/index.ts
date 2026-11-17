import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { ticketsController } from "../../controllers/tickets/tickets.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"
import { STAFF_ROLES } from "../../services/tickets/tickets.service.js"

export function ticketsRoutes(prisma: PrismaClient) {
  const router = Router()
  const tickets = ticketsController(prisma)
  const authenticated = authenticate(prisma)
  const staff = requireRoles(...STAFF_ROLES)
  const allRoles = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT", "USER")

  // Tous les comptes connectés créent et lisent des tickets (filtrés par propriété dans le service).
  // Seul le personnel change le statut.
  router.get("/", authenticated, allRoles, tickets.list)
  router.get("/:id", authenticated, allRoles, tickets.getById)
  router.post("/", authenticated, allRoles, tickets.create)
  router.patch("/:id/status", authenticated, staff, tickets.updateStatus)

  return router
}
