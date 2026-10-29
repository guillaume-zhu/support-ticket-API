import express from "express"

const app = express()
const PORT = 3000

// Ticket
type Ticket = {
  id: number
  title: string
  description: string
  status: "OPEN" | "IN_PROGRESS" | "CLOSED"
}

const tickets: Ticket[] = []

app.use(express.json())

// Réponse a une réponse GET
app.get("/tickets", (req, res) => {
  res.json(tickets)
})

// Réponse a une méthode GET avec id en params
app.get("/tickets/:id", (req, res) => {
  const id = Number(req.params.id)

  // Vérification type id
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "id invalide" })
  }

  const ticket = tickets.find((ticket) => ticket.id === id)

  if (!ticket) {
    return res.status(404).json({ error: "ticket introuvable" })
  }

  return res.json(ticket)
})

// Réponse a une methode POST
app.post("/tickets", (req, res) => {
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

  const ticket: Ticket = {
    id: tickets.length + 1,
    title: title.trim(),
    description: description.trim(),
    status: "OPEN",
  }

  tickets.push(ticket)
  return res.status(201).json(ticket)
})

app.patch("/tickets/:id/status", (req, res) => {
  const id = Number(req.params.id)

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "id invalide" })
  }

  const ticket = tickets.find((ticket) => ticket.id === id)

  if (!ticket) {
    return res.status(404).json({ error: "ticket introuvable" })
  }

  const status: unknown = req.body?.status

  if (
    status !== "OPEN" &&
    status !== "IN_PROGRESS" &&
    status !== "CLOSED"
  ) {
    return res.status(400).json({ error: "status invalide" })
  }

  ticket.status = status
  return res.json(ticket)
})

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
