import { Prisma, type PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { escapeLikePattern, type TicketListOptions } from "../../utils/validation.js"

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
    create: (data: { title: string; description: string }, user: AuthenticatedUser) =>
      prisma.ticket.create({ data: { ...data, createdById: user.id } }),
  }
}
