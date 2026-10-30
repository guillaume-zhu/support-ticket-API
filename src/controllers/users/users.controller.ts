import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { usersService } from "../../services/users/users.service.js"

// Lire l'id du compte dans l'URL (null s'il est invalide)
function readUserId(req: Request) {
  const id = Number(req.params.id)
  return Number.isSafeInteger(id) && id >= 1 ? id : null
}

// Lecture des requêtes HTTP de gestion des comptes ; la logique métier est dans usersService
export function usersController(prisma: PrismaClient) {
  const service = usersService(prisma)

  return {
    create: async (req: Request, res: Response) => {
      // Vérifier et normaliser les données envoyées par le Super Admin.
      const { email, role } = req.body ?? {}
      const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : ""
      if (
        !normalizedEmail ||
        normalizedEmail.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      ) {
        return res.status(400).json({ error: "email invalide" })
      }
      if (role !== "ADMIN" && role !== "AGENT" && role !== "USER") {
        return res.status(400).json({ error: "role invalide" })
      }

      const user = await service.create(normalizedEmail, role)
      if (user === "EMAIL_TAKEN") {
        return res.status(409).json({ error: "email déjà utilisé" })
      }
      return res.status(201).json(user)
    },

    invite: async (req: Request, res: Response) => {
      const id = readUserId(req)
      if (!id) {
        return res.status(400).json({ error: "id invalide" })
      }

      const result = await service.invite(id)
      if (result === "NOT_FOUND") {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (result === "NOT_INVITABLE") {
        return res.status(409).json({ error: "utilisateur non invitable" })
      }
      if (result === "EMAIL_NOT_CONFIGURED") {
        return res.status(503).json({ error: "envoi d'email non configuré" })
      }
      if (result === "SEND_FAILED") {
        return res.status(502).json({ error: "envoi de l'invitation impossible" })
      }
      return res.status(202).json({ message: "Invitation transmise" })
    },

    disable: async (req: Request, res: Response) => {
      const id = readUserId(req)
      if (!id) {
        return res.status(400).json({ error: "id invalide" })
      }

      const result = await service.disable(id)
      if (result === "NOT_FOUND") {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (result === "SUPER_ADMIN") {
        return res.status(403).json({ error: "Super Admin non désactivable" })
      }
      if (result === "NOT_ACTIVE") {
        return res.status(409).json({ error: "compte non actif" })
      }
      if (result === "CHANGED") {
        return res.status(409).json({ error: "statut du compte modifié" })
      }
      return res.json(result)
    },

    enable: async (req: Request, res: Response) => {
      const id = readUserId(req)
      if (!id) {
        return res.status(400).json({ error: "id invalide" })
      }

      const result = await service.enable(id)
      if (result === "NOT_FOUND") {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (result === "NOT_DISABLED") {
        return res.status(409).json({ error: "compte non désactivé" })
      }
      if (result === "CHANGED") {
        return res.status(409).json({ error: "statut du compte modifié" })
      }
      return res.json(result)
    },
  }
}
