import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"

// Un USER ne voit que ses tickets ; le personnel voit tout, y compris les tickets sans auteur.
function visibleTo(user: AuthenticatedUser) {
  return user.role === "USER" ? { createdById: user.id } : {}
}

export function ticketsService(prisma: PrismaClient) {
  return {
    listVisible: (user: AuthenticatedUser) =>
      prisma.ticket.findMany({ where: visibleTo(user), orderBy: { id: "asc" } }),

    // Renvoie null si le ticket n'existe pas OU n'est pas visible : le controller répond 404 dans les deux cas.
    findVisibleById: (id: number, user: AuthenticatedUser) =>
      prisma.ticket.findFirst({ where: { id, ...visibleTo(user) } }),

    // L'auteur vient toujours de l'identité authentifiée, jamais du body.
    create: (data: { title: string; description: string }, user: AuthenticatedUser) =>
      prisma.ticket.create({ data: { ...data, createdById: user.id } }),
  }
}
