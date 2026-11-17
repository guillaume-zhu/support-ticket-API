import type { AiPendingAction, PrismaClient, Ticket, TicketStatus } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import {
  parseId,
  parseText,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "../../utils/validation.js"
import { recordAudit } from "../shared/audit.service.js"
import { ticketsService } from "../tickets/tickets.service.js"
import { activePendingWhere, appendServerMessage, lockUserAiWrites, type PendingActionView } from "./ai.conversations.service.js"
import type { Proposal } from "./ai.tools.js"

// Actions proposées par l'assistant, en attente de la confirmation de l'utilisateur.
// Le modèle n'exécute JAMAIS rien : il propose (voir ai.tools.ts). L'écriture réelle n'a lieu qu'ici, quand l'utilisateur confirme
// par une requête HTTP authentifiée, et seulement après revérification de tout (propriétaire, état, expiration, droits, ticket).
// Aucun log ici : les titres et descriptions des tickets ne sont jamais journalisés.

export type ActionResult = { id: string; kind: Proposal["kind"]; status: "CONFIRMED" | "CANCELLED" }

export type ConfirmResult =
  | { status: "OK"; action: ActionResult; ticket: Ticket }
  | { status: "NOT_FOUND" | "ALREADY_RESOLVED" | "EXPIRED" | "INVALID_ACTION" | "RESOLUTION_REQUIRED" | "FORBIDDEN" | "STALE" | "TICKET_NOT_FOUND" }

export type CancelResult = { status: "OK"; action: ActionResult } | { status: "NOT_FOUND" | "ALREADY_RESOLVED" }

// Relire les données stockées de l'action avec les MÊMES règles qu'à la proposition (défense si la base était modifiée à la main).
type StoredProposal =
  | { kind: "CREATE_TICKET"; payload: { title: string; description: string } }
  | { kind: "CHANGE_STATUS"; payload: { ticketId: number; fromStatus: TicketStatus; toStatus: TicketStatus } }

function readProposal(action: Pick<AiPendingAction, "kind" | "payload">): StoredProposal | null {
  const payload = action.payload as Record<string, unknown> | null
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null

  if (action.kind === "CREATE_TICKET") {
    const title = parseText(payload.title, TICKET_TITLE_MAX_LENGTH)
    const description = parseText(payload.description, TICKET_DESCRIPTION_MAX_LENGTH, true)
    return title !== null && description !== null ? { kind: "CREATE_TICKET", payload: { title, description } } : null
  }

  const ticketId = typeof payload.ticketId === "number" ? parseId(String(payload.ticketId)) : null
  const known = (value: unknown): value is (typeof TICKET_STATUSES)[number] => typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value)
  if (ticketId === null || !known(payload.fromStatus) || !known(payload.toStatus) || payload.fromStatus === payload.toStatus) return null
  return { kind: "CHANGE_STATUS", payload: { ticketId, fromStatus: payload.fromStatus, toStatus: payload.toStatus } }
}

