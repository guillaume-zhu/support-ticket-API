import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { isActionTokenFormat, isValidNewPassword } from "../../services/credentials.js"
import { passwordResetService } from "../../services/auth/password-reset.service.js"

// Lecture des requêtes HTTP de réinitialisation ; la logique métier est dans passwordResetService
export function passwordResetController(prisma: PrismaClient) {
  const service = passwordResetService(prisma)

  return {
    requestPasswordReset: async (req: Request, res: Response) => {
      const startedAt = Date.now()

      // Valider l'email sans révéler si le compte existe.
      const email = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : ""
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "email invalide" })
      }

      const result = await service.requestPasswordReset(email)
      if (result === "EMAIL_NOT_CONFIGURED") {
        return res.status(503).json({ error: "envoi d'email non configuré" })
      }

      // Masquer les écarts de temps habituels entre les deux parcours.
      const remaining = 250 - (Date.now() - startedAt)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
      return res.status(202).json({ message: "Si un compte actif correspond, un email sera envoyé" })
    },

    resetPassword: async (req: Request, res: Response) => {
      // Vérifier le code et le mot de passe avant le calcul Argon2.
      const { token, password } = req.body ?? {}
      if (!isActionTokenFormat(token) || !isValidNewPassword(password)) {
        return res.status(400).json({ error: "token ou password invalide" })
      }

      if (!(await service.resetPassword(token, password))) {
        return res.status(400).json({ error: "code invalide ou expiré" })
      }
      return res.sendStatus(204)
    },
  }
}
