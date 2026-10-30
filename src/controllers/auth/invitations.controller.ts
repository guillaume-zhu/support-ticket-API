import * as argon2 from "argon2"
import { createHash } from "node:crypto"
import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"

// Activation d'un compte invité à partir du code reçu par email
export function invitationsController(prisma: PrismaClient) {
  return {
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
  }
}
