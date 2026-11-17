import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { authService } from "../../services/auth/auth.service.js"
import { PASSWORD_MAX_BYTES } from "../../utils/credentials.js"
import { MAX_JWT_LENGTH } from "../../utils/jwt.js"
import { isValidEmail, normalizeEmail, parseBody } from "../../utils/validation.js"

// Lecture des requêtes HTTP d'authentification ; la logique métier est dans authService
export function authController(prisma: PrismaClient) {
  const service = authService(prisma)

  return {
    // Vérification des identifiants de connexion
    login: async (req: Request, res: Response) => {
      const body = parseBody(req.body, ["email", "password"])
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      // Tous les comptes ont un email valide : un autre format ne peut correspondre à aucun compte.
      const { email, password } = body.value
      if (
        !isValidEmail(normalizeEmail(email)) ||
        typeof password !== "string" ||
        password === "" ||
        Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES
      ) {
        return res.status(400).json({ error: "email et password requis" })
      }

      const tokens = await service.login(normalizeEmail(email), password)
      if (!tokens) {
        return res.status(401).json({ error: "Identifiants invalides" })
      }
      return res.json(tokens)
    },

    // Renouvellement des tokens
    refresh: async (req: Request, res: Response) => {
      const body = parseBody(req.body, ["refreshToken"])
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      const { refreshToken } = body.value
      if (typeof refreshToken !== "string" || refreshToken === "" || refreshToken.length > MAX_JWT_LENGTH) {
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
      const body = parseBody(req.body, ["refreshToken"])
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      const { refreshToken } = body.value
      if (typeof refreshToken !== "string" || refreshToken === "" || refreshToken.length > MAX_JWT_LENGTH) {
        return res.status(400).json({ error: "refreshToken requis" })
      }

      if (!(await service.logout(refreshToken))) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }
      return res.sendStatus(204)
    },
  }
}
