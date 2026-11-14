import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const app = createApp(prisma)

beforeAll(async () => {
  await prisma.$connect()
})
beforeEach(async () => {
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
})
afterAll(async () => {
  await prisma.$disconnect()
})

async function createUser(role: "AGENT" | "USER", name: string) {
  const password = "mot-de-passe-pour-test"
  const email = `${name}@example.invalid`
  const user = await prisma.user.create({
    data: { email, role, status: "ACTIVE", passwordHash: await hashPassword(password) },
  })
  const response = await request(app).post("/auth/login").send({ email, password })
  expect(response.status).toBe(200)
  return { id: user.id, token: response.body.accessToken as string }
}

const list = (token: string, query = "") =>
  request(app).get(`/tickets${query}`).set({ Authorization: `Bearer ${token}` })

// Créer n tickets avec des dates croissantes (ticket 1 = le plus ancien).
async function seedTickets(count: number, createdById: number | null = null) {
  for (let i = 1; i <= count; i++) {
    await prisma.ticket.create({
      data: { title: `Ticket ${i}`, description: "desc", createdById, createdAt: new Date(2026, 0, i) },
    })
  }
}

const titles = (response: { body: { data: { title: string }[] } }) => response.body.data.map((t) => t.title)

describe("Pagination", () => {
  it("renvoie la première page de 20 tickets, du plus récent au plus ancien, par défaut", async () => {
    const agent = await createUser("AGENT", "agent")
    await seedTickets(25)
    const response = await list(agent.token)
    expect(response.status).toBe(200)
    expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 })
    expect(response.body.data).toHaveLength(20)
    expect(titles(response)[0]).toBe("Ticket 25")
  })

  it("découpe en pages sans doublon ni oubli", async () => {
    const agent = await createUser("AGENT", "agent")
    await seedTickets(7)
    const seen: string[] = []
    for (const page of [1, 2, 3]) {
      const response = await list(agent.token, `?limit=3&page=${page}`)
      expect(response.body.meta).toEqual({ page, limit: 3, total: 7, totalPages: 3 })
      seen.push(...titles(response))
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it("renvoie 200 avec une liste vide au-delà de la dernière page", async () => {
    const agent = await createUser("AGENT", "agent")
    await seedTickets(3)
    const response = await list(agent.token, "?page=9")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ data: [], meta: { page: 9, limit: 20, total: 3, totalPages: 1 } })
  })

  it("renvoie une meta cohérente quand il n'y a aucun ticket", async () => {
    const agent = await createUser("AGENT", "agent")
    expect((await list(agent.token)).body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } })
  })

  it("garde un ordre stable quand des tickets ont la même date", async () => {
    const agent = await createUser("AGENT", "agent")
    const sameDate = new Date(2026, 0, 1)
    for (let i = 1; i <= 4; i++) {
      await prisma.ticket.create({ data: { title: `T${i}`, description: "d", createdAt: sameDate } })
    }
    const first = await list(agent.token, "?limit=2&page=1")
    const second = await list(agent.token, "?limit=2&page=2")
    expect([...titles(first), ...titles(second)]).toEqual(["T4", "T3", "T2", "T1"])
  })
})

