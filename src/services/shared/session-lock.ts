import type { Prisma } from "../../generated/prisma/client.js"

// Espace de verrous PostgreSQL propre aux sessions (distinct de celui des conversations IA, 7301).
const SESSION_LOCK_NAMESPACE = 7302

// Mettre en file, utilisateur par utilisateur, toutes les transactions qui créent ou révoquent des sessions
// (refresh, réinitialisation du mot de passe, désactivation du compte).

export async function lockUserSessions(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int, ${userId}::int)`
}
