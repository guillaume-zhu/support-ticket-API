import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient, type Prisma } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import { authService, type AuthTokens } from "../../src/services/auth/auth.service.js"
import { passwordResetService } from "../../src/services/auth/password-reset.service.js"
import { generateActionToken, hashPassword } from "../../src/utils/credentials.js"
import { assertTestDatabase } from "../../scripts/test-database.js"

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// AUDIT DE SÉCURITÉ — hypothèse « session survivante » : une session créée par `refresh` PENDANT une
// réinitialisation de mot de passe échappe-t-elle à la révocation globale de `resetPassword` ?
//
// Ce test N'EST PAS un test de non-régression ordinaire : tant que l'hypothèse est confirmée, il ÉCHOUE (c'est la preuve).
// Il utilise les VRAIES fonctions authService.refresh et passwordResetService.resetPassword, sur support_ticket_test uniquement.
// Il collecte TOUTES les observations dans un journal AVANT la première assertion.
// Ne pas committer tant que la correction n'est pas faite (la CI exécute tous les tests).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Aucun email ne doit partir, même par erreur.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => false),
}))

const OLD_PASSWORD = "ancien-mot-de-passe-fictif"
const NEW_PASSWORD = "nouveau-mot-de-passe-fictif"
const EMAIL_PREFIX = "race-"
const EMAIL_SUFFIX = "@example.invalid"
const EXPECTED_DATABASE = "support_ticket_test"
const EXPECTED_ROLE = "support_ticket_test_runner"
const LOCK_WAIT_TIMEOUT_MS = 3000

// ── Journal de preuves ───────────────────────────────────────────────────────────────────────────────

const startedAt = new Date()
const logPath = `audit/evidence/session-race-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`

// Dernière barrière : aucun JWT, mot de passe ni code à usage unique ne doit jamais atteindre le fichier.
function scrub(text: string) {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[JWT MASQUÉ]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "[CODE MASQUÉ]")
    .split(OLD_PASSWORD).join("[MOT DE PASSE MASQUÉ]")
    .split(NEW_PASSWORD).join("[MOT DE PASSE MASQUÉ]")
}

const logLines: string[] = []
function log(section: string, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`
  logLines.push(scrub(`${new Date().toISOString()} [${section}] ${message}${suffix}`))
}
function flushLog() {
  mkdirSync("audit/evidence", { recursive: true })
  writeFileSync(logPath, `${logLines.join("\n")}\n`)
}

// ── Base de test : cible vérifiée AVANT toute écriture ───────────────────────────────────────────────

let prisma: PrismaClient
let app: ReturnType<typeof createApp>
let realAuth: ReturnType<typeof authService>
let resetService: ReturnType<typeof passwordResetService>
const createdUserIds: number[] = []

beforeAll(async () => {
  try {
    // 1. Variable explicite uniquement : jamais de lecture implicite de la configuration de développement.
    const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
    const parsed = new URL(url)
    // 2. Si DATABASE_URL existe, elle doit désigner exactement la même base (sinon un outil pourrait viser le développement).
    if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).href !== parsed.href) {
      throw new Error("DATABASE_URL diffère de DATABASE_TEST_URL : test refusé")
    }

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    await prisma.$connect()

    // 3. La connexion RÉELLE doit être la bonne base, avec le bon rôle, sur le port annoncé : lecture seule, avant toute écriture.
    const [identity] = await prisma.$queryRaw<
      { db: string; usr: string; port: number | null; version: string; isolation: string }[]
    >`SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port,
             current_setting('server_version') AS version, current_setting('transaction_isolation') AS isolation`
    const expectedPort = Number(parsed.port || 5432)
    log("base", "connexion vérifiée", {
      hôte: parsed.hostname,
      portDansLUrl: expectedPort,
      base: identity?.db,
      rôle: identity?.usr,
      portServeur: identity?.port,
      versionPostgreSQL: identity?.version,
      isolationParDéfaut: identity?.isolation,
    })
    if (identity?.db !== EXPECTED_DATABASE || identity?.usr !== EXPECTED_ROLE || Number(identity?.port) !== expectedPort) {
      throw new Error("La connexion ne cible pas support_ticket_test avec son rôle dédié : test refusé")
    }

    // 4. La base doit être migrée (le script de test habituel s'en charge ; ici on vérifie seulement).
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('User', 'Session', 'ActionToken', 'AuditLog')`
    if (tables.length !== 4) {
      throw new Error("Base de test non migrée (tables User, Session, ActionToken, AuditLog attendues) : test refusé")
    }

    app = createApp(prisma, { rateLimits: false })
    realAuth = authService(prisma)
    resetService = passwordResetService(prisma)

    let commit = "inconnu"
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    } catch {
      // le journal reste utile sans le commit
    }
    log("contexte", "début de l'audit « session survivante »", { commitDeBase: commit, nodeVersion: process.version, journal: logPath })
  } catch (error) {
    log("garde", "TEST REFUSÉ AVANT TOUTE ÉCRITURE", { raison: error instanceof Error ? error.message : String(error) })
    flushLog()
    throw error
  }
})

