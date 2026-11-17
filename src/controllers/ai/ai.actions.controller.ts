import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { aiActionsService } from "../../services/ai/ai.actions.service.js"
import { aiActionsEnabled } from "../../services/ai/ai.service.js"
import { parseBody, parseConfirmBody, parseConversationId } from "../../utils/validation.js"

// Lecture des requêtes HTTP sur les actions proposées par l'assistant. L'identité vient du JWT ; chacun n'accède qu'aux SIENNES
// (l'action d'un autre est indiscernable d'une absente). C'est ici, par une requête explicite, que l'utilisateur confirme.
export function aiActionsController(prisma: PrismaClient) {
  const service = aiActionsService(prisma)

  return {
    list: async (_req: Request, res: Response) => {
      const user = res.locals.authUser as AuthenticatedUser
      return res.json({ data: await service.list(user) })
    },

    confirm: async (req: Request, res: Response) => {
      const id = parseConversationId(req.params.id) // même format d'identifiant (uuid)
      if (id === null) {
        return res.status(400).json({ error: "identifiant d'action invalide" })
      }
      const body = parseConfirmBody(req.body)
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      // Coupe-circuit : AI_TICKET_ACTIONS désactivé, plus aucune action n'est exécutée, même déjà en attente.
      if (!aiActionsEnabled()) {
        return res.status(503).json({ error: "actions de l'assistant désactivées" })
      }

      const result = await service.confirm(res.locals.authUser as AuthenticatedUser, id, body.value)
      switch (result.status) {
        case "OK":
          return res.json({ action: result.action, ticket: result.ticket })
        case "NOT_FOUND":
          return res.status(404).json({ error: "action introuvable" })
        case "TICKET_NOT_FOUND":
          return res.status(404).json({ error: "ticket introuvable : action annulée" })
        case "ALREADY_RESOLVED":
          return res.status(409).json({ error: "action déjà traitée" })
        case "EXPIRED":
          return res.status(409).json({ error: "action expirée : demandez-la de nouveau à l'assistant" })
        case "STALE":
          return res.status(409).json({ error: "le ticket a été modifié depuis la proposition : action annulée" })
        case "INVALID_ACTION":
          return res.status(409).json({ error: "action invalide : annulée" })
        case "FORBIDDEN":
          return res.status(403).json({ error: "Accès interdit : action annulée" })
        case "RESOLUTION_REQUIRED":
          return res.status(400).json({ error: "resolutionConfirmed: true est requis pour clôturer un ticket" })
      }
    },

    cancel: async (req: Request, res: Response) => {
      const id = parseConversationId(req.params.id)
      if (id === null) {
        return res.status(400).json({ error: "identifiant d'action invalide" })
      }
      const body = parseBody(req.body, []) // aucun champ attendu
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      const result = await service.cancel(res.locals.authUser as AuthenticatedUser, id)
      if (result.status === "OK") {
        return res.json({ action: result.action })
      }
      return result.status === "NOT_FOUND"
        ? res.status(404).json({ error: "action introuvable" })
        : res.status(409).json({ error: "action déjà traitée" })
    },
  }
}
