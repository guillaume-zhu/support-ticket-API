import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import request from "supertest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient, type Role, type UserStatus } from "../../src/generated/prisma/client.js"
import { createApp } from "../../src/app.js"
import { openApiDocument } from "../../src/docs/openapi.js"
import { hashPassword } from "../../src/utils/credentials.js"
import { isEmailConfigured, sendEmail } from "../../src/services/shared/email.service.js"
import { assertTestDatabase } from "../../scripts/test-database.js"
import { createSchemaValidator, listOperations, loadDereferencedContract, type DereferencedContract } from "../support/openapi.js"

// Aucun appel Resend n'est autorisé pendant les tests.
vi.mock("../../src/services/shared/email.service.js", () => ({
  isEmailConfigured: vi.fn(() => true),
  sendEmail: vi.fn(async () => true),
}))

const url = assertTestDatabase(process.env.DATABASE_TEST_URL)
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const app = createApp(prisma, { rateLimits: false, apiDocs: true })

const PASSWORD = "mot-de-passe-pour-test"
const NEW_PASSWORD = "nouveau-mot-de-passe-pour-test"
const ROLES = ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] as const
let contract: DereferencedContract
let users: Record<Role, { id: number; email: string; token: string }>
const ajv = createSchemaValidator()
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>()

beforeAll(async () => {
  await prisma.$connect()
  contract = await loadDereferencedContract()
})
beforeEach(async () => {
  vi.mocked(sendEmail).mockReset()
  vi.mocked(isEmailConfigured).mockReset()
  await prisma.auditLog.deleteMany()
  await prisma.actionToken.deleteMany()
  await prisma.session.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.user.deleteMany()
  users = {} as typeof users
  for (const role of ROLES) users[role] = await createUser(role, "ACTIVE", role.toLowerCase())
})
afterAll(async () => {
  await prisma.$disconnect()
})

async function createUser(role: Role, status: UserStatus, name: string) {
  const email = `${name}@example.invalid`
  const user = await prisma.user.create({
    data: { email, role, status, ...(status !== "INVITED" && { passwordHash: await hashPassword(PASSWORD) }) },
  })
  return { id: user.id, email, token: status === "ACTIVE" ? await login(email) : "" }
}
async function login(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: PASSWORD })
  expect(response.status).toBe(200)
  return response.body.accessToken as string
}
const lastEmailedCode = () =>
  vi.mocked(sendEmail).mock.calls.at(-1)![0].text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/)![0]

// --- Cœur des tests : comparer une VRAIE réponse HTTP à ce que le contrat promet ---

const succeeded = new Set<string>()

function call(method: "get" | "post" | "patch", path: string, options: { token?: string; body?: object } = {}) {
  let req = request(app)[method](path)
  if (options.token) req = req.set("Authorization", `Bearer ${options.token}`)
  return options.body === undefined ? req : req.send(options.body)
}

// `template` est le chemin du contrat (ex. /tickets/{id}), `path` l'URL réellement appelée.
async function expectContract(
  pending: PromiseLike<request.Response>,
  method: "get" | "post" | "patch",
  template: string,
  status: number,
) {
  const response = await pending
  const label = `${method.toUpperCase()} ${template}`
  expect(response.status, `${label} : statut reçu ${response.status}, corps ${response.text.slice(0, 120)}`).toBe(status)

  const documented = contract.paths[template]?.[method]?.responses[String(status)]
  expect(documented, `${label} : le statut ${status} n'est pas documenté`).toBeDefined()

  if (!documented!.content) {
    // Réponse sans corps (204) : le contrat n'en décrit pas, l'API ne doit pas en envoyer.
    expect(response.text, `${label} : un corps est renvoyé alors que le contrat n'en décrit pas`).toBe("")
  } else {
    expect(response.headers["content-type"], label).toMatch(/application\/json/)
    const schema = documented!.content["application/json"]!.schema
    if (!validators.has(schema)) validators.set(schema, ajv.compile(schema))
    const validate = validators.get(schema)!
    expect(validate(response.body), `${label} ${status} : ${ajv.errorsText(validate.errors)}`).toBe(true)
  }
  if (status < 300) succeeded.add(`${method} ${template}`)
  return response
}

const bearer = (role: Role) => users[role].token
const newTicket = (role: Role = "USER", extra: object = {}) =>
  call("post", "/tickets", { token: bearer(role), body: { title: "Connexion impossible", description: "Erreur au login", ...extra } })

