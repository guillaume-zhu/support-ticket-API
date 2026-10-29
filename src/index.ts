import "dotenv/config"
import express from "express"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client.js"
import { authRouter } from "./auth.js"

const app = express()
const PORT = 3000

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

app.use(express.json())
app.use("/auth", authRouter(prisma))

// Réponse a une réponse GET
app.get("/tickets", async (req, res) => {
  const tickets = await prisma.ticket.findMany({ orderBy: { id: "asc" } })
  res.json(tickets)
})

// Réponse a une méthode GET avec id en params
app.get("/tickets/:id", async (req, res) => {
  const id = Number(req.params.id)

  // Vérification type id
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "id invalide" })
  }

  const ticket = await prisma.ticket.findUnique({ where: { id } })

  if (!ticket) {
    return res.status(404).json({ error: "ticket introuvable" })
  }

  return res.json(ticket)
})

// Réponse a une methode POST
app.post("/tickets", async (req, res) => {
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
})

// Réponse à méthode Patch
app.patch("/tickets/:id/status", async (req, res) => {
  const id = Number(req.params.id)

  // Verification nombre entier
  if (!Number.isSafeInteger(id) || id < 1) {
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
})

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
