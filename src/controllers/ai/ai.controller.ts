import type { Request, Response } from "express"
import { aiService } from "../../services/ai/ai.service.js"
import { parseChatBody } from "../../utils/validation.js"

// Lecture des requêtes HTTP de l'assistant ; l'appel au fournisseur d'IA est dans aiService
export function aiController() {
  const service = aiService()

  return {
    // Répondre à une conversation. Le contenu des messages n'est ni stocké ni journalisé.
    chat: async (req: Request, res: Response) => {
      const parsed = parseChatBody(req.body)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }

      const result = await service.chat(parsed.value)
      if (result.status === "NOT_CONFIGURED") {
        return res.status(503).json({ error: "assistant non configuré" })
      }
      if (result.status === "PROVIDER_FAILED") {
        // Message volontairement générique : rien du fournisseur (ni sa clé, ni son erreur) n'est transmis.
        return res.status(502).json({ error: "assistant indisponible" })
      }
      return res.json({ reply: result.reply })
    },
  }
}