describe("Authentification : les réponses respectent le contrat", () => {
  it("login", async () => {
    await expectContract(call("post", "/auth/login", { body: { email: users.USER.email, password: PASSWORD } }), "post", "/auth/login", 200)
    await expectContract(call("post", "/auth/login", { body: {} }), "post", "/auth/login", 400)
    await expectContract(call("post", "/auth/login", { body: { email: users.USER.email, password: "mauvais" } }), "post", "/auth/login", 401)
    await expectContract(call("post", "/auth/login", { body: { email: "a@example.invalid", password: "x".repeat(101 * 1024) } }), "post", "/auth/login", 413)
  })

  it("refresh et logout (204 sans corps)", async () => {
    const tokens = (await call("post", "/auth/login", { body: { email: users.USER.email, password: PASSWORD } })).body
    const refreshed = await expectContract(call("post", "/auth/refresh", { body: { refreshToken: tokens.refreshToken } }), "post", "/auth/refresh", 200)
    await expectContract(call("post", "/auth/refresh", { body: {} }), "post", "/auth/refresh", 400)
    await expectContract(call("post", "/auth/refresh", { body: { refreshToken: tokens.refreshToken } }), "post", "/auth/refresh", 401)

    await expectContract(call("post", "/auth/logout", { body: { refreshToken: refreshed.body.refreshToken } }), "post", "/auth/logout", 204)
    await expectContract(call("post", "/auth/logout", { body: {} }), "post", "/auth/logout", 400)
    await expectContract(call("post", "/auth/logout", { body: { refreshToken: refreshed.body.refreshToken } }), "post", "/auth/logout", 401)
  })

  it("demande puis utilisation d'un code de réinitialisation", async () => {
    await expectContract(call("post", "/auth/request-password-reset", { body: { email: users.USER.email } }), "post", "/auth/request-password-reset", 202)
    await expectContract(call("post", "/auth/request-password-reset", { body: { email: "x" } }), "post", "/auth/request-password-reset", 400)
    vi.mocked(isEmailConfigured).mockReturnValueOnce(false)
    await expectContract(call("post", "/auth/request-password-reset", { body: { email: users.AGENT.email } }), "post", "/auth/request-password-reset", 503)

    const token = lastEmailedCode()
    await expectContract(call("post", "/auth/reset-password", { body: { token, password: NEW_PASSWORD } }), "post", "/auth/reset-password", 204)
    await expectContract(call("post", "/auth/reset-password", { body: { token, password: NEW_PASSWORD } }), "post", "/auth/reset-password", 400)
  })

  it("invitation puis activation du compte", async () => {
    const invited = await createUser("USER", "INVITED", "invite")
    await expectContract(call("post", `/users/${invited.id}/invitation`, { token: bearer("SUPER_ADMIN") }), "post", "/users/{id}/invitation", 202)
    const token = lastEmailedCode()
    await expectContract(call("post", "/auth/accept-invitation", { body: { token, password: NEW_PASSWORD } }), "post", "/auth/accept-invitation", 204)
    await expectContract(call("post", "/auth/accept-invitation", { body: { token, password: NEW_PASSWORD } }), "post", "/auth/accept-invitation", 400)
  })
})

