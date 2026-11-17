import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { PrismaPg } from "@prisma/adapter-pg"
import { AuditAction, PrismaClient, type Role, type UserStatus } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import { recordAudit } from "../../src/services/shared/audit.service.js"
import { sendEmail } from "../../src/services/shared/email.service.js"
import { hashActionToken, hashPassword } from "../../src/utils/credentials.js"
import { AUDIT_ACTIONS } from "../../src/utils/validation.js"
import { assertTestDatabase } from "../../scripts/test-database.js"

// Aucun appel Resend n'est autorisé pendant les tests : sendEmail est un simulacre qui enregistre ses appels.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => true),
}))
// recordAudit garde son comportement réel, mais un test peut le faire échouer pour vérifier l'atomicité.
vi.mock("../../src/services/shared/audit.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/shared/audit.service.js")>()
  return { ...actual, recordAudit: vi.fn(actual.recordAudit) }
})

const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const app = createApp(prisma, { rateLimits: false })

const PASSWORD = "mot-de-passe-pour-test"
const NEW_PASSWORD = "nouveau-mot-de-passe-secret"
let superAdmin: { id: number; token: string }

beforeAll(async () => {
  await prisma.$connect()
})
beforeEach(async () => {
  vi.mocked(sendEmail).mockReset()
  vi.mocked(recordAudit).mockReset()
  await prisma.auditLog.deleteMany()
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
  superAdmin = await createUser("SUPER_ADMIN", "ACTIVE", "superadmin")
})
afterAll(async () => {
  await prisma.$disconnect()
})

// Créer un compte (avec mot de passe s'il est actif) et, s'il l'est, ouvrir une session.
async function createUser(role: Role, status: UserStatus, name: string) {
  const email = `${name}@example.invalid`
  const user = await prisma.user.create({
    data: { email, role, status, ...(status !== "INVITED" && { passwordHash: await hashPassword(PASSWORD) }) },
  })
  return { id: user.id, email, token: status === "ACTIVE" ? await login(email) : "" }
}
async function login(email: string, password = PASSWORD) {
  const response = await request(app).post("/auth/login").send({ email, password })
  expect(response.status).toBe(200)
  return response.body.accessToken as string
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const asSuperAdmin = () => bearer(superAdmin.token)
const rows = () => prisma.auditLog.findMany({ orderBy: { id: "asc" } })
const failNextAudit = () => vi.mocked(recordAudit).mockRejectedValueOnce(new Error("panne de l'audit"))
// Le code envoyé par email est le seul endroit où il apparaît en clair : on le lit dans le simulacre.
const lastEmailedCode = () => {
  const text = vi.mocked(sendEmail).mock.calls.at(-1)![0].text
  // Pas de \b : un code base64url peut commencer ou finir par "-", qui n'est pas un caractère de mot.
  return text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/)![0]
}

describe("Une ligne d'audit par action administrative réussie", () => {
  it("trace la création d'un compte avec l'acteur, la cible et le rôle", async () => {
    const created = await request(app).post("/users").set(asSuperAdmin()).send({ email: "agent@example.invalid", role: "AGENT" })
    expect(created.status).toBe(201)
    expect(await rows()).toMatchObject([
      { action: "USER_CREATED", actorId: superAdmin.id, actorRole: "SUPER_ADMIN", targetUserId: created.body.id, metadata: { role: "AGENT" } },
    ])
  })

  it("trace la désactivation avec les états avant/après et le nombre de sessions révoquées", async () => {
    const agent = await createUser("AGENT", "ACTIVE", "agent")
    await login(agent.email) // deuxième session
    expect((await request(app).patch(`/users/${agent.id}/disable`).set(asSuperAdmin())).status).toBe(200)
    expect(await rows()).toMatchObject([
      {
        action: "USER_DISABLED", actorId: superAdmin.id, targetUserId: agent.id,
        metadata: { statusBefore: "ACTIVE", statusAfter: "DISABLED", revokedSessions: 2 },
      },
    ])
  })

  it("trace la réactivation", async () => {
    const agent = await createUser("AGENT", "DISABLED", "agent")
    expect((await request(app).patch(`/users/${agent.id}/enable`).set(asSuperAdmin())).status).toBe(200)
    expect(await rows()).toMatchObject([
      { action: "USER_ENABLED", actorId: superAdmin.id, targetUserId: agent.id, metadata: { statusBefore: "DISABLED", statusAfter: "ACTIVE" } },
    ])
  })

  it("trace l'activation du compte avec l'acteur retrouvé grâce au code, pas via le body", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    expect((await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())).status).toBe(202)
    const token = lastEmailedCode()

    // Un acteur « librement » fourni dans le body est refusé (champ inconnu), donc impossible à falsifier.
    const forged = await request(app).post("/auth/accept-invitation").send({ token, password: NEW_PASSWORD, actorId: superAdmin.id })
    expect(forged.status).toBe(400)

    expect((await request(app).post("/auth/accept-invitation").send({ token, password: NEW_PASSWORD })).status).toBe(204)
    const accepted = (await rows()).filter((row) => row.action === "INVITATION_ACCEPTED")
    expect(accepted).toMatchObject([
      { actorId: invited.id, actorRole: "USER", targetUserId: invited.id, metadata: { statusBefore: "INVITED", statusAfter: "ACTIVE" } },
    ])
  })

  it("trace la réinitialisation du mot de passe avec l'acteur retrouvé grâce au code", async () => {
    const user = await createUser("AGENT", "ACTIVE", "agent")
    expect((await request(app).post("/auth/request-password-reset").send({ email: user.email })).status).toBe(202)
    // Une simple demande de reset n'est pas tracée.
    expect(await prisma.auditLog.count()).toBe(0)

    const token = lastEmailedCode()
    expect((await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD })).status).toBe(204)
    expect(await rows()).toMatchObject([
      { action: "PASSWORD_RESET_COMPLETED", actorId: user.id, actorRole: "AGENT", targetUserId: user.id, metadata: { revokedSessions: 1 } },
    ])
  })

  it("accepte un événement sans acteur (script CLI)", async () => {
    const target = await createUser("SUPER_ADMIN", "ACTIVE", "premier")
    await recordAudit(prisma, { action: "SUPER_ADMIN_BOOTSTRAPPED", actor: null, targetUserId: target.id, metadata: { source: "cli" } })
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "SUPER_ADMIN_BOOTSTRAPPED" } })).toMatchObject({
      actorId: null, actorRole: null, targetUserId: target.id, metadata: { source: "cli" },
    })
  })

  it("garde la liste d'actions de la validation alignée sur l'enum Prisma", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(Object.keys(AuditAction).sort())
  })
})

