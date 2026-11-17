import type { AuditAction, Prisma, PrismaClient, Role, TicketStatus } from "../../generated/prisma/client.js"
import type { AuditLogListOptions } from "../../utils/validation.js"

// Qui agit : un compte identifié (id + rôle au moment de l'action), ou personne (script CLI).
export type AuditActor = { id: number; role: Role } | null

// Chaque événement déclare exactement les métadonnées autorisées : le compilateur interdit d'y glisser
// autre chose (mot de passe, token, hash, email...). Ne jamais y copier le body d'une requête.
export type AuditEvent =
  | { action: "USER_CREATED"; actor: AuditActor; targetUserId: number; metadata: { role: Role } }
  | { action: "USER_INVITATION_CREATED"; actor: AuditActor; targetUserId: number; metadata: { expiresInHours: number } }
  | { action: "USER_INVITATION_SEND_FAILED"; actor: AuditActor; targetUserId: number }
  | {
      action: "USER_DISABLED"
      actor: AuditActor
      targetUserId: number
      metadata: { statusBefore: "ACTIVE"; statusAfter: "DISABLED"; revokedSessions: number }
    }
  | {
      action: "USER_ENABLED"
      actor: AuditActor
      targetUserId: number
      metadata: { statusBefore: "DISABLED"; statusAfter: "ACTIVE" }
    }
  | {
      action: "INVITATION_ACCEPTED"
      actor: AuditActor
      targetUserId: number
      metadata: { statusBefore: "INVITED"; statusAfter: "ACTIVE" }
    }
  | {
      action: "PASSWORD_RESET_COMPLETED"
      actor: AuditActor
      targetUserId: number
      metadata: { revokedSessions: number }
    }
  | { action: "SUPER_ADMIN_BOOTSTRAPPED"; actor: null; targetUserId: number; metadata: { source: "cli" } }
  // Actions exécutées APRÈS confirmation de l'utilisateur. L'acteur est l'utilisateur qui a confirmé ; le ticket concerné est
  // dans les métadonnées (jamais son titre ni sa description).
  | { action: "ASSISTANT_TICKET_CREATED"; actor: AuditActor; targetUserId: number; metadata: { pendingActionId: string; ticketId: number } }
  | {
      action: "ASSISTANT_TICKET_STATUS_CHANGED"
      actor: AuditActor
      targetUserId: number
      metadata: { pendingActionId: string; ticketId: number; statusBefore: TicketStatus; statusAfter: TicketStatus }
    }

// Ajouter une ligne au registre. Passer le client `tx` d'une transaction pour que l'audit réussisse
// ou échoue avec l'action métier (atomicité) ; un simple `prisma` écrit hors transaction.
export function recordAudit(db: Pick<Prisma.TransactionClient, "auditLog">, event: AuditEvent) {
  const metadata = "metadata" in event ? event.metadata : undefined
  return db.auditLog.create({
    data: {
      action: event.action,
      actorId: event.actor?.id ?? null,
      actorRole: event.actor?.role ?? null,
      targetUserId: event.targetUserId,
      ...(metadata && { metadata }),
    },
  })
}

export function auditService(prisma: PrismaClient) {
  return {
    // Une page du registre, du plus récent au plus ancien, avec le total correspondant.
    list: async (options: AuditLogListOptions) => {
      const where: Prisma.AuditLogWhereInput = {
        ...(options.action && { action: options.action as AuditAction }),
        ...(options.actorId !== undefined && { actorId: options.actorId }),
        ...(options.targetUserId !== undefined && { targetUserId: options.targetUserId }),
      }

      // RepeatableRead (forme interactive) : data et total sont lus au même instant.
      const [data, total] = await prisma.$transaction(
        async (tx) => {
          const data = await tx.auditLog.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (options.page - 1) * options.limit,
            take: options.limit,
          })
          const total = await tx.auditLog.count({ where })
          return [data, total] as const
        },
        { isolationLevel: "RepeatableRead" },
      )

      return {
        data,
        meta: { page: options.page, limit: options.limit, total, totalPages: Math.ceil(total / options.limit) },
      }
    },
  }
}
