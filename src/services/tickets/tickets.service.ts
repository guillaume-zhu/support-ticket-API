import { Prisma, type PrismaClient, type Role, type TicketStatus } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { escapeLikePattern, type TicketListOptions } from "../../utils/validation.js"

// Rôles du personnel : ils voient tous les tickets et peuvent changer leur statut. Source UNIQUE de cette règle :
// la route (requireRoles) et le service (canChangeStatus) la lisent ici, l'assistant IA aussi.
export const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "AGENT"] as const satisfies readonly Role[]

export function canChangeStatus(user: AuthenticatedUser) {
  return (STAFF_ROLES as readonly Role[]).includes(user.role)
}

// Client Prisma ordinaire ou client d'une transaction en cours : permet d'écrire le ticket, l'audit et l'action
// de l'assistant ensemble, en une seule transaction.
export type DbClient = PrismaClient | Prisma.TransactionClient

// Un USER ne voit que ses tickets ; le personnel voit tout, y compris les tickets sans auteur.
function visibleTo(user: AuthenticatedUser) {
  return user.role === "USER" ? { createdById: user.id } : {}
}

export function ticketsService(prisma: PrismaClient) {
  return {
    // Une page de tickets visibles, avec les filtres et le tri demandés, et le total correspondant.
    listVisible: async (user: AuthenticatedUser, options: TicketListOptions) => {
      // La règle de propriété est appliquée en dernier : elle l'emporte sur tout filtre createdById.
      const where: Prisma.TicketWhereInput = {
        ...(options.status && { status: options.status }),
        ...(options.createdById !== undefined && { createdById: options.createdById }),
        ...(options.q && { title: { contains: escapeLikePattern(options.q), mode: "insensitive" } }),
        ...visibleTo(user),
      }

      // Tri choisi, puis id comme critère secondaire pour un ordre stable entre les pages.
      const orderBy: Prisma.TicketOrderByWithRelationInput[] =
        options.sortBy === "id"
          ? [{ id: options.order }]
          : [{ [options.sortBy]: options.order }, { id: options.order }]

      // Transaction interactive en RepeatableRead : data et total sont lus au même instant,
      // même si un ticket est créé entre-temps. La forme tableau ignorerait ce niveau d'isolation.
      const [data, total] = await prisma.$transaction(
        async (tx) => {
          const data = await tx.ticket.findMany({
            where,
            orderBy,
            skip: (options.page - 1) * options.limit,
            take: options.limit,
          })
          const total = await tx.ticket.count({ where })
          return [data, total] as const
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      )

      return {
        data,
        meta: {
          page: options.page,
          limit: options.limit,
          total,
          totalPages: Math.ceil(total / options.limit),
        },
      }
    },

    // Renvoie null si le ticket n'existe pas OU n'est pas visible : le controller répond 404 dans les deux cas.
    findVisibleById: (id: number, user: AuthenticatedUser) =>
      prisma.ticket.findFirst({ where: { id, ...visibleTo(user) } }),

    // L'auteur vient toujours de l'identité authentifiée, jamais du body.
    create: (data: { title: string; description: string }, user: AuthenticatedUser, db: DbClient = prisma) =>
      db.ticket.create({ data: { ...data, createdById: user.id } }),

    // Changer le statut d'un ticket : réservé au personnel, la règle est vérifiée ICI et non seulement dans la route.
    // Avec `expectedStatus`, la mise à jour est CONDITIONNELLE et atomique (UPDATE ... WHERE status = <attendu>) :
    // si quelqu'un a changé le statut entre-temps (PATCH classique, autre agent, autre action), rien n'est écrasé
    // et le résultat est STALE. Sans lecture préalable : PostgreSQL revérifie la condition sur la ligne verrouillée.
    updateStatus: async (
      user: AuthenticatedUser,
      id: number,
      status: TicketStatus,
      options: { expectedStatus?: TicketStatus; db?: DbClient } = {},
    ): Promise<
      { status: "OK"; ticket: NonNullable<Awaited<ReturnType<DbClient["ticket"]["findUnique"]>>> } | { status: "FORBIDDEN" | "NOT_FOUND" | "STALE" }
    > => {
      if (!canChangeStatus(user)) return { status: "FORBIDDEN" }
      const db = options.db ?? prisma

      if (options.expectedStatus === undefined) {
        // Changement sans condition (PATCH classique) : le dernier écrit gagne, comme avant.
        try {
          return { status: "OK", ticket: await db.ticket.update({ where: { id }, data: { status } }) }
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return { status: "NOT_FOUND" }
          throw error
        }
      }

      const updated = await db.ticket.updateMany({ where: { id, status: options.expectedStatus }, data: { status } })
      if (updated.count === 1) {
        // La ligne est verrouillée par notre mise à jour jusqu'à la fin de la transaction : on relit bien notre écriture.
        return { status: "OK", ticket: await db.ticket.findUniqueOrThrow({ where: { id } }) }
      }
      // Aucune ligne modifiée : le ticket n'existe pas, ou son statut n'est plus celui qui était attendu.
      return (await db.ticket.findUnique({ where: { id }, select: { id: true } })) ? { status: "STALE" } : { status: "NOT_FOUND" }
    },
  }
}
