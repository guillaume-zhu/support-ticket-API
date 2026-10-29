import { createHash, randomBytes } from "node:crypto"
import type { Request, Response } from "express"
import { Prisma, type PrismaClient } from "../generated/prisma/client.js"

export function usersController(prisma: PrismaClient) {
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

      // Créer un compte en attente, sans mot de passe ni invitation pour l'instant.
      try {
        const user = await prisma.user.create({
          data: { email: normalizedEmail, role, status: "INVITED" },
          select: { id: true, email: true, role: true, status: true },
        })
        return res.status(201).json(user)
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return res.status(409).json({ error: "email déjà utilisé" })
        }
        throw error
      }
    },

    invite: async (req: Request, res: Response) => {
      // Vérifier que le compte existe et attend son activation.
      const id = Number(req.params.id)
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "id invalide" })
      }
      const user = await prisma.user.findUnique({
        where: { id },
        select: { email: true, status: true, passwordHash: true },
      })
      if (!user) {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (user.status !== "INVITED" || user.passwordHash) {
        return res.status(409).json({ error: "utilisateur non invitable" })
      }

      const apiKey = process.env.RESEND_API_KEY
      const from = process.env.RESEND_FROM_EMAIL
      if (!apiKey || !from) {
        return res.status(503).json({ error: "envoi d'email non configuré" })
      }

      // Remplacer les anciennes invitations par un code temporaire dont seul le hash est conservé.
      const token = randomBytes(32).toString("base64url")
      const tokenHash = createHash("sha256").update(token).digest("hex")
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      await prisma.$transaction(async (tx) => {
        await tx.actionToken.deleteMany({ where: { userId: id, purpose: "INVITATION" } })
        await tx.actionToken.create({
          data: { tokenHash, userId: id, purpose: "INVITATION", expiresAt },
        })
      })

      // Envoyer le code à l'adresse du compte, sans l'exposer dans la réponse HTTP.
      let sent = false
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [user.email],
            subject: "Invitation à Support Ticket API",
            text: `Votre code d'invitation : ${token}\nValable 24 heures.\nPour activer votre compte, envoyez ce code et votre nouveau mot de passe à POST /auth/accept-invitation.`,
          }),
          signal: AbortSignal.timeout(10_000),
        })
        sent = response.ok
      } catch {
        sent = false
      }
      if (!sent) {
        return res.status(502).json({ error: "envoi de l'invitation impossible" })
      }
      return res.status(202).json({ message: "Invitation transmise" })
    },

    disable: async (req: Request, res: Response) => {
      // Vérifier le compte et refuser la désactivation du Super Admin.
      const id = Number(req.params.id)
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "id invalide" })
      }
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, status: true },
      })
      if (!user) {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (user.role === "SUPER_ADMIN") {
        return res.status(403).json({ error: "Super Admin non désactivable" })
      }
      if (user.status !== "ACTIVE") {
        return res.status(409).json({ error: "compte non actif" })
      }

      // Changer le statut et révoquer toutes les sessions dans une transaction.
      const disabled = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id, status: "ACTIVE", role: { not: "SUPER_ADMIN" } },
          data: { status: "DISABLED" },
        })
        if (updated.count !== 1) {
          return false
        }
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        return true
      })
      if (!disabled) {
        return res.status(409).json({ error: "statut du compte modifié" })
      }
      return res.json({ ...user, status: "DISABLED" })
    },

    enable: async (req: Request, res: Response) => {
      // Vérifier que le compte existe et qu'il est désactivé.
      const id = Number(req.params.id)
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "id invalide" })
      }
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, status: true },
      })
      if (!user) {
        return res.status(404).json({ error: "utilisateur introuvable" })
      }
      if (user.status !== "DISABLED") {
        return res.status(409).json({ error: "compte non désactivé" })
      }

      // Réactiver le compte sans restaurer ses anciennes sessions.
      const updated = await prisma.user.updateMany({
        where: { id, status: "DISABLED" },
        data: { status: "ACTIVE" },
      })
      if (updated.count !== 1) {
        return res.status(409).json({ error: "statut du compte modifié" })
      }
      return res.json({ ...user, status: "ACTIVE" })
    },
  }
}
