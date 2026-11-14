import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import { hashPassword } from "../../src/utils/credentials.js"
import { assertTestDatabase } from "../../scripts/test-database.js"

// Aucun appel Resend n'est autorisé pendant les tests.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => true),
}))

const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
if (process.env.DATABASE_URL !== url || process.env.NODE_ENV !== "test") {
  throw new Error("Les tests HTTP exigent la configuration isolée de npm test")
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const app = createApp(prisma)

beforeAll(async () => {
  await prisma.$connect()
})

beforeEach(async () => {
  // Purger seulement la base dédiée, après vérification stricte de son URL.
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
})

type TestRole = "SUPER_ADMIN" | "ADMIN" | "AGENT" | "USER"

// Créer un compte actif et renvoyer son id et son access token.
// `name` permet d'avoir plusieurs utilisateurs du même rôle (Alice et Bob).
async function createUser(role: TestRole, name: string = role.toLowerCase()) {
  const password = "mot-de-passe-pour-test"
  const email = `${name}@example.invalid`
  const user = await prisma.user.create({
    data: { email, role, status: "ACTIVE", passwordHash: await hashPassword(password) },
  })
  const response = await request(app).post("/auth/login").send({ email, password })
  expect(response.status).toBe(200)
  return { id: user.id, token: response.body.accessToken as string }
}

async function loginAs(role: TestRole) {
  return (await createUser(role)).token
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

function createTicket(token: string, extra: object = {}) {
  return request(app)
    .post("/tickets")
    .set(bearer(token))
    .send({ title: "Connexion impossible", description: "Erreur au login", ...extra })
}

describe("API HTTP", () => {
  it("refuse les identifiants invalides et les accès sans JWT", async () => {
    expect((await request(app).post("/auth/login").send({ email: "x", password: "" })).status).toBe(400)
    expect((await request(app).get("/tickets")).status).toBe(401)
  })

  it("crée un ticket et permet sa lecture au personnel", async () => {
    const token = await loginAs("AGENT")
    const created = await request(app)
      .post("/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "  Connexion  ", description: "  Impossible  " })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ title: "Connexion", description: "Impossible", status: "OPEN" })

    const listed = await request(app).get("/tickets").set("Authorization", `Bearer ${token}`)
    expect(listed.status).toBe(200)
    expect(listed.body.data).toHaveLength(1)
    expect(listed.body.data[0].id).toBe(created.body.id)
  })

  it("rejette les données de ticket invalides", async () => {
    const token = await loginAs("USER")
    const response = await request(app)
      .post("/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: " ", description: "valide" })
    expect(response.status).toBe(400)
    expect(await prisma.ticket.count()).toBe(0)
  })
})

describe("Authentification des routes tickets", () => {
  it("refuse un token invalide ou falsifié", async () => {
    expect((await request(app).get("/tickets").set(bearer("pas.un.jwt"))).status).toBe(401)
    expect((await request(app).get("/tickets/1")).status).toBe(401)
    expect((await request(app).post("/tickets").send({})).status).toBe(401)
    expect((await request(app).patch("/tickets/1/status").send({ status: "CLOSED" })).status).toBe(401)
  })

  it("refuse un compte désactivé même avec un token encore valide", async () => {
    const { id, token } = await createUser("USER")
    await prisma.user.update({ where: { id }, data: { status: "DISABLED" } })
    expect((await request(app).get("/tickets").set(bearer(token))).status).toBe(401)
  })
})

describe("Propriété des tickets", () => {
  it("enregistre l'auteur authentifié et ignore un createdById fourni par le client", async () => {
    const alice = await createUser("USER", "alice")
    const bob = await createUser("USER", "bob")
    const created = await createTicket(alice.token, { createdById: bob.id })
    expect(created.status).toBe(201)
    expect(created.body.createdById).toBe(alice.id)
  })

  it("un USER ne liste que ses propres tickets", async () => {
    const alice = await createUser("USER", "alice")
    const bob = await createUser("USER", "bob")
    const aliceTicket = await createTicket(alice.token)
    await createTicket(bob.token)

    const listed = await request(app).get("/tickets").set(bearer(alice.token))
    expect(listed.status).toBe(200)
    expect(listed.body.data.map((t: { id: number }) => t.id)).toEqual([aliceTicket.body.id])
  })

  it("un USER lit son ticket mais reçoit 404 sur celui d'un autre", async () => {
    const alice = await createUser("USER", "alice")
    const bob = await createUser("USER", "bob")
    const aliceTicket = await createTicket(alice.token)

    expect((await request(app).get(`/tickets/${aliceTicket.body.id}`).set(bearer(alice.token))).status).toBe(200)
    expect((await request(app).get(`/tickets/${aliceTicket.body.id}`).set(bearer(bob.token))).status).toBe(404)
  })

  it("le personnel voit tous les tickets, y compris ceux sans auteur", async () => {
    const alice = await createUser("USER", "alice")
    const aliceTicket = await createTicket(alice.token)
    const legacy = await prisma.ticket.create({ data: { title: "Ancien", description: "Sans auteur" } })

    for (const role of ["AGENT", "ADMIN", "SUPER_ADMIN"] as const) {
      const { token } = await createUser(role)
      const listed = await request(app).get("/tickets").set(bearer(token))
      expect(listed.status).toBe(200)
      expect(listed.body.data.map((t: { id: number }) => t.id)).toEqual([legacy.id, aliceTicket.body.id])
      expect((await request(app).get(`/tickets/${legacy.id}`).set(bearer(token))).status).toBe(200)
    }
  })

  it("un USER ne voit pas les anciens tickets sans auteur", async () => {
    const alice = await createUser("USER", "alice")
    const legacy = await prisma.ticket.create({ data: { title: "Ancien", description: "Sans auteur" } })
    expect((await request(app).get(`/tickets/${legacy.id}`).set(bearer(alice.token))).status).toBe(404)
    expect((await request(app).get("/tickets").set(bearer(alice.token))).body.data).toEqual([])
  })
})

describe("Permissions sur le statut des tickets", () => {
  it("un USER ne peut pas modifier le statut, même de son propre ticket", async () => {
    const alice = await createUser("USER", "alice")
    const ticket = await createTicket(alice.token)
    const response = await request(app)
      .patch(`/tickets/${ticket.body.id}/status`)
      .set(bearer(alice.token))
      .send({ status: "CLOSED" })
    expect(response.status).toBe(403)
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.body.id } })).status).toBe("OPEN")
  })

  it("le personnel peut modifier le statut", async () => {
    const alice = await createUser("USER", "alice")
    const ticket = await createTicket(alice.token)
    for (const role of ["AGENT", "ADMIN", "SUPER_ADMIN"] as const) {
      const { token } = await createUser(role)
      const response = await request(app)
        .patch(`/tickets/${ticket.body.id}/status`)
        .set(bearer(token))
        .send({ status: "IN_PROGRESS" })
      expect(response.status).toBe(200)
      expect(response.body.status).toBe("IN_PROGRESS")
    }
  })
})
