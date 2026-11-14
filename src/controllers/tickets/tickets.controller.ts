import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { ticketsService } from "../../services/tickets/tickets.service.js"
import { parseBody, parseId, parseText, parseTicketListQuery } from "../../utils/validation.js"

export function ticketsController(prisma: PrismaClient) {
  const service = ticketsService(prisma)

  return {
    // Réponse a une réponse GET
    list: async (req: Request, res: Response) => {
      const user = res.locals.authUser as AuthenticatedUser

      // Valider pagination, filtres et tri avant toute requête en base.
      const parsed = parseTicketListQuery(req.query)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }
      // Filtrer par auteur est réservé au personnel.
      if (user.role === "USER" && parsed.value.createdById !== undefined) {
        return res.status(403).json({ error: "Accès interdit" })
      }

      return res.json(await service.listVisible(user, parsed.value))
    },

    // Réponse a une méthode GET avec id en params
    getById: async (req: Request, res: Response) => {
      // Vérification type id
      const id = parseId(req.params.id)
      if (id === null) {
        return res.status(400).json({ error: "id invalide" })
      }

      // 404 aussi pour un ticket d'autrui : on ne révèle pas son existence.
      const user = res.locals.authUser as AuthenticatedUser
      const ticket = await service.findVisibleById(id, user)

      if (!ticket) {
        return res.status(404).json({ error: "ticket introuvable" })
      }

      return res.json(ticket)
    },

    // Réponse a une methode POST
    create: async (req: Request, res: Response) => {
      // Seuls title et description sont acceptés : l'auteur vient de l'identité authentifiée.
      const body = parseBody(req.body, ["title", "description"])
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }

      // Texte non vide, sans caractères de contrôle ; titre sur une ligne.
      const title = parseText(body.value.title, 200)
      const description = parseText(body.value.description, 5000, true)
      if (title === null || description === null) {
        return res.status(400).json({
          error: "title (200 caractères max) et description (5000 max) sont requis, sans caractères de contrôle",
        })
      }

      const user = res.locals.authUser as AuthenticatedUser
      const ticket = await service.create({ title, description }, user)

      return res.status(201).json(ticket)
    },

    // Réponse à méthode Patch
    updateStatus: async (req: Request, res: Response) => {
      // Verification nombre entier
      const id = parseId(req.params.id)
      if (id === null) {
        return res.status(400).json({ error: "id invalide" })
      }

      const body = parseBody(req.body, ["status"])
      if (!body.ok) {
        return res.status(400).json({ error: body.error })
      }
      const status = body.value.status
      if (status !== "OPEN" && status !== "IN_PROGRESS" && status !== "CLOSED") {
        return res.status(400).json({ error: "status invalide" })
      }

      const ticket = await prisma.ticket.findUnique({ where: { id } })

      if (!ticket) {
        return res.status(404).json({ error: "ticket introuvable" })
      }

      const updated = await prisma.ticket.update({
        where: { id },
        data: { status },
      })
      return res.json(updated)
    },
  }
}