describe("Comptes : les réponses respectent le contrat", () => {
  const sa = () => bearer("SUPER_ADMIN")

  it("création", async () => {
    await expectContract(call("post", "/users", { token: sa(), body: { email: "nouveau@example.invalid", role: "AGENT" } }), "post", "/users", 201)
    await expectContract(call("post", "/users", { token: sa(), body: { email: "nouveau@example.invalid", role: "AGENT" } }), "post", "/users", 409)
    await expectContract(call("post", "/users", { token: sa(), body: { email: "x", role: "AGENT" } }), "post", "/users", 400)
    await expectContract(call("post", "/users", { body: {} }), "post", "/users", 401)
    await expectContract(call("post", "/users", { token: bearer("AGENT"), body: {} }), "post", "/users", 403)
  })

  it("invitation : 400, 401, 403, 404, 409, 502 et 503", async () => {
    await expectContract(call("post", "/users/abc/invitation", { token: sa() }), "post", "/users/{id}/invitation", 400)
    await expectContract(call("post", "/users/1/invitation"), "post", "/users/{id}/invitation", 401)
    await expectContract(call("post", "/users/1/invitation", { token: bearer("ADMIN") }), "post", "/users/{id}/invitation", 403)
    await expectContract(call("post", "/users/999999/invitation", { token: sa() }), "post", "/users/{id}/invitation", 404)
    await expectContract(call("post", `/users/${users.USER.id}/invitation`, { token: sa() }), "post", "/users/{id}/invitation", 409)

    const invited = await createUser("USER", "INVITED", "invite")
    vi.mocked(sendEmail).mockResolvedValueOnce(false)
    await expectContract(call("post", `/users/${invited.id}/invitation`, { token: sa() }), "post", "/users/{id}/invitation", 502)
    vi.mocked(isEmailConfigured).mockReturnValueOnce(false)
    await expectContract(call("post", `/users/${invited.id}/invitation`, { token: sa() }), "post", "/users/{id}/invitation", 503)
  })

  it("désactivation et réactivation", async () => {
    const id = users.AGENT.id
    await expectContract(call("patch", `/users/${id}/disable`, { token: sa() }), "patch", "/users/{id}/disable", 200)
    await expectContract(call("patch", `/users/${id}/disable`, { token: sa() }), "patch", "/users/{id}/disable", 409)
    await expectContract(call("patch", "/users/999999/disable", { token: sa() }), "patch", "/users/{id}/disable", 404)
    await expectContract(call("patch", "/users/abc/disable", { token: sa() }), "patch", "/users/{id}/disable", 400)
    await expectContract(call("patch", `/users/${users.SUPER_ADMIN.id}/disable`, { token: sa() }), "patch", "/users/{id}/disable", 403)
    await expectContract(call("patch", `/users/${id}/disable`), "patch", "/users/{id}/disable", 401)

    await expectContract(call("patch", `/users/${id}/enable`, { token: sa() }), "patch", "/users/{id}/enable", 200)
    await expectContract(call("patch", `/users/${id}/enable`, { token: sa() }), "patch", "/users/{id}/enable", 409)
    await expectContract(call("patch", "/users/999999/enable", { token: sa() }), "patch", "/users/{id}/enable", 404)
    await expectContract(call("patch", "/users/abc/enable", { token: sa() }), "patch", "/users/{id}/enable", 400)
    await expectContract(call("patch", `/users/${id}/enable`, { token: bearer("USER") }), "patch", "/users/{id}/enable", 403)
    await expectContract(call("patch", `/users/${id}/enable`), "patch", "/users/{id}/enable", 401)
  })
})

describe("Tickets : les réponses respectent le contrat", () => {
  it("création et lecture", async () => {
    const created = await expectContract(newTicket("USER"), "post", "/tickets", 201)
    await expectContract(newTicket("USER", { title: " " }), "post", "/tickets", 400)
    await expectContract(call("post", "/tickets", { body: {} }), "post", "/tickets", 401)

    await expectContract(call("get", `/tickets/${created.body.id}`, { token: bearer("USER") }), "get", "/tickets/{id}", 200)
    await expectContract(call("get", "/tickets/abc", { token: bearer("USER") }), "get", "/tickets/{id}", 400)
    await expectContract(call("get", `/tickets/${created.body.id}`), "get", "/tickets/{id}", 401)
    await expectContract(call("get", "/tickets/999999", { token: bearer("USER") }), "get", "/tickets/{id}", 404)
    // Le ticket d'un autre : 404, comme documenté.
    const other = await createUser("USER", "ACTIVE", "autre")
    await expectContract(call("get", `/tickets/${created.body.id}`, { token: other.token }), "get", "/tickets/{id}", 404)
  })

  it("liste paginée, filtres, anciens tickets sans auteur", async () => {
    for (let i = 0; i < 3; i++) await newTicket("USER")
    await prisma.ticket.create({ data: { title: "Ancien", description: "Sans auteur" } }) // createdById null
    const page = await expectContract(call("get", "/tickets?limit=3&status=OPEN&sortBy=title&order=asc", { token: bearer("AGENT") }), "get", "/tickets", 200)
    expect(page.body.meta).toMatchObject({ page: 1, limit: 3, total: 4, totalPages: 2 })
    await expectContract(call("get", "/tickets?limit=3&page=2", { token: bearer("AGENT") }), "get", "/tickets", 200)
    await expectContract(call("get", "/tickets", { token: bearer("USER") }), "get", "/tickets", 200)
    await expectContract(call("get", "/tickets?page=0", { token: bearer("USER") }), "get", "/tickets", 400)
    await expectContract(call("get", "/tickets?inconnu=1", { token: bearer("USER") }), "get", "/tickets", 400)
    await expectContract(call("get", "/tickets"), "get", "/tickets", 401)
    await expectContract(call("get", `/tickets?createdById=${users.USER.id}`, { token: bearer("USER") }), "get", "/tickets", 403)
  })

  it("liste : un ticket sans auteur respecte le schéma (createdById null)", async () => {
    await prisma.ticket.create({ data: { title: "Ancien", description: "Sans auteur" } })
    const response = await expectContract(call("get", "/tickets", { token: bearer("AGENT") }), "get", "/tickets", 200)
    expect(response.body.data[0].createdById).toBeNull()
  })

  it("changement de statut", async () => {
    const id = (await newTicket("USER")).body.id
    await expectContract(call("patch", `/tickets/${id}/status`, { token: bearer("AGENT"), body: { status: "IN_PROGRESS" } }), "patch", "/tickets/{id}/status", 200)
    await expectContract(call("patch", `/tickets/${id}/status`, { token: bearer("AGENT"), body: { status: "NOPE" } }), "patch", "/tickets/{id}/status", 400)
    await expectContract(call("patch", `/tickets/${id}/status`, { body: { status: "OPEN" } }), "patch", "/tickets/{id}/status", 401)
    await expectContract(call("patch", `/tickets/${id}/status`, { token: bearer("USER"), body: { status: "CLOSED" } }), "patch", "/tickets/{id}/status", 403)
    await expectContract(call("patch", "/tickets/999999/status", { token: bearer("AGENT"), body: { status: "CLOSED" } }), "patch", "/tickets/{id}/status", 404)
  })
})

