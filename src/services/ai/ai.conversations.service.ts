import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import {
  AI_ACTION_CLEANUP_GRACE_DAYS,
  AI_ACTION_TTL_MINUTES,
  AI_MAX_PENDING_PER_USER,
  CONVERSATION_CONTEXT_MAX_CHARS,
  CONVERSATION_CONTEXT_MAX_MESSAGES,
  CONVERSATION_MAX_MESSAGES,
  CONVERSATION_MAX_PER_USER,
  CONVERSATION_TITLE_MAX_CHARS,
  type ChatMessage,
} from "../../utils/validation.js"
import { aiActionsEnabled, aiService, type AiChatResult } from "./ai.service.js"
import type { Proposal, TicketToolName } from "./ai.tools.js"

// Conversations avec l'assistant, enregistrées dans PostgreSQL.
// Le client n'envoie que son nouveau message : l'historique, les rôles et la fenêtre de contexte viennent de la base.
// Seuls le texte de l'utilisateur et la réponse FINALE de l'assistant sont stockés : jamais les appels de fonctions,
// leurs résultats ni le raisonnement du modèle. Le contenu des messages n'est jamais journalisé : ce fichier n'écrit aucun log.

const MS_PER_DAY = 24 * 60 * 60 * 1000
// Espace de verrous PostgreSQL propre aux conversations IA (une clé arbitraire, distincte de celle de la réinitialisation).
const LOCK_NAMESPACE = 7301

// Phrase fixe, écrite par le serveur et ajoutée à toute réponse qui contient une action proposée : le client (et le lecteur de
// l'historique) voit la vérité même si le texte du modèle affirmait à tort qu'une action est faite.
export const PENDING_ACTION_NOTICE = "Action en attente de votre confirmation : rien n'est modifié tant que vous n'avez pas confirmé dans l'application."

