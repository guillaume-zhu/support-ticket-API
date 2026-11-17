import type { Prisma } from "../../generated/prisma/client.js"

// Espace de verrous PostgreSQL propre aux sessions (distinct de celui des conversations IA, 7301).
const SESSION_LOCK_NAMESPACE = 7302

// Mettre en file, utilisateur par utilisateur, toutes les transactions qui créent ou révoquent des sessions
// (refresh, réinitialisation du mot de passe, désactivation du compte).
// Sans ce verrou, une révocation globale (« toutes les sessions non révoquées de cet utilisateur ») ne voit pas
// une session que refresh vient d'insérer dans une transaction pas encore validée : la nouvelle session survit.
// Le verrou est pris EN PREMIER dans la transaction et relâché à sa fin (COMMIT ou ROLLBACK) : les lectures et écritures
// qui suivent voient donc toujours l'état validé par la transaction précédente (READ COMMITTED).
export async function lockUserSessions(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int, ${userId}::int)`
}
