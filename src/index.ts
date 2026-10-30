import "dotenv/config"
import express, { type ErrorRequestHandler } from "express"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client.js"
import { registerRoutes } from "./routes/index.js"

const app = express()
const PORT = 3000

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

app.use(express.json())
registerRoutes(app, prisma)

// Gestion globale des erreurs : réponses génériques, détails uniquement dans les logs
const handleError: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  // Garder le statut des erreurs de requête (JSON malformé, corps trop gros)
  const status = error?.status ?? error?.statusCode
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: "requête invalide" })
  }

  // Erreur inattendue : journaliser sans corps ni en-têtes, répondre sans détail
  console.error(`Erreur interne sur ${req.method} ${req.path}`, error)
  return res.status(500).json({ error: "erreur interne" })
}
app.use(handleError)

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
