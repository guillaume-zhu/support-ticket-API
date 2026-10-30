import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"
import { generateActionToken, hashActionToken, hashPassword } from "../credentials.js"
import { isEmailConfigured, sendEmail } from "../shared/email.service.js"

// Réinitialisation du mot de passe par code envoyé par email
export function passwordResetService(prisma: PrismaClient) {
  return {
    // Créer et envoyer un code si le compte est actif et sans demande récente.
    // Ne révèle jamais si le compte existe : "DONE" dans tous les cas, sauf configuration manquante.
    requestPasswordReset: async (email: string): Promise<"EMAIL_NOT_CONFIGURED" | "DONE"> => {
      if (!isEmailConfigured()) {
        return "EMAIL_NOT_CONFIGURED"
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, status: true, passwordHash: true },
      })
      if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
        return "DONE"
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

        const { token, tokenHash } = generateActionToken()
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
        return "DONE"
      }
      const { token, tokenHash } = created

      // Envoyer le code après la transaction, SANS attendre Resend : la réponse HTTP ne dépend pas de l'envoi.
      // En cas d'échec, retirer seulement ce code pour permettre une nouvelle demande.
      void sendEmail({
        to: user.email,
        subject: "Réinitialisation de votre mot de passe",
        text: `Votre code de réinitialisation : ${token}\nValable 1 heure.\nEnvoyez ce code et votre nouveau mot de passe à POST /auth/reset-password.`,
      }).then(async (sent) => {
        if (sent) return
        try {
          await prisma.actionToken.deleteMany({
            where: { tokenHash, userId: user.id, purpose: "PASSWORD_RESET" },
          })
        } catch {
          console.error("Nettoyage du code de réinitialisation impossible")
        }
        console.error("Envoi de réinitialisation impossible")
      })

      return "DONE"
    },

    // Changer le mot de passe avec un code valide (false si le code est invalide ou expiré)
    resetPassword: async (token: string, password: string): Promise<boolean> => {
      const tokenHash = hashActionToken(token)
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
        return false
      }

      const passwordHash = await hashPassword(password)

      // Consommer le code, changer le mot de passe et révoquer les sessions ensemble.
      try {
        return await prisma.$transaction(async (tx) => {
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
          return false
        }
        throw error
      }
    },
  }
}
