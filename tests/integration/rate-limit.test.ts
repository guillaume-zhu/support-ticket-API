import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import type { RateLimits } from "../../src/middlewares/rate-limit.js"
import { hashPassword } from "../../src/utils/credentials.js"
import { assertTestDatabase } from "../../scripts/test-database.js"

// Aucun appel Resend n'est autorisé pendant les tests.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => true),
}))

const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

const PASSWORD = "mot-de-passe-pour-test"
// Limites très hautes par défaut : chaque test abaisse seulement celle qu'il vérifie.
const HIGH = 1000
const high: RateLimits = {
  global: HIGH, loginPerIp: HIGH, loginFailuresPerIpAndEmail: HIGH,
  passwordResetPerIp: HIGH, passwordResetPerEmail: HIGH, codesPerIp: HIGH, refreshPerIp: HIGH,
}

// Une application neuve par test : ses compteurs en mémoire repartent de zéro.
const makeApp = (limits: Partial<RateLimits>, trustProxy = 0, rateLimitWindowMs?: number) =>
  createApp(prisma, { rateLimits: { ...high, ...limits }, trustProxy, ...(rateLimitWindowMs && { rateLimitWindowMs }) })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  await prisma.$connect()
})
beforeEach(async () => {
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(async () => {
  await prisma.$disconnect()
})

async function createUser(email: string) {
  await prisma.user.create({
    data: { email, role: "USER", status: "ACTIVE", passwordHash: await hashPassword(PASSWORD) },
  })
}

type App = ReturnType<typeof makeApp>
const login = (app: App, email: string, password = "mauvais-mot-de-passe") =>
  request(app).post("/auth/login").send({ email, password })

describe("Rate limiting du login", () => {
  it("renvoie 429 après trop d'échecs, sans exécuter le controller", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 3 })
    await createUser("alice@example.invalid")

    for (let i = 0; i < 3; i++) {
      expect((await login(app, "alice@example.invalid")).status).toBe(401)
    }
    // Même avec le BON mot de passe, la requête est bloquée avant le controller : aucune session créée.
    const blocked = await login(app, "alice@example.invalid", PASSWORD)
    expect(blocked.status).toBe(429)
    expect(blocked.body).toEqual({ error: "trop de requêtes, réessayez plus tard" })
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0)
    expect(blocked.headers["ratelimit"]).toBeDefined()
    expect(await prisma.session.count()).toBe(0)
  })

  it("ne compte pas les connexions réussies dans le quota d'échecs", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 2 })
    await createUser("alice@example.invalid")

    for (let i = 0; i < 4; i++) {
      expect((await login(app, "alice@example.invalid", PASSWORD)).status).toBe(200)
    }
    expect((await login(app, "alice@example.invalid")).status).toBe(401)
    expect((await login(app, "alice@example.invalid")).status).toBe(401)
    expect((await login(app, "alice@example.invalid")).status).toBe(429)
  })

  it("sépare les quotas par email", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 2 })
    for (let i = 0; i < 2; i++) await login(app, "a@example.invalid")
    expect((await login(app, "a@example.invalid")).status).toBe(429)
    expect((await login(app, "b@example.invalid")).status).toBe(401)
  })

  it("normalise l'email : les variantes de casse partagent le même quota", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 2 })
    await login(app, "A@Example.invalid")
    await login(app, "  a@example.INVALID ")
    expect((await login(app, "a@example.invalid")).status).toBe(429)
  })

  it("limite toutes les tentatives par IP, connexions réussies comprises", async () => {
    const app = makeApp({ loginPerIp: 3 })
    await createUser("alice@example.invalid")
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "alice@example.invalid", PASSWORD)).status).toBe(200)
    }
    expect((await login(app, "alice@example.invalid", PASSWORD)).status).toBe(429)
  })

  it("ne compte que les vrais échecs d'authentification (401), pas les 400 ni les 500", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 2 })
    await createUser("alice@example.invalid")

    // Requêtes mal formées (400) : aucune consommation du quota.
    for (let i = 0; i < 5; i++) {
      expect((await login(app, "alice@example.invalid", "")).status).toBe(400)
    }
    // Erreurs internes (500) : aucune consommation non plus.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const failing = vi.spyOn(prisma.user, "findUnique").mockRejectedValue(new Error("panne"))
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "alice@example.invalid")).status).toBe(500)
    }
    failing.mockRestore()

    // Le quota est donc intact : deux vrais échecs passent, le troisième est bloqué.
    expect((await login(app, "alice@example.invalid")).status).toBe(401)
    expect((await login(app, "alice@example.invalid")).status).toBe(401)
    expect((await login(app, "alice@example.invalid")).status).toBe(429)
  })

  it("redonne l'accès à la fin de la fenêtre", async () => {
    const app = makeApp({ loginFailuresPerIpAndEmail: 1 }, 0, 300)
    expect((await login(app, "a@example.invalid")).status).toBe(401)
    expect((await login(app, "a@example.invalid")).status).toBe(429)
    await sleep(450)
    expect((await login(app, "a@example.invalid")).status).toBe(401)
  })
})