describe("Aucune ligne pour une action refusée ou sans effet", () => {
  it("n'écrit rien pour les refus, conflits et erreurs", async () => {
    const agent = await createUser("AGENT", "ACTIVE", "agent")
    const active = await createUser("USER", "ACTIVE", "actif")
    const disabled = await createUser("USER", "DISABLED", "desactive")
    const statuses = [
      await request(app).post("/users").set(asSuperAdmin()).send({ email: agent.email, role: "USER" }), // 409 email pris
      await request(app).post("/users").set(bearer(agent.token)).send({ email: "x@example.invalid", role: "USER" }), // 403
      await request(app).post("/users").send({ email: "x@example.invalid", role: "USER" }), // 401
      await request(app).post("/users").set(asSuperAdmin()).send({ email: "x@example.invalid", role: "SUPER_ADMIN" }), // 400
      await request(app).patch(`/users/${superAdmin.id}/disable`).set(asSuperAdmin()), // 403 Super Admin
      await request(app).patch(`/users/${disabled.id}/disable`).set(asSuperAdmin()), // 409 non actif
      await request(app).patch(`/users/${active.id}/enable`).set(asSuperAdmin()), // 409 non désactivé
      await request(app).patch("/users/999999/disable").set(asSuperAdmin()), // 404
      await request(app).patch("/users/abc/enable").set(asSuperAdmin()), // 400
      await request(app).post(`/users/${active.id}/invitation`).set(asSuperAdmin()), // 409 non invitable
      await request(app).post("/users/999999/invitation").set(asSuperAdmin()), // 404
      await request(app).post("/auth/accept-invitation").send({ token: "A".repeat(43), password: NEW_PASSWORD }), // 400 code inconnu
      await request(app).post("/auth/reset-password").send({ token: "A".repeat(43), password: NEW_PASSWORD }), // 400 code inconnu
    ].map((response) => response.status)
    expect(statuses).toEqual([409, 403, 401, 400, 403, 409, 409, 404, 400, 409, 404, 400, 400])
    expect(await prisma.auditLog.count()).toBe(0)
  })
})

