import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { usersController } from "../../controllers/users/users.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"

export function usersRoutes(prisma: PrismaClient) {
  const router = Router()
  const users = usersController(prisma)
  const authenticated = authenticate(prisma)
  const superAdmin = requireRoles("SUPER_ADMIN")

  // Réserver la création des comptes et l'envoi des invitations au Super Admin connecté.
  router.post("/", authenticated, superAdmin, users.create)
  router.post("/:id/invitation", authenticated, superAdmin, users.invite)

  // Réserver la désactivation et la réactivation au Super Admin connecté.
  router.patch("/:id/disable", authenticated, superAdmin, users.disable)
  router.patch("/:id/enable", authenticated, superAdmin, users.enable)

  return router
}
