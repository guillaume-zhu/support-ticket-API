import type { Request, Response } from "express"
import { Prisma, type PrismaClient } from "../generated/prisma/client.js"

export function usersController(prisma: PrismaClient) {
  return {
    create: async (req: Request, res: Response) => {
      // Vérifier et normaliser les données envoyées par le Super Admin.
      const { email, role } = req.body ?? {}
      const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : ""
      if (
        !normalizedEmail ||
        normalizedEmail.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      ) {
        return res.status(400).json({ error: "email invalide" })
      }
      if (role !== "ADMIN" && role !== "AGENT" && role !== "USER") {
        return res.status(400).json({ error: "role invalide" })
      }

      // Créer un compte en attente, sans mot de passe ni invitation pour l'instant.
      try {
        const user = await prisma.user.create({
          data: { email: normalizedEmail, role, status: "INVITED" },
          select: { id: true, email: true, role: true, status: true },
        })
        return res.status(201).json(user)
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return res.status(409).json({ error: "email déjà utilisé" })
        }
        throw error
      }
    },
  }
}
