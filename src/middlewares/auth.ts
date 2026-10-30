import type { RequestHandler } from "express"
import { jwtVerify } from "jose"
import type { PrismaClient, Role } from "../generated/prisma/client.js"
import {
  ACCESS_TOKEN_LIFETIME,
  JWT_AUDIENCE,
  JWT_ISSUER,
  jwtKey,
  parseSubjectId,
} from "../utils/jwt.js"

export type AuthenticatedUser = { id: number; role: Role }

export function authenticate(prisma: PrismaClient): RequestHandler {
  // Préparer la clé qui permet de vérifier les access tokens.
  const accessKey = jwtKey("ACCESS_TOKEN_SECRET")

  return async (req, res, next) => {
    // Lire le token envoyé et vérifier sa signature, sa durée et son usage.
    const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]
    if (!token) {
      return res.status(401).json({ error: "Authentification requise" })
    }

    const claims = await jwtVerify(token, accessKey, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      requiredClaims: ["sub", "jti", "exp"],
      maxTokenAge: ACCESS_TOKEN_LIFETIME,
    })
      .then(({ payload }) => payload)
      .catch(() => null)

    if (
      !claims ||
      claims.token_use !== "access" ||
      typeof claims.sub !== "string" ||
      typeof claims.jti !== "string"
    ) {
      return res.status(401).json({ error: "Authentification requise" })
    }

    const userId = parseSubjectId(claims.sub)
    if (userId === null) {
      return res.status(401).json({ error: "Authentification requise" })
    }

    // Relire le compte en base pour utiliser son rôle et son statut actuels.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    })
    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ error: "Authentification requise" })
    }

    // Vérifier que la session liée au token est encore active.
    const session = await prisma.session.findUnique({
      where: { id: claims.jti },
      select: { userId: true, revokedAt: true, expiresAt: true },
    })
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    ) {
      return res.status(401).json({ error: "Authentification requise" })
    }

    // Rendre l'utilisateur disponible pour le contrôle des rôles et les controllers.
    res.locals.authUser = { id: user.id, role: user.role } satisfies AuthenticatedUser
    next()
  }
}

export function requireRoles(...allowedRoles: Role[]): RequestHandler {
  return (_req, res, next) => {
    // Laisser passer uniquement un utilisateur authentifié avec un rôle autorisé.
    const user = res.locals.authUser as AuthenticatedUser | undefined
    if (!user) {
      return res.status(401).json({ error: "Authentification requise" })
    }
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: "Accès interdit" })
    }
    next()
  }
}
