import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { authService } from "../../services/auth/auth.service.js"

// Lecture des requêtes HTTP d'authentification ; la logique métier est dans authService
export function authController(prisma: PrismaClient) {
  const service = authService(prisma)

  return {
    // Vérification des identifiants de connexion
    login: async (req: Request, res: Response) => {
      const { email, password } = req.body ?? {}
      if (
        typeof email !== "string" ||
        email.trim() === "" ||
        email.length > 254 ||
        typeof password !== "string" ||
        password === "" ||
        Buffer.byteLength(password, "utf8") > 1024
      ) {
        return res.status(400).json({ error: "email et password requis" })
      }

      const tokens = await service.login(email.trim().toLowerCase(), password)
      if (!tokens) {
        return res.status(401).json({ error: "Identifiants invalides" })
      }
      return res.json(tokens)
    },

    // Renouvellement des tokens
    refresh: async (req: Request, res: Response) => {
      const { refreshToken } = req.body ?? {}
      if (typeof refreshToken !== "string" || refreshToken === "") {
        return res.status(400).json({ error: "refreshToken requis" })
      }

      const tokens = await service.refresh(refreshToken)
      if (!tokens) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }
      return res.json(tokens)
    },

    // Déconnexion
    logout: async (req: Request, res: Response) => {
      const { refreshToken } = req.body ?? {}
      if (typeof refreshToken !== "string" || refreshToken === "") {
        return res.status(400).json({ error: "refreshToken requis" })
      }

      if (!(await service.logout(refreshToken))) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }
      return res.sendStatus(204)
    },
  }
}
