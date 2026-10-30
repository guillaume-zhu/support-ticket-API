import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { authController } from "../../controllers/auth/auth.controller.js"
import { invitationsController } from "../../controllers/auth/invitations.controller.js"
import { passwordResetController } from "../../controllers/auth/password-reset.controller.js"

export function authRoutes(prisma: PrismaClient) {
  const router = Router()
  const auth = authController(prisma)
  const invitations = invitationsController(prisma)
  const passwordReset = passwordResetController(prisma)

  // Laisser les opérations d'authentification et d'activation accessibles sans access token.
  router.post("/login", auth.login)
  router.post("/accept-invitation", invitations.acceptInvitation)
  router.post("/request-password-reset", passwordReset.requestPasswordReset)
  router.post("/reset-password", passwordReset.resetPassword)
  router.post("/refresh", auth.refresh)
  router.post("/logout", auth.logout)

  return router
}