describe("Rate limiting de la réinitialisation de mot de passe", () => {
  const requestReset = (app: App, email: string, ip?: string) => {
    const req = request(app).post("/auth/request-password-reset")
    if (ip) req.set("X-Forwarded-For", ip)
    return req.send({ email })
  }

  it("limite les demandes par adresse email, même depuis des IP différentes", async () => {
    // trustProxy = 1 : on simule un proxy de confiance qui fournit l'IP réelle.
    const app = makeApp({ passwordResetPerEmail: 2 }, 1)
    expect((await requestReset(app, "victime@example.invalid", "1.1.1.1")).status).toBe(202)
    expect((await requestReset(app, "victime@example.invalid", "2.2.2.2")).status).toBe(202)
    expect((await requestReset(app, "victime@example.invalid", "3.3.3.3")).status).toBe(429)
    // Une autre adresse n'est pas touchée.
    expect((await requestReset(app, "autre@example.invalid", "3.3.3.3")).status).toBe(202)
  })

  it("ne bloque pas définitivement : la demande redevient possible après la fenêtre", async () => {
    const app = makeApp({ passwordResetPerEmail: 1 }, 0, 400)
    expect((await requestReset(app, "victime@example.invalid")).status).toBe(202)
    expect((await requestReset(app, "victime@example.invalid")).status).toBe(429)
    await sleep(550)
    expect((await requestReset(app, "victime@example.invalid")).status).toBe(202)
  })

  it("applique le quota de la même façon que le compte existe ou non (pas d'énumération)", async () => {
    const app = makeApp({ passwordResetPerEmail: 1 })
    await createUser("existe@example.invalid")
    for (const email of ["existe@example.invalid", "inconnu@example.invalid"]) {
      expect((await requestReset(app, email)).status).toBe(202)
      expect((await requestReset(app, email)).status).toBe(429)
    }
  })

  it("limite les demandes par IP", async () => {
    const app = makeApp({ passwordResetPerIp: 2 })
    expect((await requestReset(app, "a@example.invalid")).status).toBe(202)
    expect((await requestReset(app, "b@example.invalid")).status).toBe(202)
    expect((await requestReset(app, "c@example.invalid")).status).toBe(429)
  })
})

describe("Rate limiting des codes et du refresh", () => {
  it("partage un seul quota par IP entre reset-password et accept-invitation", async () => {
    const app = makeApp({ codesPerIp: 3 })
    expect((await request(app).post("/auth/reset-password").send({})).status).toBe(400)
    expect((await request(app).post("/auth/accept-invitation").send({})).status).toBe(400)
    expect((await request(app).post("/auth/reset-password").send({})).status).toBe(400)
    // Alterner les deux routes ne double pas le nombre d'essais.
    expect((await request(app).post("/auth/accept-invitation").send({})).status).toBe(429)
    expect((await request(app).post("/auth/reset-password").send({})).status).toBe(429)
  })

  it("limite /auth/refresh par IP", async () => {
    const app = makeApp({ refreshPerIp: 2 })
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post("/auth/refresh").send({ refreshToken: "x" })).status).toBe(401)
    }
    expect((await request(app).post("/auth/refresh").send({ refreshToken: "x" })).status).toBe(429)
  })
})

describe("Limiteur global et identification de l'IP", () => {
  it("bloque toutes les routes au-delà de la limite globale", async () => {
    const app = makeApp({ global: 3 })
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/tickets")).status).toBe(401)
    }
    expect((await request(app).get("/tickets")).status).toBe(429)
    expect((await request(app).get("/nimportequoi")).status).toBe(429)
  })

  it("ignore un X-Forwarded-For falsifié quand aucun proxy n'est de confiance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const app = makeApp({ global: 2 }, 0)
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "1.1.1.1")).status).toBe(401)
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "2.2.2.2")).status).toBe(401)
    // Un nouvel en-tête ne remet pas le compteur à zéro.
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "3.3.3.3")).status).toBe(429)
  })

  it("utilise l'IP fournie par un proxy de confiance quand TRUST_PROXY est défini", async () => {
    const app = makeApp({ global: 1 }, 1)
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "1.1.1.1")).status).toBe(401)
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "2.2.2.2")).status).toBe(401)
    expect((await request(app).get("/tickets").set("X-Forwarded-For", "1.1.1.1")).status).toBe(429)
  })

  it("ignore les entrées ajoutées à gauche de X-Forwarded-For par un client", async () => {
    // Un proxy de confiance ajoute l'IP réelle à DROITE ; tout ce qui est à gauche vient du client.
    const app = makeApp({ global: 1 }, 1)
    const get = (header: string) => request(app).get("/tickets").set("X-Forwarded-For", header)
    expect((await get("9.9.9.9, 1.1.1.1")).status).toBe(401)
    expect((await get("8.8.8.8, 1.1.1.1")).status).toBe(429)
    expect((await get("9.9.9.9, 2.2.2.2")).status).toBe(401)
  })

  it("regroupe les IPv6 d'un même réseau /56 mais pas celles de réseaux différents", async () => {
    const app = makeApp({ global: 1 }, 1)
    const get = (ip: string) => request(app).get("/tickets").set("X-Forwarded-For", ip)
    expect((await get("2001:db8:abcd:1200::1")).status).toBe(401)
    // Même /56 : adresse différente, même compteur.
    expect((await get("2001:db8:abcd:12ff::2")).status).toBe(429)
    // /56 différent : compteur distinct.
    expect((await get("2001:db8:abcd:1300::1")).status).toBe(401)
  })

  it("ne bloque pas un usage normal avec les limites par défaut", async () => {
    const app = createApp(prisma)
    for (let i = 0; i < 20; i++) {
      expect((await request(app).get("/tickets")).status).toBe(401)
    }
  })
})
