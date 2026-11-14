import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { RateLimiters } from "../../middlewares/rate-limit.js"
import { authController } from "../../controllers/auth/auth.controller.js"
import { invitationsController } from "../../controllers/auth/invitations.controller.js"
import { passwordResetController } from "../../controllers/auth/password-reset.controller.js"

export function authRoutes(prisma: PrismaClient, limiters: RateLimiters) {
  const router = Router()
  const auth = authController(prisma)
  const invitations = invitationsController(prisma)
  const passwordReset = passwordResetController(prisma)

  // Opérations accessibles sans access token : chacune est protégée par un limiteur propre,
  // placé avant le controller pour ne pas déclencher Argon2, Prisma ou l'envoi d'emails.
  router.post("/login", ...limiters.login, auth.login)
  router.post("/accept-invitation", limiters.codes, invitations.acceptInvitation)
  router.post("/request-password-reset", ...limiters.passwordReset, passwordReset.requestPasswordReset)
  router.post("/reset-password", limiters.codes, passwordReset.resetPassword)
  router.post("/refresh", limiters.refresh, auth.refresh)
  router.post("/logout", auth.logout)

  return router
}
