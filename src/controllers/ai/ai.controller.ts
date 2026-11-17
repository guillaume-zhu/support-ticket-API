import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { aiConversationsService } from "../../services/ai/ai.conversations.service.js"
import { parseChatRequest } from "../../utils/validation.js"

// Lecture des requêtes HTTP de l'assistant ; l'historique est dans aiConversationsService, l'appel au fournisseur
// et la boucle d'outils dans aiService.
export function aiController(prisma: PrismaClient) {
  const service = aiConversationsService(prisma)

  return {
    // Poser une question dans une nouvelle conversation, ou poursuivre une conversation existante.
    // Le contenu des messages est enregistré dans la base (jamais journalisé) ; seul le propriétaire peut le relire.
    chat: async (req: Request, res: Response) => {
      const parsed = parseChatRequest(req.body)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }

      // L'identité vient du JWT validé par `authenticate` : elle fixe le propriétaire de la conversation et les droits des outils.
      const user = res.locals.authUser as AuthenticatedUser
      const result = await service.converse(user, parsed.value)
      switch (result.status) {
        case "NOT_CONFIGURED":
          return res.status(503).json({ error: "assistant non configuré" })
        case "PROVIDER_FAILED":
          // Message volontairement générique : rien du fournisseur (ni sa clé, ni son erreur) n'est transmis.
          return res.status(502).json({ error: "assistant indisponible" })
        case "CONVERSATION_NOT_FOUND":
          // Même réponse pour une conversation absente et pour celle d'un autre utilisateur.
          return res.status(404).json({ error: "conversation introuvable" })
        case "CONVERSATION_FULL":
          return res.status(409).json({ error: "conversation pleine : en commencer une nouvelle" })
        case "TOO_MANY_PENDING_ACTIONS":
          return res.status(409).json({ error: "trop d'actions en attente : confirmez ou annulez les précédentes" })
        case "TOO_MANY_CONVERSATIONS":
          return res.status(409).json({ error: "trop de conversations : en supprimer une avant d'en créer une nouvelle" })
        case "OK":
          // toolsUsed : noms des outils exécutés AVEC SUCCÈS par le serveur (jamais leurs arguments ni leur contenu).
          // pendingActions : actions proposées, EN ATTENTE ; leur résumé est écrit par le serveur. Rien n'est modifié tant que
          // l'utilisateur ne les a pas confirmées (POST /ai/actions/:id/confirm).
          return res.json({ conversationId: result.conversationId, reply: result.reply, toolsUsed: result.toolsUsed, pendingActions: result.pendingActions })
      }
    },
  }
}
