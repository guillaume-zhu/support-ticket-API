import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { aiService } from "../../services/ai/ai.service.js"
import { parseChatBody } from "../../utils/validation.js"

// Lecture des requêtes HTTP de l'assistant ; l'appel au fournisseur d'IA et la boucle d'outils sont dans aiService
export function aiController(prisma: PrismaClient) {
  const service = aiService(prisma)

  return {
    // Répondre à une conversation. Le contenu des messages n'est ni stocké ni journalisé.
    chat: async (req: Request, res: Response) => {
      const parsed = parseChatBody(req.body)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }

      // L'identité vient du JWT validé par `authenticate` : c'est elle, et seulement elle, qui fixe les droits des outils.
      const user = res.locals.authUser as AuthenticatedUser
      const result = await service.chat(parsed.value, user)
      if (result.status === "NOT_CONFIGURED") {
        return res.status(503).json({ error: "assistant non configuré" })
      }
      if (result.status === "PROVIDER_FAILED") {
        // Message volontairement générique : rien du fournisseur (ni sa clé, ni son erreur) n'est transmis.
        return res.status(502).json({ error: "assistant indisponible" })
      }
      // toolsUsed : noms des outils exécutés AVEC SUCCÈS par le serveur (jamais leurs arguments ni leur contenu).
      return res.json({ reply: result.reply, toolsUsed: result.toolsUsed })
    },
  }
}
