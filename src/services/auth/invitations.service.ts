import type { PrismaClient } from "../../generated/prisma/client.js"
import { hashActionToken, hashPassword } from "../credentials.js"

// Activation d'un compte invité à partir du code reçu par email
export function invitationsService(prisma: PrismaClient) {
  return {
    // Activer le compte et consommer ses invitations (false si le code est invalide ou expiré)
    acceptInvitation: async (token: string, password: string): Promise<boolean> => {
      const tokenHash = hashActionToken(token)

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
        return false
      }

      const passwordHash = await hashPassword(password)

      // Activer le compte et supprimer ses invitations dans une seule transaction.
      return prisma.$transaction(async (tx) => {
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
    },
  }
}
