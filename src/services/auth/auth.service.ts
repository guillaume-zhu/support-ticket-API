import * as argon2 from "argon2"
import { randomUUID } from "node:crypto"
import { jwtVerify, SignJWT } from "jose"
import type { PrismaClient } from "../../generated/prisma/client.js"

const ISSUER = "support-ticket-api"
const AUDIENCE = "support-ticket-api"
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

// Hash Argon2id factice, généré une fois avec les paramètres des vrais mots de passe.
// Il réduit les différences de temps de réponse quand le compte n'existe pas ou ne peut pas
// se connecter, sans garantir des durées identiques.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$sYphwXbWSU2kxHvOecKiFg$Ox2/t8ErXCUU0cb6xWcDNBxjOeO+MvzNs72+5znK7Xc"

// Récupérer secret JWT
function jwtKey(name: string): Buffer {
  const encoded = process.env[name]
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  const key = Buffer.from(encoded, "base64url")
  if (key.length !== 32) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  return key
}

export type AuthTokens = { accessToken: string; refreshToken: string }

// Règles métier d'authentification : identifiants, JWT, sessions, rotation et révocation
export function authService(prisma: PrismaClient) {
  const accessKey = jwtKey("ACCESS_TOKEN_SECRET")
  const refreshKey = jwtKey("REFRESH_TOKEN_SECRET")
  if (accessKey.equals(refreshKey)) {
    throw new Error("Les secrets JWT doivent être différents")
  }

  // Générer une paire de JWT (access + refresh) pour le login et le renouvellement
  const issueTokens = async (userId: number, sessionId: string, expiresAt: Date) => {
    const accessToken = await new SignJWT({ token_use: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti(sessionId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(accessKey)
    const refreshToken = await new SignJWT({ token_use: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti(sessionId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(refreshKey)

    return { accessToken, refreshToken }
  }

  // Vérifier le refresh JWT avant de consulter sa session.
  const verifyRefreshToken = async (token: string) => {
    const claims = await jwtVerify(token, refreshKey, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "jti", "exp"],
    })
      .then(({ payload }) => payload)
      .catch(() => null)

    if (
      !claims ||
      claims.token_use !== "refresh" ||
      typeof claims.sub !== "string" ||
      typeof claims.jti !== "string"
    ) {
      return null
    }

    const userId = Number(claims.sub)
    if (!Number.isSafeInteger(userId) || userId < 1 || String(userId) !== claims.sub) {
      return null
    }

    return { userId, sessionId: claims.jti }
  }

  return {
    // Vérifier les identifiants et ouvrir une session (null si refusé)
    login: async (email: string, password: string): Promise<AuthTokens | null> => {
      // Chercher l'utilisateur dans PostgreSQL
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
        await argon2.verify(DUMMY_PASSWORD_HASH, password)
        return null
      }
      if (!(await argon2.verify(user.passwordHash, password))) {
        return null
      }

      // Creation session et JWT
      const sessionId = randomUUID()
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
      const tokens = await issueTokens(user.id, sessionId, expiresAt)

      await prisma.session.create({
        data: { id: sessionId, userId: user.id, expiresAt },
      })
      return tokens
    },

    // Renouveler les tokens et révoquer l'ancienne session (null si refusé)
    refresh: async (refreshToken: string): Promise<AuthTokens | null> => {
      // Vérifier qu'il s'agit d'un refresh token et récupérer ses identifiants
      const verified = await verifyRefreshToken(refreshToken)
      if (!verified) {
        return null
      }

      // Préparer une nouvelle session et une nouvelle paire de JWT
      const { userId, sessionId: oldSessionId } = verified
      const newSessionId = randomUUID()
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
      const tokens = await issueTokens(userId, newSessionId, expiresAt)

      // Transaction : vérifier l'ancienne session, la révoquer et créer la nouvelle
      const rotated = await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id: oldSessionId },
          include: { user: true },
        })
        const now = new Date()
        if (
          !session ||
          session.userId !== userId ||
          session.user.status !== "ACTIVE" ||
          session.revokedAt ||
          session.expiresAt <= now
        ) {
          return false
        }

        // Révoquer l'ancienne session seulement si elle est encore valide
        // Empêche deux requêtes de renouveler simultanément le même token
        const revoked = await tx.session.updateMany({
          where: {
            id: session.id,
            userId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { revokedAt: now },
        })
        if (revoked.count !== 1) {
          return false
        }

        await tx.session.create({
          data: { id: newSessionId, userId, expiresAt },
        })
        return true
      })

      return rotated ? tokens : null
    },

    // Révoquer la session liée au refresh token (false si refusé)
    logout: async (refreshToken: string): Promise<boolean> => {
      const verified = await verifyRefreshToken(refreshToken)
      if (!verified) {
        return false
      }

      // Révoquer uniquement la session encore active liée au token.
      const now = new Date()
      const revoked = await prisma.session.updateMany({
        where: {
          id: verified.sessionId,
          userId: verified.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      })
      return revoked.count === 1
    },
  }
}