afterAll(async () => {
  if (!prisma) return
  try {
    // Nettoyage : uniquement nos comptes fictifs. Les lignes d'audit survivraient (SetNull) : on les supprime d'abord.
    const leftovers = await prisma.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_SUFFIX } },
      select: { id: true },
    })
    const ids = [...new Set([...createdUserIds, ...leftovers.map((user) => user.id)])]
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    const remaining = await prisma.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_SUFFIX } } })
    log("nettoyage", "comptes fictifs supprimés (sessions et codes en cascade)", { supprimés: ids.length, restants: remaining })
  } catch (error) {
    log("nettoyage", "ÉCHEC du nettoyage", { raison: error instanceof Error ? error.message : String(error) })
  } finally {
    flushLog()
    await prisma.$disconnect()
  }
})

// ── Orchestration : mettre `refresh` en pause juste avant son COMMIT, sans toucher au code de production ─

type Gate = { inserted: Promise<void>; markInserted: () => void; released: Promise<void>; release: () => void }

function createGate(): Gate {
  let markInserted!: () => void
  let release!: () => void
  const inserted = new Promise<void>((resolve) => (markInserted = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  return { inserted, markInserted, released, release }
}

// Client Prisma identique au vrai, sauf : dans une transaction, `session.create` attend le feu vert APRÈS avoir inséré sa ligne.
// La transaction de refresh reste donc ouverte avec « ancienne session révoquée + nouvelle session insérée, rien de validé ».
function withPausedRefresh(client: PrismaClient, gate: Gate): PrismaClient {
  const pauseSessionCreate = (tx: Prisma.TransactionClient) =>
    new Proxy(tx, {
      get(txTarget, txProp) {
        const value = Reflect.get(txTarget, txProp, txTarget)
        if (txProp !== "session") return value
        return new Proxy(value as object, {
          get(delegate, method) {
            const original = Reflect.get(delegate, method, delegate)
            if (typeof original !== "function") return original
            if (method !== "create") return original.bind(delegate)
            return async (...args: unknown[]) => {
              const result = await original.apply(delegate, args)
              gate.markInserted()
              await gate.released
              return result
            }
          },
        })
      },
    })

  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") {
        const run = Reflect.get(target, prop, target) as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
          run.call(target, (tx) => fn(pauseSessionCreate(tx)), options)
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`délai dépassé (${ms} ms) : ${what}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// Observer, depuis une troisième connexion, qu'une requête attend VRAIMENT un verrou (le chevauchement est constaté, pas supposé).
async function waitForLockWait() {
  const startedWaiting = Date.now()
  for (;;) {
    const waiting = await prisma.$queryRaw<{ state: string | null; wait_event: string | null; query: string | null }[]>`
      SELECT state, wait_event, left(query, 90) AS query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    const waitedMs = Date.now() - startedWaiting
    if (waiting.length > 0) return { observed: true, waitedMs, waiting }
    if (waitedMs > LOCK_WAIT_TIMEOUT_MS) return { observed: false, waitedMs, waiting }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// ── Observations ─────────────────────────────────────────────────────────────────────────────────────

type Check = { id: string; label: string; expected: unknown; observed: unknown }

// Exécuter une observation sans jamais interrompre la collecte : une erreur est consignée comme résultat.
async function observe<T>(step: string, action: () => Promise<T>): Promise<T | { erreur: string }> {
  try {
    return await action()
  } catch (error) {
    const result = { erreur: error instanceof Error ? error.message : String(error) }
    log(step, "ERREUR pendant l'observation", result)
    return result
  }
}

function labeler() {
  const labels = new Map<string, string>()
  return {
    set: (id: string, label: string) => labels.set(id, label),
    // Les nouveaux identifiants reçoivent S2, S3… dans l'ordre de création (l'expiration croît avec la création).
    describe: (rows: { id: string; expiresAt: Date; revokedAt: Date | null }[]) =>
      [...rows]
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .map((row) => {
          if (!labels.has(row.id)) labels.set(row.id, `S${labels.size + 1}`)
          return { session: labels.get(row.id)!, active: row.revokedAt === null, revokedAt: row.revokedAt?.toISOString() ?? null }
        }),
  }
}

function statusOf(result: unknown) {
  return typeof result === "number" ? result : "erreur"
}

async function runScenario(mode: "chevauchement" | "témoin"): Promise<Check[]> {
  const section = mode
  const email = `${EMAIL_PREFIX}${mode === "témoin" ? "temoin" : "chevauchement"}-${randomBytes(4).toString("hex")}${EMAIL_SUFFIX}`
  const checks: Check[] = []
  const gate = createGate()

  try {
    // Préparation : compte fictif, connexion réelle (S1), code de réinitialisation inséré directement.
    const user = await prisma.user.create({
      data: { email, role: "USER", status: "ACTIVE", passwordHash: await hashPassword(OLD_PASSWORD) },
    })
    createdUserIds.push(user.id)
    const t1 = await realAuth.login(email, OLD_PASSWORD)
    if (!t1) throw new Error("connexion initiale refusée")
    const s1 = await prisma.session.findFirstOrThrow({ where: { userId: user.id } })
    const sessions = labeler()
    sessions.set(s1.id, "S1")
    const { token, tokenHash } = generateActionToken()
    await prisma.actionToken.create({
      data: { tokenHash, userId: user.id, purpose: "PASSWORD_RESET", expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    })
    log(section, "préparation terminée : compte fictif, session S1 active, code de réinitialisation valide", { compte: email, userId: user.id })

    const snapshot = async (step: string, message: string) => {
      const rows = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true, expiresAt: true, revokedAt: true } })
      const described = sessions.describe(rows)
      log(step, message, described)
      return described
    }

    // Orchestration.
    let refreshOutcome: PromiseSettledResult<AuthTokens | null>
    let resetOutcome: PromiseSettledResult<boolean>
    let lockObserved: boolean | null = null

    if (mode === "chevauchement") {
      const refreshPromise = authService(withPausedRefresh(prisma, gate)).refresh(t1.refreshToken)
      refreshPromise.catch(() => undefined)
      try {
        await withTimeout(gate.inserted, 3000, "refresh n'a pas atteint la pause")
        log(section, "refresh en pause : S1 révoquée et S2 insérée dans sa transaction, rien n'est validé")

        let resetFinished = false
        const resetPromise = resetService.resetPassword(token, NEW_PASSWORD)
        resetPromise.then(() => (resetFinished = true), () => (resetFinished = true))

        const lock = await waitForLockWait()
        lockObserved = lock.observed
        log(section, lock.observed ? "CHEVAUCHEMENT CONSTATÉ : une requête attend un verrou" : "AUCUNE attente de verrou observée (chevauchement non établi)", {
          attenteMs: lock.waitedMs,
          requêtesEnAttente: lock.waiting,
          resetDéjàTerminéAvantLibération: resetFinished,
        })

        gate.release()
        ;[refreshOutcome, resetOutcome] = [(await Promise.allSettled([refreshPromise]))[0]!, (await Promise.allSettled([resetPromise]))[0]!]
      } finally {
        gate.release()
      }
    } else {
      // Témoin : aucune pause, refresh se termine entièrement AVANT le début de la réinitialisation.
      refreshOutcome = (await Promise.allSettled([authService(prisma).refresh(t1.refreshToken)]))[0]!
      log(section, "refresh terminé (S1 révoquée, S2 validée) avant de lancer la réinitialisation")
      resetOutcome = (await Promise.allSettled([resetService.resetPassword(token, NEW_PASSWORD)]))[0]!
    }

    const t2 = refreshOutcome.status === "fulfilled" ? refreshOutcome.value : null
    log(section, "résultats des deux opérations", {
      refresh: refreshOutcome.status === "fulfilled" ? (t2 ? "tokens émis" : "refusé (null)") : `erreur : ${String(refreshOutcome.reason)}`,
      resetPassword: resetOutcome.status === "fulfilled" ? resetOutcome.value : `erreur : ${String(resetOutcome.reason)}`,
    })

    // 1) État de S2 AVANT toute action qui pourrait la modifier (les appels HTTP viennent après).
    const stateA = (await observe(section, () => snapshot(section, "ÉTAT DES SESSIONS juste après refresh + réinitialisation (avant tout appel HTTP)"))) as
      | { session: string; active: boolean; revokedAt: string | null }[]
      | { erreur: string }
    const sessionA = (label: string) => (Array.isArray(stateA) ? stateA.find((row) => row.session === label) : undefined)

    const audit = await observe(section, async () => {
      const rows = await prisma.auditLog.findMany({ where: { targetUserId: user.id }, select: { action: true, metadata: true } })
      log(section, "REGISTRE D'AUDIT de ce compte", rows)
      return rows
    })
    const resetAudit = Array.isArray(audit) ? audit.find((row) => row.action === "PASSWORD_RESET_COMPLETED") : undefined
    const revokedSessions = (resetAudit?.metadata as { revokedSessions?: number } | null | undefined)?.revokedSessions ?? null

    // 2) Accès HTTP réel, par le middleware authenticate : access token de S1, puis de S2.
    const t1Status = await observe(section, async () => (await request(app).get("/tickets").set("Authorization", `Bearer ${t1.accessToken}`)).status)
    log(section, "GET /tickets avec l'access token de S1", { statut: statusOf(t1Status) })
    const t2Status = t2
      ? await observe(section, async () => (await request(app).get("/tickets").set("Authorization", `Bearer ${t2.accessToken}`)).status)
      : "aucun token S2"
    log(section, "GET /tickets avec l'access token de S2", { statut: statusOf(t2Status) })

    await observe(section, () => snapshot(section, "ÉTAT DES SESSIONS après les lectures HTTP (doit être identique : une lecture ne modifie rien)"))

    // 3) Renouvellement avec le refresh token de S2 : EN DERNIER, car il révoque S2 et en crée une nouvelle.
    const refreshS2Status = t2
      ? await observe(section, async () => (await request(app).post("/auth/refresh").send({ refreshToken: t2.refreshToken })).status)
      : "aucun token S2"
    log(section, "POST /auth/refresh avec le refresh token de S2", { statut: statusOf(refreshS2Status) })
    await observe(section, () => snapshot(section, "ÉTAT DES SESSIONS après le renouvellement de S2"))

    // 4) Contrôle : la réinitialisation a bien changé le mot de passe.
    const oldLogin = await observe(section, async () => (await request(app).post("/auth/login").send({ email, password: OLD_PASSWORD })).status)
    const newLogin = await observe(section, async () => (await request(app).post("/auth/login").send({ email, password: NEW_PASSWORD })).status)
    log(section, "connexion avec l'ancien puis le nouveau mot de passe", { ancien: statusOf(oldLogin), nouveau: statusOf(newLogin) })

    // Résultats sous forme de vérifications : « attendu » = comportement SÛR.
    if (mode === "chevauchement") {
      checks.push({ id: "C0", label: "le chevauchement est observé (une requête attend un verrou)", expected: true, observed: lockObserved })
    }
    checks.push(
      { id: "C1", label: "refresh a émis une nouvelle paire de tokens (S2)", expected: true, observed: t2 !== null },
      { id: "C2", label: "resetPassword a réussi", expected: true, observed: resetOutcome.status === "fulfilled" && resetOutcome.value === true },
      { id: "C3", label: "S1 est révoquée en base", expected: true, observed: sessionA("S1") ? !sessionA("S1")!.active : null },
      { id: "C4", label: "S2 est révoquée en base après la réinitialisation", expected: true, observed: sessionA("S2") ? !sessionA("S2")!.active : null },
      { id: "C5", label: "l'audit déclare 1 session révoquée par la réinitialisation (S2)", expected: 1, observed: revokedSessions },
      { id: "C6", label: "l'access token de S1 est refusé sur GET /tickets", expected: 401, observed: statusOf(t1Status) },
      { id: "C7", label: "l'access token de S2 est refusé sur GET /tickets", expected: 401, observed: statusOf(t2Status) },
      { id: "C8", label: "le refresh token de S2 est refusé sur POST /auth/refresh", expected: 401, observed: statusOf(refreshS2Status) },
      { id: "C9", label: "l'ancien mot de passe est refusé", expected: 401, observed: statusOf(oldLogin) },
      { id: "C10", label: "le nouveau mot de passe est accepté", expected: 200, observed: statusOf(newLogin) },
    )
  } catch (error) {
    log(section, "ERREUR D'ORCHESTRATION (résultat inexploitable)", { raison: error instanceof Error ? error.message : String(error) })
    checks.push({ id: "ORCHESTRATION", label: "le scénario s'est déroulé jusqu'au bout", expected: "ok", observed: error instanceof Error ? error.message : String(error) })
  } finally {
    gate.release()
  }

  // Bilan du scénario, écrit AVANT toute assertion.
  for (const check of checks) {
    log(section, `${isDeepStrictEqual(check.observed, check.expected) ? "OK    " : "ÉCART "} ${check.id} — ${check.label}`, {
      attendu: check.expected,
      observé: check.observed,
    })
  }
  return checks
}

function conclude(mode: string, checks: Check[]) {
  const failed = (id: string) => checks.some((check) => check.id === id && !isDeepStrictEqual(check.observed, check.expected))
  if (mode === "chevauchement") {
    log(
      "conclusion",
      `MÉCANISME dans l'application : ${failed("C4") ? "CONFIRMÉ (S2 reste active en base)" : "NON confirmé (S2 est révoquée)"} ; ` +
        `EXPLOITABILITÉ API : ${failed("C7") || failed("C8") ? "CONFIRMÉE (accès protégé ou renouvellement possible après la réinitialisation)" : "NON confirmée"}.`,
    )
  } else {
    log("conclusion", failed("C4") || failed("C7") ? "TÉMOIN EN ÉCHEC : le test lui-même est suspect, ne pas conclure." : "TÉMOIN VALIDE : sans chevauchement, tout est révoqué.")
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────

describe("Révocation concurrente : refresh pendant resetPassword", () => {
  it("TÉMOIN — sans chevauchement, S2 est révoquée et son token refusé", async () => {
    const checks = await runScenario("témoin")
    conclude("témoin", checks)
    flushLog()
    for (const check of checks) expect.soft(check.observed, `${check.id} — ${check.label}`).toEqual(check.expected)
  }, 30_000)

  it("CHEVAUCHEMENT — après la réinitialisation, aucune session ne doit rester utilisable", async () => {
    const checks = await runScenario("chevauchement")
    conclude("chevauchement", checks)
    flushLog()
    for (const check of checks) expect.soft(check.observed, `${check.id} — ${check.label}`).toEqual(check.expected)
  }, 30_000)
})
