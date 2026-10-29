import express from "express"

const app = express()
const PORT = 3000

// Réponse a une réponse GET
app.get("/tickets", (req, res) => {
  res.json(tickets)
})

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})

// Ticket
type Ticket = {
  id: number
  title: string
  description: string
  status: "OPEN" | "IN_PROGRESS" | "CLOSED"
}

const tickets: Ticket[] = []
