import "dotenv/config"
import express from "express"
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

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
