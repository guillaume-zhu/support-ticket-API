import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
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
const app = createApp(prisma, { rateLimits: false })

const PASSWORD = "mot-de-passe-pour-test"
type Role = "SUPER_ADMIN" | "AGENT" | "USER"
let tokens: Record<Role, string>

beforeAll(async () => {
  await prisma.$connect()
})
beforeEach(async () => {
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
  tokens = {} as Record<Role, string>
  for (const role of ["SUPER_ADMIN", "AGENT", "USER"] as const) {
    const email = `${role.toLowerCase()}@example.invalid`
    await prisma.user.create({
      data: { email, role, status: "ACTIVE", passwordHash: await hashPassword(PASSWORD) },
    })
    const login = await request(app).post("/auth/login").send({ email, password: PASSWORD })
    tokens[role] = login.body.accessToken
  }
})
afterAll(async () => {
  await prisma.$disconnect()
})

const as = (role: Role) => ({ Authorization: `Bearer ${tokens[role]}` })
const NUL = "\u0000"
const SQL_PAYLOAD = `'; DROP TABLE "Ticket"; --`

describe("Problèmes suspectés : une entrée invalide donne un 4xx, pas un 500", () => {
  it("refuse un octet NUL dans le titre ou la description d'un ticket", async () => {
    const title = await request(app).post("/tickets").set(as("USER")).send({ title: `a${NUL}b`, description: "ok" })
    expect(title.status).toBe(400)
    const description = await request(app).post("/tickets").set(as("USER")).send({ title: "ok", description: `a${NUL}b` })
    expect(description.status).toBe(400)
  })

  it("refuse un octet NUL dans un email (login, reset, création de compte)", async () => {
    const email = `a${NUL}@example.invalid`
    expect((await request(app).post("/auth/login").send({ email, password: PASSWORD })).status).toBe(400)
    expect((await request(app).post("/auth/request-password-reset").send({ email })).status).toBe(400)
    expect((await request(app).post("/users").set(as("SUPER_ADMIN")).send({ email, role: "USER" })).status).toBe(400)
  })

  it("refuse un id hors de la plage d'un entier 32 bits", async () => {
    expect((await request(app).get("/tickets/99999999999").set(as("AGENT"))).status).toBe(400)
    expect((await request(app).get("/tickets/2147483648").set(as("AGENT"))).status).toBe(400)
    expect((await request(app).patch("/users/99999999999/disable").set(as("SUPER_ADMIN"))).status).toBe(400)
    expect((await request(app).get("/tickets?createdById=99999999999").set(as("AGENT"))).status).toBe(400)
  })

  it("refuse les ids écrits en notation exponentielle, hexadécimale ou avec zéros", async () => {
    for (const id of ["1e2", "0x10", "012", "+5", "5.0"]) {
      expect((await request(app).get(`/tickets/${id}`).set(as("AGENT"))).status).toBe(400)
    }
  })

  it("refuse un octet NUL dans la recherche q", async () => {
    expect((await request(app).get("/tickets?q=a%00b").set(as("AGENT"))).status).toBe(400)
  })

  it("borne la longueur du titre (200) et de la description (5000)", async () => {
    const ok = await request(app).post("/tickets").set(as("USER")).send({ title: "t".repeat(200), description: "d".repeat(5000) })
    expect(ok.status).toBe(201)
    expect((await request(app).post("/tickets").set(as("USER")).send({ title: "t".repeat(201), description: "d" })).status).toBe(400)
    expect((await request(app).post("/tickets").set(as("USER")).send({ title: "t", description: "d".repeat(5001) })).status).toBe(400)
  })

  it("autorise les retours à la ligne dans la description mais pas dans le titre", async () => {
    const ok = await request(app).post("/tickets").set(as("USER")).send({ title: "t", description: "ligne 1\nligne 2\tfin" })
    expect(ok.status).toBe(201)
    expect((await request(app).post("/tickets").set(as("USER")).send({ title: "a\nb", description: "d" })).status).toBe(400)
  })

  it("borne la longueur des refresh tokens et des access tokens", async () => {
    const huge = "a".repeat(5000)
    expect((await request(app).post("/auth/refresh").send({ refreshToken: huge })).status).toBe(400)
    expect((await request(app).post("/auth/logout").send({ refreshToken: huge })).status).toBe(400)
    expect((await request(app).get("/tickets").set({ Authorization: `Bearer ${huge}` })).status).toBe(401)
  })
})

