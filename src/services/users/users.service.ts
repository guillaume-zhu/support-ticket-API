import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"
import { generateActionToken } from "../../utils/credentials.js"
import { isEmailConfigured, sendEmail } from "../shared/email.service.js"

// Gestion des comptes : création, invitation, désactivation et réactivation
export function usersService(prisma: PrismaClient) {
  return {
    // Créer un compte en attente, sans mot de passe ni invitation pour l'instant.
    create: async (email: string, role: "ADMIN" | "AGENT" | "USER") => {
      try {
        return await prisma.user.create({
          data: { email, role, status: "INVITED" },
          select: { id: true, email: true, role: true, status: true },
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return "EMAIL_TAKEN" as const
        }
        throw error
      }
    },

    // Envoyer une invitation à un compte qui attend son activation.
    invite: async (id: number) => {
      // Vérifier que le compte existe et attend son activation.
      const user = await prisma.user.findUnique({
        where: { id },
        select: { email: true, status: true, passwordHash: true },
      })
      if (!user) {
        return "NOT_FOUND" as const
      }
      if (user.status !== "INVITED" || user.passwordHash) {
        return "NOT_INVITABLE" as const
      }
      if (!isEmailConfigured()) {
        return "EMAIL_NOT_CONFIGURED" as const
      }

      // Remplacer les anciennes invitations par un code temporaire dont seul le hash est conservé.
      const { token, tokenHash } = generateActionToken()
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      await prisma.$transaction(async (tx) => {
        await tx.actionToken.deleteMany({ where: { userId: id, purpose: "INVITATION" } })
        await tx.actionToken.create({
          data: { tokenHash, userId: id, purpose: "INVITATION", expiresAt },
        })
      })

      // Envoyer le code et ATTENDRE le résultat : un échec doit être signalé au Super Admin.
      // Le code reste en base si l'envoi échoue (il n'a jamais été transmis).
      const sent = await sendEmail({
        to: user.email,
        subject: "Invitation à Support Ticket API",
        text: `Votre code d'invitation : ${token}\nValable 24 heures.\nPour activer votre compte, envoyez ce code et votre nouveau mot de passe à POST /auth/accept-invitation.`,
      })
      return sent ? ("SENT" as const) : ("SEND_FAILED" as const)
    },

    // Désactiver un compte (jamais le Super Admin) et révoquer ses sessions.
    disable: async (id: number) => {
      // Vérifier le compte et refuser la désactivation du Super Admin.
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, status: true },
      })
      if (!user) {
        return "NOT_FOUND" as const
      }
      if (user.role === "SUPER_ADMIN") {
        return "SUPER_ADMIN" as const
      }
      if (user.status !== "ACTIVE") {
        return "NOT_ACTIVE" as const
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
        return "CHANGED" as const
      }
      return { ...user, status: "DISABLED" as const }
    },

    // Réactiver un compte désactivé, sans restaurer ses anciennes sessions.
    enable: async (id: number) => {
      // Vérifier que le compte existe et qu'il est désactivé.
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, status: true },
      })
      if (!user) {
        return "NOT_FOUND" as const
      }
      if (user.status !== "DISABLED") {
        return "NOT_DISABLED" as const
      }

      const updated = await prisma.user.updateMany({
        where: { id, status: "DISABLED" },
        data: { status: "ACTIVE" },
      })
      if (updated.count !== 1) {
        return "CHANGED" as const
      }
      return { ...user, status: "ACTIVE" as const }
    },
  }
}
