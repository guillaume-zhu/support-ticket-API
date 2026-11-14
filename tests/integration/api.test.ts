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

async function loginAs(role: "SUPER_ADMIN" | "ADMIN" | "AGENT" | "USER") {
  const password = "mot-de-passe-pour-test"
  const email = `${role.toLowerCase()}@example.invalid`
  await prisma.user.create({
    data: { email, role, status: "ACTIVE", passwordHash: await hashPassword(password) },
  })
  const response = await request(app).post("/auth/login").send({ email, password })
  expect(response.status).toBe(200)
  return response.body.accessToken as string
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
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].id).toBe(created.body.id)
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
