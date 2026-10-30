import * as argon2 from "argon2"
import { createHash, randomBytes } from "node:crypto"
import type { Request, Response } from "express"
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"

// Réinitialisation du mot de passe par code envoyé par email
export function passwordResetController(prisma: PrismaClient) {
  return {
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

      // Verrouiller l'utilisateur pour traiter ses demandes simultanées une par une.
      // Limiter les envois répétés, puis remplacer l'ancien code par un nouveau.
      const created = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${user.id})`

        const recent = await tx.actionToken.findFirst({
          where: {
            userId: user.id,
            purpose: "PASSWORD_RESET",
            expiresAt: { gt: new Date(Date.now() + 55 * 60 * 1000) },
          },
        })
        if (recent) {
          return null
        }

        const token = randomBytes(32).toString("base64url")
        const tokenHash = createHash("sha256").update(token).digest("hex")
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
        return { token, tokenHash }
      })
      if (!created) {
        return respond()
      }
      const { token, tokenHash } = created

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
  }
}
