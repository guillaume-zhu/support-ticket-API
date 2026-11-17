import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"
import { generateActionToken } from "../../utils/credentials.js"
import { recordAudit, type AuditActor } from "../shared/audit.service.js"
import { lockUserSessions } from "../shared/session-lock.js"
import { isEmailConfigured, sendEmail } from "../shared/email.service.js"

const INVITATION_LIFETIME_HOURS = 24

// Gestion des comptes : création, invitation, désactivation et réactivation.
// Chaque action réussie est tracée dans AuditLog, dans la même transaction que l'action.
export function usersService(prisma: PrismaClient) {
  return {
    // Créer un compte en attente, sans mot de passe ni invitation pour l'instant.
    create: async (email: string, role: "ADMIN" | "AGENT" | "USER", actor: AuditActor) => {
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { email, role, status: "INVITED" },
            select: { id: true, email: true, role: true, status: true },
          })
          await recordAudit(tx, { action: "USER_CREATED", actor, targetUserId: user.id, metadata: { role } })
          return user
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return "EMAIL_TAKEN" as const
        }
        throw error
      }
    },

    // Envoyer une invitation à un compte qui attend son activation.
    invite: async (id: number, actor: AuditActor) => {
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

      // 1) Créer le code (seul son hash est conservé) et son audit, ensemble et en base uniquement :
      //    aucun appel réseau dans la transaction.
      const { token, tokenHash } = generateActionToken()
      const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_HOURS * 60 * 60 * 1000)
      await prisma.$transaction(async (tx) => {
        await tx.actionToken.deleteMany({ where: { userId: id, purpose: "INVITATION" } })
        await tx.actionToken.create({
          data: { tokenHash, userId: id, purpose: "INVITATION", expiresAt },
        })
        await recordAudit(tx, {
          action: "USER_INVITATION_CREATED",
          actor,
          targetUserId: id,
          metadata: { expiresInHours: INVITATION_LIFETIME_HOURS },
        })
      })

      // 2) Envoyer le code APRÈS la transaction validée et ATTENDRE le résultat : un échec doit être
      //    signalé au Super Admin. Le code reste en base si l'envoi échoue (il n'a jamais été transmis).
      const sent = await sendEmail({
        to: user.email,
        subject: "Invitation à Support Ticket API",
        text: `Votre code d'invitation : ${token}\nValable 24 heures.\nPour activer votre compte, envoyez ce code et votre nouveau mot de passe à POST /auth/accept-invitation.`,
      })
      if (sent) {
        return "SENT" as const
      }

      // 3) Tracer l'échec. Un email ne s'annule pas et l'échec n'est pas atomique avec l'envoi : si cette écriture
      //    échoue, on garde la réponse métier (502) plutôt que de la remplacer par une erreur interne.
      try {
        await recordAudit(prisma, { action: "USER_INVITATION_SEND_FAILED", actor, targetUserId: id })
      } catch {
        console.error("Audit de l'échec d'envoi d'invitation impossible")
      }
      return "SEND_FAILED" as const
    },

    // Désactiver un compte (jamais le Super Admin) et révoquer ses sessions.
    disable: async (id: number, actor: AuditActor) => {
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

      // Changer le statut, révoquer les sessions et écrire l'audit dans une seule transaction.
      const disabled = await prisma.$transaction(async (tx) => {
        // Même verrou que refresh : une session créée par un renouvellement en cours ne peut pas échapper à la révocation.
        await lockUserSessions(tx, id)
        const updated = await tx.user.updateMany({
          where: { id, status: "ACTIVE", role: { not: "SUPER_ADMIN" } },
          data: { status: "DISABLED" },
        })
        if (updated.count !== 1) {
          return false
        }
        const revoked = await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        await recordAudit(tx, {
          action: "USER_DISABLED",
          actor,
          targetUserId: id,
          metadata: { statusBefore: "ACTIVE", statusAfter: "DISABLED", revokedSessions: revoked.count },
        })
        return true
      })
      if (!disabled) {
        return "CHANGED" as const
      }
      return { ...user, status: "DISABLED" as const }
    },

    // Réactiver un compte désactivé, sans restaurer ses anciennes sessions.
    enable: async (id: number, actor: AuditActor) => {
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

      const enabled = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id, status: "DISABLED" },
          data: { status: "ACTIVE" },
        })
        if (updated.count !== 1) {
          return false
        }
        await recordAudit(tx, {
          action: "USER_ENABLED",
          actor,
          targetUserId: id,
          metadata: { statusBefore: "DISABLED", statusAfter: "ACTIVE" },
        })
        return true
      })
      if (!enabled) {
        return "CHANGED" as const
      }
      return { ...user, status: "ACTIVE" as const }
    },
  }
}