describe("Filtres et tri", () => {
  it("filtre par status", async () => {
    const agent = await createUser("AGENT", "agent")
    await prisma.ticket.create({ data: { title: "A", description: "d", status: "OPEN" } })
    await prisma.ticket.create({ data: { title: "B", description: "d", status: "CLOSED" } })
    const response = await list(agent.token, "?status=CLOSED")
    expect(titles(response)).toEqual(["B"])
    expect(response.body.meta.total).toBe(1)
  })

  it("filtre par texte du titre sans tenir compte de la casse", async () => {
    const agent = await createUser("AGENT", "agent")
    await prisma.ticket.create({ data: { title: "Connexion impossible", description: "d" } })
    await prisma.ticket.create({ data: { title: "Facture", description: "d" } })
    expect(titles(await list(agent.token, "?q=CONNEXION"))).toEqual(["Connexion impossible"])
  })

  it("traite %, _ et \\ comme du texte et non comme des jokers", async () => {
    const agent = await createUser("AGENT", "agent")
    for (const title of ["Remise 100% offerte", "Remise 100 offerte", "a_b", "axb", "chemin\\fichier", "cheminfichier"]) {
      await prisma.ticket.create({ data: { title, description: "d" } })
    }
    expect(titles(await list(agent.token, `?q=${encodeURIComponent("100%")}`))).toEqual(["Remise 100% offerte"])
    expect(titles(await list(agent.token, `?q=${encodeURIComponent("a_b")}`))).toEqual(["a_b"])
    expect(titles(await list(agent.token, `?q=${encodeURIComponent("chemin\\f")}`))).toEqual(["chemin\\fichier"])
    // Un % seul ne doit pas tout renvoyer.
    expect((await list(agent.token, `?q=${encodeURIComponent("%")}`)).body.meta.total).toBe(1)
  })

  it("filtre par auteur pour le personnel", async () => {
    const agent = await createUser("AGENT", "agent")
    const alice = await createUser("USER", "alice")
    await seedTickets(2, alice.id)
    await seedTickets(3)
    const response = await list(agent.token, `?createdById=${alice.id}`)
    expect(response.body.meta.total).toBe(2)
  })

  it("trie par titre croissant", async () => {
    const agent = await createUser("AGENT", "agent")
    for (const title of ["b", "c", "a"]) await prisma.ticket.create({ data: { title, description: "d" } })
    expect(titles(await list(agent.token, "?sortBy=title&order=asc"))).toEqual(["a", "b", "c"])
    expect(titles(await list(agent.token, "?sortBy=title&order=desc"))).toEqual(["c", "b", "a"])
  })

  it("combine filtres, tri et pagination", async () => {
    const agent = await createUser("AGENT", "agent")
    for (let i = 1; i <= 5; i++) {
      await prisma.ticket.create({ data: { title: `Bug ${i}`, description: "d", status: "OPEN" } })
    }
    await prisma.ticket.create({ data: { title: "Bug 6", description: "d", status: "CLOSED" } })
    const response = await list(agent.token, "?status=OPEN&q=bug&sortBy=id&order=asc&limit=2&page=3")
    expect(titles(response)).toEqual(["Bug 5"])
    expect(response.body.meta).toEqual({ page: 3, limit: 2, total: 5, totalPages: 3 })
  })
})

describe("Paramètres invalides", () => {
  it.each([
    "?page=0", "?page=abc", "?limit=0", "?limit=101", "?status=open", "?sortBy=description",
    "?order=up", "?createdById=abc", "?sort=title", "?page=1&foo=bar", "?filter[status]=OPEN", "?status=OPEN&status=CLOSED", `?q=${"x".repeat(101)}`,
  ])("renvoie 400 pour %s", async (query) => {
    const agent = await createUser("AGENT", "agent")
    const response = await list(agent.token, query)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: expect.any(String) })
  })

  it("traite une tentative d'injection SQL comme du texte simple", async () => {
    const agent = await createUser("AGENT", "agent")
    await seedTickets(2)
    const response = await list(agent.token, `?q=${encodeURIComponent("'; DROP TABLE \"Ticket\"; --")}`)
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual([])
    expect(await prisma.ticket.count()).toBe(2)
  })
})

describe("Permissions avec filtres", () => {
  it("un USER ne voit ni ne compte les tickets des autres, même avec des filtres", async () => {
    const alice = await createUser("USER", "alice")
    const bob = await createUser("USER", "bob")
    await seedTickets(3, alice.id)
    await seedTickets(5, bob.id)
    await seedTickets(4)

    const response = await list(alice.token, "?limit=2&q=ticket&sortBy=title&order=asc")
    expect(response.status).toBe(200)
    expect(response.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 })
    expect(response.body.data.every((t: { createdById: number }) => t.createdById === alice.id)).toBe(true)
  })

  it("un USER reçoit 403 s'il filtre par createdById", async () => {
    const alice = await createUser("USER", "alice")
    const bob = await createUser("USER", "bob")
    await seedTickets(2, bob.id)
    expect((await list(alice.token, `?createdById=${bob.id}`)).status).toBe(403)
    expect((await list(alice.token, `?createdById=${alice.id}`)).status).toBe(403)
  })

  it("exige toujours une authentification", async () => {
    expect((await request(app).get("/tickets?page=1")).status).toBe(401)
  })
})

describe("Cohérence des lectures", () => {
  it("lit data et total dans une transaction RepeatableRead", async () => {
    const agent = await createUser("AGENT", "agent")
    await seedTickets(3)
    const spy = vi.spyOn(prisma, "$transaction")
    await list(agent.token)
    // Le niveau d'isolation doit être demandé explicitement (le défaut PostgreSQL est read committed).
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" })
    spy.mockRestore()
  })
})
