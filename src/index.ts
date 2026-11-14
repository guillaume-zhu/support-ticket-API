import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client.js"
import { createApp } from "./app.js"
import { parseTrustProxy } from "./middlewares/rate-limit.js"

const PORT = 3000

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

// TRUST_PROXY : nombre de proxys de confiance devant l'application (0 par défaut).
const app = createApp(prisma, { trustProxy: parseTrustProxy(process.env.TRUST_PROXY) })

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
