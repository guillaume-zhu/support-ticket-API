import * as argon2 from "argon2"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Request, Response } from "express"
import { jwtVerify, SignJWT } from "jose"
import { Prisma, type PrismaClient } from "../generated/prisma/client.js"

const ISSUER = "support-ticket-api"
const AUDIENCE = "support-ticket-api"

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

// Création route de connexion
export function authController(prisma: PrismaClient) {
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

      // Chercher l'utilisateur dans PostgreSQL
      const user = await prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() },
      })
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
        return res.status(401).json({ error: "Identifiants invalides" })
      }
      if (!(await argon2.verify(user.passwordHash, password))) {
        return res.status(401).json({ error: "Identifiants invalides" })
      }

      // Creation session et JWT
      const sessionId = randomUUID()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const tokens = await issueTokens(user.id, sessionId, expiresAt)

      await prisma.session.create({
        data: { id: sessionId, userId: user.id, expiresAt },
      })
      return res.json(tokens)
    },

    acceptInvitation: async (req: Request, res: Response) => {
      // Vérifier le code reçu et la taille du nouveau mot de passe.
      const { token, password } = req.body ?? {}
      if (
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof password !== "string" ||
        [...password].length < 15 ||
        Buffer.byteLength(password, "utf8") > 1024
      ) {
        return res.status(400).json({ error: "token ou password invalide" })
      }

      const tokenHash = createHash("sha256").update(token).digest("hex")

      // Écarter les codes invalides avant le calcul coûteux du mot de passe.
      const existingInvitation = await prisma.actionToken.findUnique({
        where: { tokenHash },
        select: {
          purpose: true,
          expiresAt: true,
          user: { select: { status: true, passwordHash: true } },
        },
      })
      if (
        !existingInvitation ||
        existingInvitation.purpose !== "INVITATION" ||
        existingInvitation.expiresAt <= new Date() ||
        existingInvitation.user.status !== "INVITED" ||
        existingInvitation.user.passwordHash
      ) {
        return res.status(400).json({ error: "invitation invalide ou expirée" })
      }

      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      })

      // Activer le compte et supprimer ses invitations dans une seule transaction.
      const activated = await prisma.$transaction(async (tx) => {
        const invitation = await tx.actionToken.findUnique({
          where: { tokenHash },
          include: { user: true },
        })
        if (
          !invitation ||
          invitation.purpose !== "INVITATION" ||
          invitation.expiresAt <= new Date() ||
          invitation.user.status !== "INVITED" ||
          invitation.user.passwordHash
        ) {
          return false
        }

        const updated = await tx.user.updateMany({
          where: { id: invitation.userId, status: "INVITED", passwordHash: null },
          data: { passwordHash, status: "ACTIVE" },
        })
        if (updated.count !== 1) {
          return false
        }
        await tx.actionToken.deleteMany({
          where: { userId: invitation.userId, purpose: "INVITATION" },
        })
        return true
      })

      if (!activated) {
        return res.status(400).json({ error: "invitation invalide ou expirée" })
      }
      return res.sendStatus(204)
    },

    requestPasswordReset: async (req: Request, res: Response) => {
      const startedAt = Date.now()

      // Valider l'email et vérifier la configuration sans révéler si le compte existe.
      const email = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : ""
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "email invalide" })
      }
      const apiKey = process.env.RESEND_API_KEY
      const from = process.env.RESEND_FROM_EMAIL
      if (!apiKey || !from) {
        return res.status(503).json({ error: "envoi d'email non configuré" })
      }

      const message = { message: "Si un compte actif correspond, un email sera envoyé" }
      const respond = async () => {
        // Masquer les écarts de temps habituels entre les deux parcours.
        const remaining = 250 - (Date.now() - startedAt)
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining))
        }
        return res.status(202).json(message)
      }
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, status: true, passwordHash: true },
      })
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
        return respond()
      }

      // Limiter les envois répétés, puis remplacer l'ancien code par un nouveau.
      const recent = await prisma.actionToken.findFirst({
        where: {
          userId: user.id,
          purpose: "PASSWORD_RESET",
          expiresAt: { gt: new Date(Date.now() + 55 * 60 * 1000) },
        },
      })
      if (recent) {
        return respond()
      }

      const token = randomBytes(32).toString("base64url")
      const tokenHash = createHash("sha256").update(token).digest("hex")
      await prisma.$transaction(async (tx) => {
        await tx.actionToken.deleteMany({
          where: { userId: user.id, purpose: "PASSWORD_RESET" },
        })
        await tx.actionToken.create({
          data: {
            tokenHash,
            userId: user.id,
            purpose: "PASSWORD_RESET",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        })
      })

      // Envoyer le code après la transaction, sans le mettre dans la réponse ou les logs.
      void fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [user.email],
          subject: "Réinitialisation de votre mot de passe",
          text: `Votre code de réinitialisation : ${token}\nValable 1 heure.\nEnvoyez ce code et votre nouveau mot de passe à POST /auth/reset-password.`,
        }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((response) => {
          if (!response.ok) throw new Error("Envoi refusé")
        })
        .catch(async () => {
          // Retirer seulement ce code pour permettre une nouvelle demande.
          try {
            await prisma.actionToken.deleteMany({
              where: { tokenHash, userId: user.id, purpose: "PASSWORD_RESET" },
            })
          } catch {
            console.error("Nettoyage du code de réinitialisation impossible")
          }
          console.error("Envoi de réinitialisation impossible")
        })

      return respond()
    },

    resetPassword: async (req: Request, res: Response) => {
      // Vérifier le code et le mot de passe avant le calcul Argon2.
      const { token, password } = req.body ?? {}
      if (
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof password !== "string" ||
        [...password].length < 15 ||
        Buffer.byteLength(password, "utf8") > 1024
      ) {
        return res.status(400).json({ error: "token ou password invalide" })
      }

      const tokenHash = createHash("sha256").update(token).digest("hex")
      const existing = await prisma.actionToken.findUnique({
        where: { tokenHash },
        select: { purpose: true, expiresAt: true, user: { select: { status: true } } },
      })
      if (
        !existing ||
        existing.purpose !== "PASSWORD_RESET" ||
        existing.expiresAt <= new Date() ||
        existing.user.status !== "ACTIVE"
      ) {
        return res.status(400).json({ error: "code invalide ou expiré" })
      }

      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      })

      // Consommer le code, changer le mot de passe et révoquer les sessions ensemble.
      let changed: boolean
      try {
        changed = await prisma.$transaction(async (tx) => {
          const reset = await tx.actionToken.findUnique({
            where: { tokenHash },
            include: { user: true },
          })
          if (
            !reset ||
            reset.purpose !== "PASSWORD_RESET" ||
            reset.expiresAt <= new Date() ||
            reset.user.status !== "ACTIVE"
          ) {
            return false
          }

          const consumed = await tx.actionToken.deleteMany({
            where: {
              tokenHash,
              purpose: "PASSWORD_RESET",
              expiresAt: { gt: new Date() },
            },
          })
          if (consumed.count !== 1) {
            return false
          }
          await tx.user.update({
            where: { id: reset.userId, status: "ACTIVE" },
            data: { passwordHash },
          })
          await tx.actionToken.deleteMany({
            where: { userId: reset.userId, purpose: "PASSWORD_RESET" },
          })
          await tx.session.updateMany({
            where: { userId: reset.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
          return true
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
          return res.status(400).json({ error: "code invalide ou expiré" })
        }
        throw error
      }

      if (!changed) {
        return res.status(400).json({ error: "code invalide ou expiré" })
      }
      return res.sendStatus(204)
    },

    // Vérifier qu'il s'agit d'un refresh token et récupérer ses identifiants
    refresh: async (req: Request, res: Response) => {
      const { refreshToken } = req.body ?? {}
      if (typeof refreshToken !== "string" || refreshToken === "") {
        return res.status(400).json({ error: "refreshToken requis" })
      }

      const verified = await verifyRefreshToken(refreshToken)
      if (!verified) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }

      // Préparer une nouvelle session et une nouvelle paire de JWT
      const { userId, sessionId: oldSessionId } = verified
      const newSessionId = randomUUID()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
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

      if (!rotated) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }
      return res.json(tokens)
    },

    logout: async (req: Request, res: Response) => {
      const { refreshToken } = req.body ?? {}
      if (typeof refreshToken !== "string" || refreshToken === "") {
        return res.status(400).json({ error: "refreshToken requis" })
      }

      const verified = await verifyRefreshToken(refreshToken)
      if (!verified) {
        return res.status(401).json({ error: "Refresh token invalide" })
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
      if (revoked.count !== 1) {
        return res.status(401).json({ error: "Refresh token invalide" })
      }

      return res.sendStatus(204)
    },
  }
}
