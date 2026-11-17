import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { aiConversationsService } from "../../services/ai/ai.conversations.service.js"
import { parseConversationId, parsePageQuery } from "../../utils/validation.js"

// Lecture des requêtes HTTP sur les conversations enregistrées. Chaque utilisateur n'accède qu'aux SIENNES :
// l'identité vient du JWT, et une conversation d'un autre (même pour un SUPER_ADMIN) est indiscernable d'une absente.
export function aiConversationsController(prisma: PrismaClient) {
  const service = aiConversationsService(prisma)

  return {
    list: async (req: Request, res: Response) => {
      const page = parsePageQuery(req.query, 20, 100)
      if (!page.ok) {
        return res.status(400).json({ error: page.error })
      }
      const user = res.locals.authUser as AuthenticatedUser
      return res.json(await service.list(user, page.value.page, page.value.limit))
    },

    messages: async (req: Request, res: Response) => {
      const conversationId = parseConversationId(req.params.id)
      if (conversationId === null) {
        return res.status(400).json({ error: "identifiant de conversation invalide" })
      }
      const page = parsePageQuery(req.query, 50, 100)
      if (!page.ok) {
        return res.status(400).json({ error: page.error })
      }
      const user = res.locals.authUser as AuthenticatedUser
      const result = await service.messages(user, conversationId, page.value.page, page.value.limit)
      if (!result) {
        return res.status(404).json({ error: "conversation introuvable" })
      }
      return res.json(result)
    },

    remove: async (req: Request, res: Response) => {
      const conversationId = parseConversationId(req.params.id)
      if (conversationId === null) {
        return res.status(400).json({ error: "identifiant de conversation invalide" })
      }
      const user = res.locals.authUser as AuthenticatedUser
      if (!(await service.remove(user, conversationId))) {
        return res.status(404).json({ error: "conversation introuvable" })
      }
      return res.sendStatus(204)
    },
  }
}