describe("Journal d'audit : les réponses respectent le contrat", () => {
  it("liste avec de vraies lignes, filtres et erreurs", async () => {
    const created = await call("post", "/users", { token: bearer("SUPER_ADMIN"), body: { email: "nouveau@example.invalid", role: "USER" } })
    await call("patch", `/users/${users.AGENT.id}/disable`, { token: bearer("SUPER_ADMIN") })

    const page = await expectContract(call("get", "/audit-logs", { token: bearer("SUPER_ADMIN") }), "get", "/audit-logs", 200)
    expect(page.body.data.map((row: { action: string }) => row.action)).toEqual(["USER_DISABLED", "USER_CREATED"])
    await expectContract(call("get", `/audit-logs?action=USER_CREATED&targetUserId=${created.body.id}`, { token: bearer("SUPER_ADMIN") }), "get", "/audit-logs", 200)
    await expectContract(call("get", "/audit-logs?action=HACK", { token: bearer("SUPER_ADMIN") }), "get", "/audit-logs", 400)
    await expectContract(call("get", "/audit-logs"), "get", "/audit-logs", 401)
    await expectContract(call("get", "/audit-logs", { token: bearer("ADMIN") }), "get", "/audit-logs", 403)
  })

  it("accepte aussi une ligne sans acteur ni cible (compte supprimé, script CLI)", async () => {
    await prisma.auditLog.create({ data: { action: "SUPER_ADMIN_BOOTSTRAPPED", actorId: null, actorRole: null, targetUserId: null, metadata: { source: "cli" } } })
    await prisma.auditLog.create({ data: { action: "USER_INVITATION_SEND_FAILED", actorId: null, actorRole: "SUPER_ADMIN", targetUserId: null } })
    const page = await expectContract(call("get", "/audit-logs", { token: bearer("SUPER_ADMIN") }), "get", "/audit-logs", 200)
    expect(page.body.data).toHaveLength(2)
  })
})

describe("Erreurs communes : 429 et 500 respectent le contrat", () => {
  it("429 avec Retry-After", async () => {
    const limited = createApp(prisma, { rateLimits: { global: 1 } })
    const first = await request(limited).get("/tickets")
    expect(first.status).toBe(401)
    const response = await request(limited).get("/tickets")
    expect(response.status).toBe(429)
    const documented = contract.paths["/tickets"]!.get!.responses["429"]!
    const validate = ajv.compile(documented.content!["application/json"]!.schema)
    expect(validate(response.body), ajv.errorsText(validate.errors)).toBe(true)
    for (const header of Object.keys(documented.headers!)) {
      expect(response.headers[header.toLowerCase()], `en-tête ${header} documenté mais absent`).toBeDefined()
    }
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0)
  })

  it("500 générique", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    // La liste lit dans une transaction : c'est elle qu'on fait échouer.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("panne de base"))
    await expectContract(call("get", "/tickets", { token: bearer("AGENT") }), "get", "/tickets", 500)
    spy.mockRestore()
  })
})