describe("Invitation : création du code, envoi de l'email, échec", () => {
  it("valide la transaction (code + audit) AVANT d'appeler Resend", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    let committedWhenSending = -1
    vi.mocked(sendEmail).mockImplementationOnce(async () => {
      // Lue par une autre connexion : si l'envoi se faisait DANS la transaction, la ligne serait invisible.
      committedWhenSending = await prisma.auditLog.count({ where: { action: "USER_INVITATION_CREATED" } })
      return true
    })
    const response = await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())
    expect(response.status).toBe(202)
    expect(committedWhenSending).toBe(1)
    expect(await rows()).toMatchObject([{ action: "USER_INVITATION_CREATED", targetUserId: invited.id, metadata: { expiresInHours: 24 } }])
  })

  it("trace l'échec d'envoi tout en gardant la réponse 502 et le code en base", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    vi.mocked(sendEmail).mockResolvedValueOnce(false)
    const response = await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())
    expect(response.status).toBe(502)
    expect((await rows()).map((row) => row.action)).toEqual(["USER_INVITATION_CREATED", "USER_INVITATION_SEND_FAILED"])
    expect(await prisma.actionToken.count({ where: { userId: invited.id, purpose: "INVITATION" } })).toBe(1)
  })

  it("garde la réponse 502 même si l'écriture de l'audit de l'échec échoue", async () => {
    const actual = await vi.importActual<typeof import("../../src/services/shared/audit.service.js")>("../../src/services/shared/audit.service.js")
    vi.spyOn(console, "error").mockImplementation(() => {})
    const invited = await createUser("USER", "INVITED", "invite")
    vi.mocked(sendEmail).mockResolvedValueOnce(false)
    vi.mocked(recordAudit).mockImplementationOnce(actual.recordAudit).mockRejectedValueOnce(new Error("panne de l'audit"))
    const response = await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())
    expect(response.status).toBe(502)
    expect((await rows()).map((row) => row.action)).toEqual(["USER_INVITATION_CREATED"])
  })
})

describe("Atomicité : si l'audit échoue, l'action est annulée", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("création de compte", async () => {
    failNextAudit()
    const response = await request(app).post("/users").set(asSuperAdmin()).send({ email: "agent@example.invalid", role: "AGENT" })
    expect(response.status).toBe(500)
    expect(await prisma.user.findUnique({ where: { email: "agent@example.invalid" } })).toBeNull()
  })

  it("désactivation : le statut et les sessions sont restaurés", async () => {
    const agent = await createUser("AGENT", "ACTIVE", "agent")
    failNextAudit()
    expect((await request(app).patch(`/users/${agent.id}/disable`).set(asSuperAdmin())).status).toBe(500)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe("ACTIVE")
    expect(await prisma.session.count({ where: { userId: agent.id, revokedAt: null } })).toBe(1)
    expect((await request(app).get("/tickets").set(bearer(agent.token))).status).toBe(200)
  })

  it("réactivation", async () => {
    const agent = await createUser("AGENT", "DISABLED", "agent")
    failNextAudit()
    expect((await request(app).patch(`/users/${agent.id}/enable`).set(asSuperAdmin())).status).toBe(500)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe("DISABLED")
  })

  it("création du code d'invitation : aucun code créé et aucun email envoyé", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    failNextAudit()
    expect((await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())).status).toBe(500)
    expect(await prisma.actionToken.count()).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("activation du compte : le code reste utilisable", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())
    const token = lastEmailedCode()
    failNextAudit()
    expect((await request(app).post("/auth/accept-invitation").send({ token, password: NEW_PASSWORD })).status).toBe(500)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: invited.id } })
    expect(after).toMatchObject({ status: "INVITED", passwordHash: null })
    expect(await prisma.actionToken.count({ where: { userId: invited.id } })).toBe(1)
    // Une fois l'audit rétabli, le même code fonctionne.
    expect((await request(app).post("/auth/accept-invitation").send({ token, password: NEW_PASSWORD })).status).toBe(204)
  })

  it("réinitialisation du mot de passe : ancien mot de passe, sessions et code conservés", async () => {
    const user = await createUser("AGENT", "ACTIVE", "agent")
    await request(app).post("/auth/request-password-reset").send({ email: user.email })
    const token = lastEmailedCode()
    failNextAudit()
    expect((await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD })).status).toBe(500)
    expect(await login(user.email)).toBeTruthy() // l'ancien mot de passe fonctionne encore
    expect(await prisma.actionToken.count({ where: { userId: user.id, purpose: "PASSWORD_RESET" } })).toBe(1)
    expect(await prisma.auditLog.count()).toBe(0)
  })
})

