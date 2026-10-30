import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { isActionTokenFormat, isValidNewPassword } from "../../services/credentials.js"
import { invitationsService } from "../../services/auth/invitations.service.js"

// Lecture des requêtes HTTP d'activation ; la logique métier est dans invitationsService
export function invitationsController(prisma: PrismaClient) {
  const service = invitationsService(prisma)

  return {
    acceptInvitation: async (req: Request, res: Response) => {
      // Vérifier le code reçu et la taille du nouveau mot de passe.
      const { token, password } = req.body ?? {}
      if (!isActionTokenFormat(token) || !isValidNewPassword(password)) {
        return res.status(400).json({ error: "token ou password invalide" })
      }

      if (!(await service.acceptInvitation(token, password))) {
        return res.status(400).json({ error: "invitation invalide ou expirée" })
      }
      return res.sendStatus(204)
    },
  }
}
