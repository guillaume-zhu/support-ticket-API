import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { aiController } from "../../controllers/ai/ai.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"
import type { RateLimiters } from "../../middlewares/rate-limit.js"

export function aiRoutes(prisma: PrismaClient, limiters: RateLimiters) {
  const router = Router()
  const ai = aiController()

  // Tous les comptes connectés peuvent interroger l'assistant. Les limiteurs viennent APRÈS l'authentification :
  // ils comptent par utilisateur, et une requête sans token valide ne consomme aucun quota. L'appel payant
  // au fournisseur n'a lieu que dans le controller, donc jamais pour une requête bloquée.
  router.post(
    "/chat",
    authenticate(prisma),
    requireRoles("SUPER_ADMIN", "ADMIN", "AGENT", "USER"),
    ...limiters.ai,
    ai.chat,
  )

  return router
}