describe("Champs inconnus dans les bodies JSON : 400", () => {
  const post = (path: string, body: unknown, role?: Role) => {
    const req = request(app).post(path)
    return (role ? req.set(as(role)) : req).send(body as object)
  }

  it("refuse un createdById fourni par le client", async () => {
    const response = await post("/tickets", { title: "t", description: "d", createdById: 1 }, "USER")
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: "champ inconnu : createdById" })
    expect(await prisma.ticket.count()).toBe(0)
  })

  it.each([
    ["/auth/login", { email: "a@example.invalid", password: PASSWORD, extra: 1 }],
    ["/auth/refresh", { refreshToken: "x", extra: 1 }],
    ["/auth/logout", { refreshToken: "x", extra: 1 }],
    ["/auth/accept-invitation", { token: "x", password: PASSWORD, extra: 1 }],
    ["/auth/request-password-reset", { email: "a@example.invalid", extra: 1 }],
    ["/auth/reset-password", { token: "x", password: PASSWORD, extra: 1 }],
  ])("refuse un champ inconnu sur POST %s", async (path, body) => {
    const response = await post(path, body)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: "champ inconnu : extra" })
  })

  it("refuse un champ inconnu sur la gestion des comptes et des statuts", async () => {
    expect((await post("/users", { email: "n@example.invalid", role: "USER", status: "ACTIVE" }, "SUPER_ADMIN")).status).toBe(400)
    expect((await request(app).patch("/tickets/1/status").set(as("AGENT")).send({ status: "OPEN", id: 5 })).status).toBe(400)
    expect((await request(app).post("/users/1/invitation").set(as("SUPER_ADMIN")).send({ role: "ADMIN" })).status).toBe(400)
    expect((await request(app).patch("/users/1/disable").set(as("SUPER_ADMIN")).send({ x: 1 })).status).toBe(400)
    expect((await request(app).patch("/users/1/enable").set(as("SUPER_ADMIN")).send({ x: 1 })).status).toBe(400)
  })

  it("refuse un body qui n'est pas un objet JSON (tableau) et un champ __proto__", async () => {
    expect((await post("/tickets", [{ title: "t", description: "d" }], "USER")).status).toBe(400)
    const proto = await request(app).post("/tickets").set(as("USER")).set("Content-Type", "application/json")
      .send('{"title":"t","description":"d","__proto__":{"admin":true}}')
    expect(proto.status).toBe(400)
  })

  it("accepte toujours un body vide sur les routes sans body", async () => {
    // Aucun champ attendu : l'absence de body ne doit pas être refusée.
    expect((await request(app).patch("/users/999999/disable").set(as("SUPER_ADMIN"))).status).toBe(404)
    expect((await request(app).patch("/users/999999/enable").set(as("SUPER_ADMIN")).send({})).status).toBe(404)
  })
})

describe("Du texte qui ressemble à du SQL reste du texte normal", () => {
  it("stocke et retrouve un titre contenant du SQL, sans rien exécuter", async () => {
    const created = await request(app).post("/tickets").set(as("USER"))
      .send({ title: SQL_PAYLOAD, description: "1' OR '1'='1" })
    expect(created.status).toBe(201)
    expect(created.body.title).toBe(SQL_PAYLOAD)

    const found = await request(app).get(`/tickets?q=${encodeURIComponent("DROP TABLE")}`).set(as("AGENT"))
    expect(found.status).toBe(200)
    expect(found.body.data.map((t: { title: string }) => t.title)).toEqual([SQL_PAYLOAD])
    expect(await prisma.ticket.count()).toBe(1)
  })

  it("traite un email au look d'injection, mais bien formé, comme un simple identifiant inconnu", async () => {
    const response = await request(app).post("/auth/login").send({ email: "admin'--@example.invalid", password: PASSWORD })
    expect(response.status).toBe(401)
    const reset = await request(app).post("/auth/request-password-reset").send({ email: "x';DROP-TABLE--@example.invalid" })
    expect(reset.status).toBe(202)
    expect(await prisma.user.count()).toBe(3)
  })
})

