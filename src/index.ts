import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client.js"
import { createApp } from "./app.js"
import { parseTrustProxy } from "./middlewares/rate-limit.js"
import { parseAiConfig } from "./services/ai/ai.service.js"
import { isApiDocsEnabled } from "./routes/docs/index.js"

const PORT = 3000

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

// TRUST_PROXY : nombre de proxys de confiance devant l'application (0 par défaut).
// Assistant IA : une configuration incomplète ou invalide arrête le démarrage (message sans valeur secrète) ;
// sans variables AI_*, l'assistant est simplement désactivé et POST /ai/chat répond 503.
const ai = parseAiConfig(process.env)
console.log(ai ? `Assistant IA activé (${ai.provider})` : "Assistant IA désactivé (AI_PROVIDER, AI_API_KEY et AI_MODEL non renseignés)")

// API_DOCS : exposer la documentation (/docs, /openapi.json) ; par défaut, partout sauf en production.
const app = createApp(prisma, {
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  apiDocs: isApiDocsEnabled(process.env.API_DOCS, process.env.NODE_ENV),
})

// Démarrage du serveur sur le port 3000
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`)
})