export function aiActionsService(prisma: PrismaClient) {
  const tickets = ticketsService(prisma)

  return {
    // Mes actions en attente et non périmées (jamais celles d'un autre).
    list: async (user: AuthenticatedUser): Promise<PendingActionView[]> =>
      prisma.aiPendingAction.findMany({
        where: activePendingWhere(user.id, new Date()),
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, summary: true, expiresAt: true },
      }),

    // Confirmer une action : tout se passe dans UNE transaction, sous le verrou court de l'utilisateur.
    // Si l'audit ou n'importe quelle écriture échoue, tout est annulé et l'action reste en attente.
    confirm: async (user: AuthenticatedUser, id: string, options: { resolutionConfirmed: boolean }): Promise<ConfirmResult> =>
      prisma.$transaction(async (tx): Promise<ConfirmResult> => {
        await lockUserAiWrites(tx, user.id)
        const now = new Date()

        // Le filtre sur userId est la barrière d'isolation : l'action d'un autre est indiscernable d'une absente.
        const action = await tx.aiPendingAction.findFirst({ where: { id, userId: user.id } })
        if (!action) return { status: "NOT_FOUND" }
        if (action.status !== "PENDING") return { status: "ALREADY_RESOLVED" }

        // Résoudre une action sans l'exécuter : on efface ses données (titre, description) et son résumé.
        const cancel = (reason: string) =>
          tx.aiPendingAction
            .update({ where: { id: action.id }, data: { status: "CANCELLED", resolvedAt: now, payload: {}, summary: "" } })
            .then(() => (reason ? appendServerMessage(tx, action.conversationId, reason) : undefined))

        if (action.expiresAt <= now) {
          await cancel("")
          return { status: "EXPIRED" }
        }
        const proposal = readProposal(action)
        if (!proposal) {
          await cancel("")
          return { status: "INVALID_ACTION" }
        }

        // Clôturer exige l'attestation explicite de l'utilisateur : refus AVANT de consommer l'action, qui reste en attente.
        if (proposal.kind === "CHANGE_STATUS" && proposal.payload.toStatus === "CLOSED" && !options.resolutionConfirmed) {
          return { status: "RESOLUTION_REQUIRED" }
        }

        // Usage unique, atomique : une seule confirmation peut faire passer l'action de PENDING à CONFIRMED.
        const claimed = await tx.aiPendingAction.updateMany({
          where: { id: action.id, status: "PENDING" },
          data: { status: "CONFIRMED", resolvedAt: now, payload: {}, summary: "" },
        })
        if (claimed.count !== 1) return { status: "ALREADY_RESOLVED" }
        const resolved: ActionResult = { id: action.id, kind: action.kind, status: "CONFIRMED" }
        const actor = { id: user.id, role: user.role }

        if (proposal.kind === "CREATE_TICKET") {
          const ticket = await tickets.create(proposal.payload, user, tx)
          await recordAudit(tx, { action: "ASSISTANT_TICKET_CREATED", actor, targetUserId: user.id, metadata: { pendingActionId: action.id, ticketId: ticket.id } })
          await appendServerMessage(tx, action.conversationId, `Action confirmée : le ticket n°${ticket.id} « ${ticket.title} » a été créé.`)
          return { status: "OK", action: resolved, ticket }
        }

        // Changement de statut : mise à jour CONDITIONNELLE et atomique sur le statut attendu à la proposition. Un PATCH classique,
        // un autre agent ou une autre action qui aurait changé le statut entre-temps est détecté sans rien écraser.
        const { ticketId, fromStatus, toStatus } = proposal.payload
        const result = await tickets.updateStatus(user, ticketId, toStatus, { expectedStatus: fromStatus, db: tx })
        if (result.status !== "OK") {
          // Rien n'a été modifié : l'action est annulée (le résultat est renvoyé, la transaction se valide donc normalement).
          await cancel(
            result.status === "STALE"
              ? `Action annulée : le ticket n°${ticketId} a été modifié depuis la proposition, rien n'a été changé.`
              : result.status === "FORBIDDEN"
                ? `Action annulée : vos droits ne permettent plus de modifier le ticket n°${ticketId}.`
                : `Action annulée : le ticket n°${ticketId} est introuvable.`,
          )
          return { status: result.status === "NOT_FOUND" ? "TICKET_NOT_FOUND" : result.status }
        }
        await recordAudit(tx, {
          action: "ASSISTANT_TICKET_STATUS_CHANGED",
          actor,
          targetUserId: user.id,
          metadata: { pendingActionId: action.id, ticketId, statusBefore: fromStatus, statusAfter: toStatus },
        })
        await appendServerMessage(tx, action.conversationId, `Action confirmée : le statut du ticket n°${ticketId} « ${result.ticket.title} » est passé de ${fromStatus} à ${toStatus}.`)
        return { status: "OK", action: resolved, ticket: result.ticket }
      }),

    // Annuler une action en attente (toujours possible, même si les actions sont désactivées).
    cancel: async (user: AuthenticatedUser, id: string): Promise<CancelResult> =>
      prisma.$transaction(async (tx): Promise<CancelResult> => {
        await lockUserAiWrites(tx, user.id)
        const action = await tx.aiPendingAction.findFirst({ where: { id, userId: user.id } })
        if (!action) return { status: "NOT_FOUND" }
        if (action.status !== "PENDING") return { status: "ALREADY_RESOLVED" }
        await tx.aiPendingAction.update({ where: { id }, data: { status: "CANCELLED", resolvedAt: new Date(), payload: {}, summary: "" } })
        await appendServerMessage(tx, action.conversationId, "Action annulée par l'utilisateur : rien n'a été modifié.")
        return { status: "OK", action: { id, kind: action.kind, status: "CANCELLED" } }
      }),
  }
}