describe("Les rôles documentés sont les rôles réellement appliqués", () => {
  it("chaque opération autorise exactement les rôles de x-roles", async () => {
    const operations = listOperations(contract)
    expect(operations.length).toBe(15)
    for (const { method, path, op } of operations) {
      // Appel sans effet de bord : id inexistant, body vide (rejeté ou sans cible).
      const url = path.replace("{id}", "999999")
      const label = `${method.toUpperCase()} ${path}`
      const send = (token?: string) => call(method, url, { ...(token && { token }), ...(op.requestBody ? { body: {} } : {}) })

      const roles = op["x-roles"]
      if (roles.length === 0) {
        expect((await send()).status, `${label} public`).not.toBe(401)
      } else {
        expect((await send()).status, `${label} sans token`).toBe(401)
      }
      for (const role of ROLES) {
        const status = (await send(bearer(role))).status
        const allowed = roles.length === 0 || roles.includes(role)
        if (allowed) expect([401, 403], `${label} devrait être permis à ${role}, reçu ${status}`).not.toContain(status)
        else expect(status, `${label} devrait être interdit à ${role}`).toBe(403)
      }
    }
  })
})

describe("Couverture : chaque opération du contrat a été exercée", () => {
  // S'appuie sur les tests ci-dessus, exécutés dans l'ordre du fichier : chaque opération doit avoir
  // reçu au moins une vraie réponse de succès conforme au contrat. Une route documentée mais absente
  // (qui répondrait 404) est donc détectée ici.
  it("a obtenu une réponse de succès pour les 15 opérations", () => {
    const expected = listOperations(contract).map(({ method, path }) => `${method} ${path}`).sort()
    expect([...succeeded].sort()).toEqual(expected)
  })
})

describe("Inventaire : chaque route du code est documentée", () => {
  // Contrôle textuel simple et NON exhaustif, fondé sur les conventions du dépôt (un routeur par dossier,
  // `router.get("/...")`, montage dans routes/index.ts). Il attrape l'oubli le plus courant :
  // ajouter une route sans la documenter. Si la convention change, il échoue bruyamment.
  it("ne laisse aucune route sans documentation, ni documentation sans route", () => {
    const index = readFileSync("src/routes/index.ts", "utf8")
    const mounts = [...index.matchAll(/app\.use\("([^"]+)",\s*(\w+)Routes\(/g)].map((m) => ({ prefix: m[1]!, dir: m[2]! }))
    expect(mounts.length).toBeGreaterThanOrEqual(4)

    const found = mounts.flatMap(({ prefix, dir }) => {
      expect(readdirSync(`src/routes/${dir}`)).toContain("index.ts")
      const source = readFileSync(`src/routes/${dir}/index.ts`, "utf8")
      return [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)].map((m) => {
        const sub = m[2] === "/" ? "" : m[2]!.replace(/:(\w+)/g, "{$1}")
        return `${m[1]} ${prefix}${sub}`
      })
    })
    const documented = listOperations(contract).map(({ method, path }) => `${method} ${path}`)
    expect(found.sort()).toEqual(documented.sort())
  })
})

describe("Exposition de la documentation", () => {
  it("sert le contrat brut et Swagger UI quand elle est activée, sans authentification", async () => {
    const spec = await request(app).get("/openapi.json")
    expect(spec.status).toBe(200)
    expect(spec.headers["content-type"]).toMatch(/application\/json/)
    expect(spec.body).toEqual(JSON.parse(JSON.stringify(openApiDocument)))

    for (const path of ["/docs", "/docs/"]) {
      const page = await request(app).get(path).redirects(1)
      expect(page.status, path).toBe(200)
      expect(page.text, path).toContain("swagger-ui")
    }
    expect((await request(app).get("/docs/swagger-ui-init.js")).status).toBe(200)
  })

  it.each([
    ["désactivée explicitement", { apiDocs: false }],
    ["non demandée (réglage par défaut de createApp)", {}],
  ])("renvoie le 404 JSON habituel quand la documentation est %s", async (_label, options) => {
    const closed = createApp(prisma, { rateLimits: false, ...options })
    for (const path of ["/docs", "/docs/", "/openapi.json", "/docs/swagger-ui-init.js"]) {
      const response = await request(closed).get(path)
      expect(response.status, path).toBe(404)
      expect(response.body, path).toEqual({ error: "route introuvable" })
    }
    // Les vraies routes ne changent pas.
    expect((await request(closed).get("/tickets")).status).toBe(401)
  })

  it("reste sous le limiteur global et ne protège pas les vraies routes différemment", async () => {
    const limited = createApp(prisma, { rateLimits: { global: 2 }, apiDocs: true })
    expect((await request(limited).get("/openapi.json")).status).toBe(200)
    expect((await request(limited).get("/openapi.json")).status).toBe(200)
    expect((await request(limited).get("/openapi.json")).status).toBe(429)
  })
})