describe("Aucun secret dans le registre", () => {
  it("ne contient ni mot de passe, ni code, ni hash, ni email après un parcours complet", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    await request(app).post(`/users/${invited.id}/invitation`).set(asSuperAdmin())
    const invitationCode = lastEmailedCode()
    await request(app).post("/auth/accept-invitation").send({ token: invitationCode, password: NEW_PASSWORD })

    await request(app).post("/auth/request-password-reset").send({ email: invited.email })
    const resetCode = lastEmailedCode()
    await request(app).post("/auth/reset-password").send({ token: resetCode, password: NEW_PASSWORD + "-2" })
    await request(app).post("/users").set(asSuperAdmin()).send({ email: "autre@example.invalid", role: "USER" })

    const everything = JSON.stringify(await rows())
    expect((await rows()).length).toBeGreaterThanOrEqual(4)
    const hash = (await prisma.user.findUniqueOrThrow({ where: { id: invited.id } })).passwordHash!
    for (const secret of [NEW_PASSWORD, PASSWORD, invitationCode, resetCode, hashActionToken(invitationCode), hashActionToken(resetCode), hash, "argon2", "@example.invalid"]) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe("Les comptes supprimés ne font pas disparaître l'historique", () => {
  it("garde les lignes avec actorId et targetUserId à NULL, et le rôle de l'acteur", async () => {
    const agent = await createUser("AGENT", "ACTIVE", "agent")
    await request(app).patch(`/users/${agent.id}/disable`).set(asSuperAdmin())
    await prisma.auditLog.create({ data: { action: "USER_ENABLED", actorId: agent.id, actorRole: "AGENT", targetUserId: agent.id } })

    await prisma.user.deleteMany({ where: { id: { in: [agent.id, superAdmin.id] } } })

    const remaining = await rows()
    expect(remaining).toHaveLength(2)
    expect(remaining).toMatchObject([
      { action: "USER_DISABLED", actorId: null, actorRole: "SUPER_ADMIN", targetUserId: null },
      { action: "USER_ENABLED", actorId: null, actorRole: "AGENT", targetUserId: null },
    ])
  })
})

describe("GET /audit-logs", () => {
  it("exige une authentification et le rôle SUPER_ADMIN", async () => {
    expect((await request(app).get("/audit-logs")).status).toBe(401)
    for (const role of ["ADMIN", "AGENT", "USER"] as const) {
      const account = await createUser(role, "ACTIVE", role.toLowerCase())
      expect((await request(app).get("/audit-logs").set(bearer(account.token))).status).toBe(403)
    }
    const response = await request(app).get("/audit-logs").set(asSuperAdmin())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } })
  })

  async function seed(count: number) {
    for (let i = 1; i <= count; i++) {
      await prisma.auditLog.create({
        data: { action: i % 2 === 0 ? "USER_ENABLED" : "USER_DISABLED", actorId: superAdmin.id, actorRole: "SUPER_ADMIN", targetUserId: null, createdAt: new Date(2026, 0, i) },
      })
    }
  }

  it("pagine du plus récent au plus ancien", async () => {
    await seed(25)
    const first = await request(app).get("/audit-logs").set(asSuperAdmin())
    expect(first.body.meta).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 })
    expect(first.body.data).toHaveLength(20)
    const dates: string[] = first.body.data.map((row: { createdAt: string }) => row.createdAt)
    expect([...dates].sort().reverse()).toEqual(dates)

    const last = await request(app).get("/audit-logs?page=2&limit=20").set(asSuperAdmin())
    expect(last.body.data).toHaveLength(5)
    expect(Object.keys(first.body.data[0]).sort()).toEqual(["action", "actorId", "actorRole", "createdAt", "id", "metadata", "targetUserId"])
  })

  it("filtre par action, acteur et cible", async () => {
    const target = await createUser("USER", "ACTIVE", "cible")
    await seed(6)
    await prisma.auditLog.create({ data: { action: "USER_CREATED", actorId: superAdmin.id, actorRole: "SUPER_ADMIN", targetUserId: target.id } })

    const byAction = await request(app).get("/audit-logs?action=USER_ENABLED").set(asSuperAdmin())
    expect(byAction.body.meta.total).toBe(3)
    const byTarget = await request(app).get(`/audit-logs?targetUserId=${target.id}`).set(asSuperAdmin())
    expect(byTarget.body.data.map((row: { action: string }) => row.action)).toEqual(["USER_CREATED"])
    const byActor = await request(app).get(`/audit-logs?actorId=${superAdmin.id}&action=USER_DISABLED`).set(asSuperAdmin())
    expect(byActor.body.meta.total).toBe(3)
  })

  it.each(["?page=0", "?limit=101", "?action=HACK", "?actorId=abc", "?targetUserId=99999999999", "?sort=asc", "?action=USER_ENABLED&action=USER_DISABLED"])(
    "renvoie 400 pour %s",
    async (query) => {
      expect((await request(app).get(`/audit-logs${query}`).set(asSuperAdmin())).status).toBe(400)
    },
  )

  it("est en lecture seule : aucune route pour créer, modifier ou supprimer", async () => {
    await seed(1)
    const id = (await prisma.auditLog.findFirstOrThrow()).id
    expect((await request(app).post("/audit-logs").set(asSuperAdmin()).send({})).status).toBe(404)
    expect((await request(app).patch(`/audit-logs/${id}`).set(asSuperAdmin()).send({})).status).toBe(404)
    expect((await request(app).delete(`/audit-logs/${id}`).set(asSuperAdmin())).status).toBe(404)
    expect(await prisma.auditLog.count()).toBe(1)
  })
})
