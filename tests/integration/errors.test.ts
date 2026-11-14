import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import express from "express"
import request from "supertest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import { handleError, notFound } from "../../src/middlewares/errors.js"
import { hashPassword } from "../../src/utils/credentials.js"
import { assertTestDatabase } from "../../scripts/test-database.js"

// Aucun appel Resend n'est autorisé pendant les tests.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => true),
}))

const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const app = createApp(prisma)

beforeAll(async () => {
  await prisma.$connect()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe("Routes inconnues", () => {
  it("renvoie un 404 JSON, pas une page HTML", async () => {
    const response = await request(app).get("/nimportequoi")
    expect(response.status).toBe(404)
    expect(response.headers["content-type"]).toMatch(/application\/json/)
    expect(response.body).toEqual({ error: "route introuvable" })
  })

  it("renvoie aussi un 404 JSON pour une méthode non gérée sur une route existante", async () => {
    const response = await request(app).delete("/tickets/1")
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: "route introuvable" })
  })
})

describe("Requêtes incorrectes", () => {
  it("distingue un JSON malformé (400)", async () => {
    const response = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": ')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: "JSON invalide" })
  })

  it("distingue un corps de plus de 100 Ko (413)", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: "a@example.invalid", password: "x".repeat(101 * 1024) })
    expect(response.status).toBe(413)
    expect(response.body).toEqual({ error: "corps de requête trop volumineux" })
  })
})

describe("Erreurs internes", () => {
  it("renvoie un 500 générique sans détail ni stack trace", async () => {
    const secret = "mot de passe de la base : hunter2"
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(prisma.user, "findUnique").mockRejectedValue(new Error(secret))

    const response = await request(app).post("/auth/login").send({ email: "a@example.invalid", password: "x" })
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: "erreur interne" })
    expect(JSON.stringify(response.body)).not.toContain("hunter2")
    // Le détail reste disponible dans les logs serveur.
    expect(console.error).toHaveBeenCalled()
  })

  it("laisse Express fermer la connexion si les en-têtes sont déjà partis", async () => {
    // Application isolée construite uniquement dans ce test : aucune route de diagnostic en production.
    const isolated = express()
    isolated.get("/partial", (_req, res) => {
      res.write("début de réponse")
      throw new Error("échec après envoi des en-têtes")
    })
    isolated.use(notFound)
    isolated.use(handleError)
    vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await request(isolated).get("/partial").catch((error: unknown) => error)
    // Pas de second corps JSON ajouté : soit la connexion est coupée, soit seul le début est reçu.
    const text = response instanceof Error ? "" : (response as { text: string }).text
    expect(text).not.toContain("erreur interne")
  })
})

describe("Réponses 204 sans corps", () => {
  it("logout renvoie 204 sans corps", async () => {
    const password = "mot-de-passe-pour-test"
    const email = "logout@example.invalid"
    await prisma.user.deleteMany({ where: { email } })
    await prisma.user.create({
      data: { email, role: "USER", status: "ACTIVE", passwordHash: await hashPassword(password) },
    })
    const login = await request(app).post("/auth/login").send({ email, password })
    expect(login.status).toBe(200)

    const logout = await request(app).post("/auth/logout").send({ refreshToken: login.body.refreshToken })
    expect(logout.status).toBe(204)
    expect(logout.text).toBe("")
    expect(logout.body).toEqual({})
    await prisma.session.deleteMany({ where: { user: { email } } })
    await prisma.user.deleteMany({ where: { email } })
  })
})
