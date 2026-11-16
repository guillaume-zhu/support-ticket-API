import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../generated/prisma/client.js"
import { aiConversationsService } from "../services/ai/ai.conversations.service.js"
import { parseRetentionDays } from "../utils/validation.js"

// Tâche planifiée (cron), indépendante du serveur HTTP : supprime les conversations IA inactives depuis plus de
// AI_CONVERSATION_RETENTION_DAYS jours (90 par défaut). Leurs messages partent avec elles (cascade PostgreSQL).
// À lancer une fois par jour ; --dry-run compte sans rien supprimer. Elle n'affiche que des compteurs : jamais de contenu.
async function main() {
  const options = process.argv.slice(2)
  const dryRun = options.includes("--dry-run")
  if (options.some((option) => option !== "--dry-run")) {
    console.error("Usage : npm run ai:purge-conversations [-- --dry-run]")
    process.exitCode = 1
    return
  }

  let retentionDays: number
  try {
    retentionDays = parseRetentionDays(process.env.AI_CONVERSATION_RETENTION_DAYS)
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
    return
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquante.")
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    const { conversations, messages, cutoff } = await aiConversationsService(prisma).purgeInactive({ retentionDays, dryRun })
    console.log(
      `${dryRun ? "[simulation] " : ""}Conversations IA sans activité depuis plus de ${retentionDays} jours (dernière activité avant ${cutoff.toISOString()}) : ` +
        (dryRun
          ? `${conversations} conversation(s) et ${messages} message(s) seraient supprimés.`
          : `${conversations} conversation(s) supprimée(s), ${messages} message(s) supprimé(s) avec elles.`),
    )
  } catch {
    // Message générique : l'erreur d'origine peut contenir des informations de connexion.
    console.error("Nettoyage impossible. Vérifier la connexion PostgreSQL.")
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

void main()
