import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "dotenv"

// Refuser toute base qui pourrait être celle du développement.
export function assertTestDatabase(url: string | undefined) {
  if (!url) throw new Error("DATABASE_TEST_URL manquante")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("DATABASE_TEST_URL invalide")
  }
  if (
    !["postgresql:", "postgres:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/support_ticket_test" ||
    parsed.username !== "support_ticket_test_runner"
  ) {
    throw new Error("Base de test refusée : utiliser support_ticket_test et son rôle dédié en local")
  }

  const devPath = resolve(".env")
  if (existsSync(devPath)) {
    const devUrl = parse(readFileSync(devPath)).DATABASE_URL
    if (devUrl && new URL(devUrl).href === parsed.href) {
      throw new Error("La base de test est identique à la base de développement")
    }
  }
  return url
}