// Verrou court, propre à un utilisateur : met en file ses écritures sur les conversations ET sur ses actions en attente.
export async function lockUserAiWrites(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${userId}::int)`
}

// Actions en attente qui comptent dans le quota : en attente ET non périmées. Une action périmée depuis plus de dix minutes ne
// compte plus, même si le nettoyage quotidien ne l'a pas encore supprimée.
export function activePendingWhere(userId: number, now: Date) {
  return { userId, status: "PENDING" as const, expiresAt: { gt: now } }
}

// Ajouter un message écrit par le SERVEUR dans une conversation (résultat d'une confirmation ou d'une annulation) : le modèle
// connaîtra ainsi le vrai résultat au tour suivant. Sans effet si la conversation n'existe plus ou n'a plus de place.
export async function appendServerMessage(tx: Prisma.TransactionClient, conversationId: string, text: string) {
  const conversation = await tx.aiConversation.findUnique({ where: { id: conversationId }, select: { _count: { select: { messages: true } } } })
  if (!conversation || conversation._count.messages + 1 > CONVERSATION_MAX_MESSAGES) return false
  await tx.aiMessage.create({ data: { conversationId, role: "ASSISTANT", content: text } })
  await tx.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
  return true
}

export type PendingActionView = { id: string; kind: Proposal["kind"]; summary: string; expiresAt: Date }

// Titre d'une conversation : le début de son premier message, sur une ligne.
export function deriveTitle(message: string) {
  const characters = [...message.replace(/\s+/g, " ").trim()]
  return characters.length > CONVERSATION_TITLE_MAX_CHARS
    ? `${characters.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1).join("")}…`
    : characters.join("")
}

// Construire ce qui est envoyé au fournisseur : les derniers messages de l'historique et le nouveau, dans une
// fenêtre bornée (20 messages et 12 000 caractères). Le nouveau message est toujours conservé, et la fenêtre commence
// par un message de l'utilisateur. Les messages plus anciens restent en base mais ne sont plus envoyés.
export function buildContextWindow(history: ChatMessage[], newMessage: ChatMessage): ChatMessage[] {
  const all = [...history, newMessage]
  let characters = 0
  let start = all.length
  for (let index = all.length - 1; index >= 0; index--) {
    const size = [...all[index]!.content].length
    const isNewMessage = index === all.length - 1
    if (!isNewMessage && (all.length - index > CONVERSATION_CONTEXT_MAX_MESSAGES || characters + size > CONVERSATION_CONTEXT_MAX_CHARS)) break
    characters += size
    start = index
  }
  let window = all.slice(start)
  while (window.length > 1 && window[0]!.role !== "user") window = window.slice(1)
  return window
}

export type ConverseResult =
  | { status: "OK"; conversationId: string; reply: string; toolsUsed: TicketToolName[]; pendingActions: PendingActionView[] }
  | Exclude<AiChatResult, { status: "OK" }>
  | { status: "CONVERSATION_NOT_FOUND" | "CONVERSATION_FULL" | "TOO_MANY_CONVERSATIONS" | "TOO_MANY_PENDING_ACTIONS" }

type SaveResult = Extract<
  ConverseResult,
  { status: "OK" | "CONVERSATION_NOT_FOUND" | "CONVERSATION_FULL" | "TOO_MANY_CONVERSATIONS" | "TOO_MANY_PENDING_ACTIONS" }
>

export function aiConversationsService(prisma: PrismaClient) {
  const ai = aiService(prisma)

  // Enregistrer l'échange en UNE transaction, avec les actions proposées. Un verrou court, propre à l'utilisateur, met en file ses
  // écritures : les quotas (conversations, messages, actions en attente) sont revérifiés sous ce verrou, donc respectés même si
  // plusieurs requêtes arrivent en même temps. Le verrou ne couvre jamais l'appel au fournisseur.
  async function save(
    user: AuthenticatedUser,
    conversationId: string | undefined,
    message: string,
    receivedAt: Date,
    reply: string,
    toolsUsed: TicketToolName[],
    proposals: Proposal[],
  ): Promise<SaveResult> {
    try {
      return await prisma.$transaction(async (tx): Promise<SaveResult> => {
        await lockUserAiWrites(tx, user.id)

        let id = conversationId
        if (id) {
          const existing = await tx.aiConversation.findFirst({
            where: { id, userId: user.id },
            select: { _count: { select: { messages: true } } },
          })
          if (!existing) return { status: "CONVERSATION_NOT_FOUND" }
          if (existing._count.messages + 2 > CONVERSATION_MAX_MESSAGES) return { status: "CONVERSATION_FULL" }
        } else {
          if ((await tx.aiConversation.count({ where: { userId: user.id } })) >= CONVERSATION_MAX_PER_USER) {
            return { status: "TOO_MANY_CONVERSATIONS" }
          }
        }

        // Quota d'actions en attente, revérifié sous le verrou : seules comptent les actions NON périmées.
        const now = new Date()
        if (proposals.length > 0) {
          const pending = await tx.aiPendingAction.count({ where: activePendingWhere(user.id, now) })
          if (pending + proposals.length > AI_MAX_PENDING_PER_USER) return { status: "TOO_MANY_PENDING_ACTIONS" }
        }

        if (!id) {
          id = (await tx.aiConversation.create({ data: { userId: user.id, title: deriveTitle(message) }, select: { id: true } })).id
        }

        // Le message de l'utilisateur porte l'heure de réception, pas celle de la fin de l'appel au fournisseur.
        // Une réponse qui contient des actions proposées reçoit la phrase fixe du serveur (elle est stockée avec la réponse).
        const storedReply = proposals.length > 0 ? `${reply}\n\n${PENDING_ACTION_NOTICE}` : reply
        await tx.aiMessage.create({ data: { conversationId: id, role: "USER", content: message, createdAt: receivedAt } })
        await tx.aiMessage.create({ data: { conversationId: id, role: "ASSISTANT", content: storedReply, toolsUsed } })
        // Dernière activité : c'est elle que la purge des conversations inactives compare à la durée de conservation.
        await tx.aiConversation.update({ where: { id }, data: { updatedAt: new Date() } })

        // Les actions proposées sont enregistrées « en attente » AVEC l'échange : si quoi que ce soit échoue, aucune n'existe.
        const expiresAt = new Date(now.getTime() + AI_ACTION_TTL_MINUTES * 60_000)
        const pendingActions: PendingActionView[] = []
        for (const proposal of proposals) {
          const created = await tx.aiPendingAction.create({
            data: { userId: user.id, conversationId: id, kind: proposal.kind, payload: proposal.payload, summary: proposal.summary, expiresAt },
            select: { id: true, kind: true, summary: true, expiresAt: true },
          })
          pendingActions.push(created)
        }
        return { status: "OK", conversationId: id, reply: storedReply, toolsUsed, pendingActions }
      })
    } catch (error) {
      // Conversation supprimée par son propriétaire pendant l'appel au fournisseur.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2003" || error.code === "P2025")) {
        return { status: "CONVERSATION_NOT_FOUND" }
      }
      throw error
    }
  }

  // Page de résultats avec son total, lus au même instant.
  async function paginate<T>(page: number, limit: number, read: (tx: Prisma.TransactionClient, skip: number) => Promise<[T[], number] | null>) {
    return prisma.$transaction(async (tx) => read(tx, (page - 1) * limit), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })
  }

  return {
    // Poursuivre une conversation ou en démarrer une, puis enregistrer l'échange si (et seulement si) la réponse a réussi.
    converse: async (user: AuthenticatedUser, input: { message: string; conversationId: string | undefined }): Promise<ConverseResult> => {
      const receivedAt = new Date()
      let history: ChatMessage[] = []

      // Vérifications rapides AVANT d'appeler le fournisseur (qui est payant) ; save() les refait sous verrou.
      if (input.conversationId) {
        // Le filtre sur userId est la barrière d'isolation : la conversation d'un autre est indiscernable d'une absente.
        const conversation = await prisma.aiConversation.findFirst({
          where: { id: input.conversationId, userId: user.id },
          select: { _count: { select: { messages: true } } },
        })
        if (!conversation) return { status: "CONVERSATION_NOT_FOUND" }
        if (conversation._count.messages + 2 > CONVERSATION_MAX_MESSAGES) return { status: "CONVERSATION_FULL" }

        const recent = await prisma.aiMessage.findMany({
          where: { conversationId: input.conversationId },
          orderBy: { id: "desc" },
          take: CONVERSATION_CONTEXT_MAX_MESSAGES - 1,
          select: { role: true, content: true },
        })
        history = recent.reverse().map((message) => ({ role: message.role === "USER" ? "user" : "assistant", content: message.content }))
      } else if ((await prisma.aiConversation.count({ where: { userId: user.id } })) >= CONVERSATION_MAX_PER_USER) {
        return { status: "TOO_MANY_CONVERSATIONS" }
      }

      // Place restante pour de nouvelles actions en attente (contrôle rapide ; save() le refait sous verrou).
      // Les actions périmées ne comptent pas. Sans actions activées, aucune proposition n'est possible.
      let proposalBudget = 0
      if (aiActionsEnabled()) {
        const pending = await prisma.aiPendingAction.count({ where: activePendingWhere(user.id, receivedAt) })
        proposalBudget = Math.max(0, AI_MAX_PENDING_PER_USER - pending)
      }

      const window = buildContextWindow(history, { role: "user", content: input.message })
      const result = await ai.chat(window, user, { proposalBudget })
      if (result.status !== "OK") return result // rien n'est enregistré en cas d'échec

      return save(user, input.conversationId, input.message, receivedAt, result.reply, result.toolsUsed, result.proposals)
    },

    // Mes conversations, de la plus récemment active à la plus ancienne.
    list: async (user: AuthenticatedUser, page: number, limit: number) => {
      const [data, total] = (await paginate(page, limit, async (tx, skip) => {
        const where = { userId: user.id }
        const rows = await tx.aiConversation.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          skip,
          take: limit,
          select: { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
        })
        return [rows.map(({ _count, ...conversation }) => ({ ...conversation, messageCount: _count.messages })), await tx.aiConversation.count({ where })]
      }))!
      return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } }
    },

    // L'historique d'une de MES conversations (du plus ancien au plus récent) ; null si elle n'existe pas ou n'est pas à moi.
    messages: async (user: AuthenticatedUser, conversationId: string, page: number, limit: number) => {
      const result = await paginate(page, limit, async (tx, skip) => {
        const conversation = await tx.aiConversation.findFirst({ where: { id: conversationId, userId: user.id }, select: { id: true } })
        if (!conversation) return null
        const rows = await tx.aiMessage.findMany({
          where: { conversationId },
          orderBy: { id: "asc" },
          skip,
          take: limit,
          select: { id: true, role: true, content: true, toolsUsed: true, createdAt: true },
        })
        return [rows.map((row) => ({ ...row, role: row.role === "USER" ? ("user" as const) : ("assistant" as const) })), await tx.aiMessage.count({ where: { conversationId } })]
      })
      if (!result) return null
      const [data, total] = result
      return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } }
    },

    // Supprimer immédiatement UNE de mes conversations (ses messages partent avec, par cascade) ; false si elle n'est pas à moi.
    remove: async (user: AuthenticatedUser, conversationId: string) => {
      const { count } = await prisma.aiConversation.deleteMany({ where: { id: conversationId, userId: user.id } })
      return count === 1
    },

    // Nettoyage des conversations inactives (appelé par la tâche planifiée, jamais pendant une requête) : supprime celles
    // dont la dernière activité remonte à PLUS de `retentionDays` jours. Leurs messages sont supprimés par la cascade.
    // Avec dryRun, compte sans rien supprimer.
    purgeInactive: async (options: { retentionDays: number; now?: Date; dryRun?: boolean }) => {
      const cutoff = new Date((options.now ?? new Date()).getTime() - options.retentionDays * MS_PER_DAY)
      const where = { updatedAt: { lt: cutoff } }
      const messages = await prisma.aiMessage.count({ where: { conversation: where } })
      const conversations = options.dryRun ? await prisma.aiConversation.count({ where }) : (await prisma.aiConversation.deleteMany({ where })).count

      // Actions proposées périmées depuis plus d'un jour (confirmées, annulées ou jamais traitées) : plus aucune utilité.
      // Celles des conversations supprimées ci-dessus sont déjà parties par cascade.
      const actionsWhere = { expiresAt: { lt: new Date((options.now ?? new Date()).getTime() - AI_ACTION_CLEANUP_GRACE_DAYS * MS_PER_DAY) } }
      const pendingActions = options.dryRun ? await prisma.aiPendingAction.count({ where: actionsWhere }) : (await prisma.aiPendingAction.deleteMany({ where: actionsWhere })).count
      return { conversations, messages, pendingActions, cutoff }
    },
  }
}
