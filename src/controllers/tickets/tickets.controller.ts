import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { parseId } from "../../utils/validation.js"

export function ticketsController(prisma: PrismaClient) {
  return {
    // Réponse a une réponse GET
    list: async (req: Request, res: Response) => {
      const tickets = await prisma.ticket.findMany({ orderBy: { id: "asc" } })
      res.json(tickets)
    },

    // Réponse a une méthode GET avec id en params
    getById: async (req: Request, res: Response) => {
      // Vérification type id
      const id = parseId(req.params.id)
      if (id === null) {
        return res.status(400).json({ error: "id invalide" })
      }

      const ticket = await prisma.ticket.findUnique({ where: { id } })

      if (!ticket) {
        return res.status(404).json({ error: "ticket introuvable" })
      }

      return res.json(ticket)
    },

    // Réponse a une methode POST
    create: async (req: Request, res: Response) => {
      const { title, description } = req.body ?? {}

      // Vérification de title et description
      if (
        typeof title !== "string" ||
        title.trim() === "" ||
        typeof description !== "string" ||
        description.trim() === ""
      ) {
        return res.status(400).json({ error: "title et description sont requis" })
      }

      const ticket = await prisma.ticket.create({
        data: {
          title: title.trim(),
          description: description.trim(),
        },
      })

      return res.status(201).json(ticket)
    },

    // Réponse à méthode Patch
    updateStatus: async (req: Request, res: Response) => {
      // Verification nombre entier
      const id = parseId(req.params.id)
      if (id === null) {
        return res.status(400).json({ error: "id invalide" })
      }

      const ticket = await prisma.ticket.findUnique({ where: { id } })

      if (!ticket) {
        return res.status(404).json({ error: "ticket introuvable" })
      }

      const status: unknown = req.body?.status

      if (status !== "OPEN" && status !== "IN_PROGRESS" && status !== "CLOSED") {
        return res.status(400).json({ error: "status invalide" })
      }

      const updated = await prisma.ticket.update({
        where: { id },
        data: { status },
      })
      return res.json(updated)
    },
  }
}
