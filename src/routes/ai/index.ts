import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { aiController } from "../../controllers/ai/ai.controller.js"
import { aiActionsController } from "../../controllers/ai/ai.actions.controller.js"
import { aiConversationsController } from "../../controllers/ai/ai.conversations.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"
import type { RateLimiters } from "../../middlewares/rate-limit.js"

export function aiRoutes(prisma: PrismaClient, limiters: RateLimiters) {
  const router = Router()
  const ai = aiController(prisma)
  const conversations = aiConversationsController(prisma)
  const actions = aiActionsController(prisma)
  const authenticated = authenticate(prisma)
  const allRoles = requireRoles("SUPER_ADMIN", "ADMIN", "AGENT", "USER")

  // Tous les comptes connectés peuvent interroger l'assistant. Les limiteurs viennent APRÈS l'authentification :
  // ils comptent par utilisateur, et une requête sans token valide ne consomme aucun quota. L'appel payant
  // au fournisseur n'a lieu que dans le service, donc jamais pour une requête bloquée.
  router.post("/chat", authenticated, allRoles, ...limiters.ai, ai.chat)

  // Lire et supprimer SES conversations : aucun appel au fournisseur, donc pas de quota IA (la limite globale par IP s'applique).
  router.get("/conversations", authenticated, allRoles, conversations.list)
  router.get("/conversations/:id/messages", authenticated, allRoles, conversations.messages)
  router.delete("/conversations/:id", authenticated, allRoles, conversations.remove)

  // Actions proposées par l'assistant : l'utilisateur les confirme ou les annule ICI, par une requête explicite et vérifiée.
  // Ni le modèle ni le client d'IA n'ont de moyen de confirmer à sa place. Pas de quota IA (aucun appel au fournisseur).
  router.get("/actions", authenticated, allRoles, actions.list)
  router.post("/actions/:id/confirm", authenticated, allRoles, actions.confirm)
  router.post("/actions/:id/cancel", authenticated, allRoles, actions.cancel)

  return router
}