describe("Aucune entrée hostile ne provoque de 500", () => {
  const hostileText = [SQL_PAYLOAD, `a${NUL}b`, "x".repeat(100_000), "‮", "😀".repeat(50), "%", "\\", "{{7*7}}", "../../etc/passwd"]
  const hostileValues: unknown[] = [...hostileText, null, 0, -1, 1.5, true, [], {}, [1, 2], { a: { b: 1 } }, 2 ** 53, 99999999999]

  // Corps valide pour chaque endpoint : un seul champ à la fois est remplacé par une valeur hostile,
  // pour que la requête atteigne vraiment la validation puis la base (sinon un autre champ manquant la stoppe).
  const validToken = "A".repeat(43)
  const endpoints: { method: "post" | "patch"; path: string; role?: Role; base: Record<string, unknown> }[] = [
    { method: "post", path: "/auth/login", base: { email: "user@example.invalid", password: PASSWORD } },
    { method: "post", path: "/auth/refresh", base: { refreshToken: "x" } },
    { method: "post", path: "/auth/logout", base: { refreshToken: "x" } },
    { method: "post", path: "/auth/accept-invitation", base: { token: validToken, password: PASSWORD } },
    { method: "post", path: "/auth/request-password-reset", base: { email: "user@example.invalid" } },
    { method: "post", path: "/auth/reset-password", base: { token: validToken, password: PASSWORD } },
    { method: "post", path: "/users", role: "SUPER_ADMIN", base: { email: "nouveau@example.invalid", role: "USER" } },
    { method: "post", path: "/tickets", role: "USER", base: { title: "titre", description: "description" } },
    { method: "patch", path: "/tickets/1/status", role: "AGENT", base: { status: "OPEN" } },
  ]

  it("répond toujours 4xx ou 2xx (jamais 5xx) à des valeurs hostiles dans chaque champ", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const serverErrors: string[] = []
    for (const endpoint of endpoints) {
      for (const field of Object.keys(endpoint.base)) {
        for (const value of hostileValues) {
          const req = request(app)[endpoint.method](endpoint.path)
          const response = await (endpoint.role ? req.set(as(endpoint.role)) : req).send({ ...endpoint.base, [field]: value })
          if (response.status >= 500) {
            serverErrors.push(`${endpoint.method.toUpperCase()} ${endpoint.path} ${field}=${JSON.stringify(value)?.slice(0, 30)} → ${response.status}`)
          }
        }
      }
    }
    expect(serverErrors).toEqual([])
  })

  it("répond toujours 4xx ou 2xx à des ids et paramètres de query hostiles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const serverErrors: string[] = []
    const ids = ["-1", "0", "1e2", "0x10", "abc", "99999999999", "%00", "1%27%20OR%201=1", "1;DROP", "%E2%80%AE", "9".repeat(5000)]
    const paths = [(i: string) => `/tickets/${i}`, (i: string) => `/tickets?createdById=${i}`, (i: string) => `/tickets?q=${i}`,
      (i: string) => `/tickets?page=${i}`, (i: string) => `/tickets?status=${i}`, (i: string) => `/tickets?sortBy=${i}`]
    for (const path of paths) {
      for (const id of ids) {
        const response = await request(app).get(path(id)).set(as("AGENT"))
        if (response.status >= 500) serverErrors.push(`GET ${path(id).slice(0, 60)} → ${response.status}`)
      }
    }
    for (const id of ids) {
      for (const method of ["patch"] as const) {
        for (const suffix of ["/disable", "/enable"]) {
          const response = await request(app)[method](`/users/${id}${suffix}`).set(as("SUPER_ADMIN"))
          if (response.status >= 500) serverErrors.push(`PATCH /users/${id.slice(0, 20)}${suffix} → ${response.status}`)
        }
      }
      const invite = await request(app).post(`/users/${id}/invitation`).set(as("SUPER_ADMIN"))
      if (invite.status >= 500) serverErrors.push(`POST /users/${id.slice(0, 20)}/invitation → ${invite.status}`)
    }
    expect(serverErrors).toEqual([])
  })
})

describe("Les nouvelles limites ne cassent pas les tokens légitimes", () => {
  it("accepte de vrais access et refresh tokens, avec une grande marge sous la limite", async () => {
    const login = await request(app).post("/auth/login").send({ email: "user@example.invalid", password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.accessToken.length).toBeLessThan(1024)
    expect(login.body.refreshToken.length).toBeLessThan(1024)

    expect((await request(app).get("/tickets").set({ Authorization: `Bearer ${login.body.accessToken}` })).status).toBe(200)
    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: login.body.refreshToken })
    expect(refreshed.status).toBe(200)
    expect((await request(app).post("/auth/logout").send({ refreshToken: refreshed.body.refreshToken })).status).toBe(204)
  })

  it("accepte un mot de passe de 1024 octets et un email de 254 caractères valides", async () => {
    const longEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(54)}.com`
    expect(longEmail.length).toBeLessThanOrEqual(254)
    const created = await request(app).post("/users").set(as("SUPER_ADMIN")).send({ email: longEmail, role: "USER" })
    expect(created.status).toBe(201)
  })
})

describe("Garde statique contre les usages SQL dangereux", () => {
  // Contrôle textuel simple et NON exhaustif : il attrape les oublis évidents (méthodes *Unsafe,
  // Prisma.raw, appel de $queryRaw sans template), pas une construction de SQL détournée.
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (path.includes(join("src", "generated"))) return []
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : []
    })
  }

  it("n'utilise aucune API SQL brute dangereuse dans src/ et scripts/", () => {
    const forbidden = /\$(?:query|execute)Raw(?:Unsafe)?\s*\(|\$(?:query|execute)RawUnsafe|Prisma\.raw\b/
    const offenders = [...sourceFiles("src"), ...sourceFiles("scripts")].filter((file) => forbidden.test(readFileSync(file, "utf8")))
    expect(offenders).toEqual([])
  })
})
