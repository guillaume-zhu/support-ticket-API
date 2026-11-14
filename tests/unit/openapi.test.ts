import { beforeAll, describe, expect, it } from "vitest"
import SwaggerParser from "@apidevtools/swagger-parser"
import { AuditAction, Role, TicketStatus, UserStatus } from "../../src/generated/prisma/enums.js"
import { openApiDocument } from "../../src/docs/openapi.js"
import { isApiDocsEnabled } from "../../src/routes/docs/index.js"
import { generateActionToken, isActionTokenFormat, isValidNewPassword } from "../../src/utils/credentials.js"
import { parseAuditLogQuery, parseId, parseText, parseTicketListQuery } from "../../src/utils/validation.js"
import { createSchemaValidator, listOperations, loadDereferencedContract, type DereferencedContract } from "../support/openapi.js"

let contract: DereferencedContract
beforeAll(async () => {
  contract = await loadDereferencedContract()
})

const schemas = () => contract.components.schemas

describe("Le contrat est un OpenAPI 3.1 valide", () => {
  it("passe le validateur officiel, $ref compris", async () => {
    await expect(SwaggerParser.validate(structuredClone(openApiDocument) as never)).resolves.toBeDefined()
    expect(openApiDocument.openapi).toBe("3.1.0")
  })

  it("n'utilise pas les idiomes d'OpenAPI 3.0 (nullable, example au singulier dans les schémas)", () => {
    const text = JSON.stringify(openApiDocument.components.schemas)
    expect(text).not.toContain('"nullable"')
    expect(text).not.toContain('"example"')
  })

  it("compile chaque schéma avec Ajv 2020-12 en mode strict", () => {
    const ajv = createSchemaValidator()
    for (const [name, schema] of Object.entries(schemas())) {
      expect(() => ajv.compile(schema), `schéma ${name}`).not.toThrow()
    }
  })
})

describe("Chaque opération est complète et décrit ses permissions", () => {
  it("a un operationId unique, un résumé et les réponses communes", () => {
    const operations = listOperations(contract)
    expect(operations).toHaveLength(15)
    const ids = operations.map(({ op }) => op.operationId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { method, path, op } of operations) {
      const label = `${method.toUpperCase()} ${path}`
      expect(op.summary, label).toBeTruthy()
      expect(op.responses["429"], label).toBeDefined()
      expect(op.responses["500"], label).toBeDefined()
      // Toute opération avec un body documente aussi le 413 (corps trop volumineux).
      if (op.requestBody) expect(op.responses["413"], label).toBeDefined()
    }
  })

  it("indique explicitement les rôles : sécurité Bearer, x-roles et phrase lisible", () => {
    for (const { method, path, op } of listOperations(contract)) {
      const label = `${method.toUpperCase()} ${path}`
      if (op["x-roles"].length === 0) {
        expect(op.security, label).toEqual([])
        expect(op.description, label).toContain("Accès** : public")
      } else {
        expect(op.security, label).toEqual([{ bearerAuth: [] }])
        expect(op.description, label).toContain(`Rôles autorisés** : ${op["x-roles"].join(", ")}`)
        expect(op.responses["401"], label).toBeDefined()
        // Une opération réservée à certains rôles documente le 403, sauf si tous les rôles sont autorisés.
        if (op["x-roles"].length < 4) expect(op.responses["403"], label).toBeDefined()
      }
      for (const role of op["x-roles"]) expect(Object.keys(Role)).toContain(role)
    }
  })
})

describe("Les valeurs du contrat correspondent au comportement réel du code", () => {
  it("reprend exactement les énumérations de la base", () => {
    expect(schemas().Role.enum).toEqual(Object.values(Role))
    expect(schemas().UserStatus.enum).toEqual(Object.values(UserStatus))
    expect(schemas().TicketStatus.enum).toEqual(Object.values(TicketStatus))
    expect(schemas().AuditAction.enum).toEqual(Object.values(AuditAction))
  })

  it("documente des limites que les validateurs réels appliquent vraiment", () => {
    const list = contract.paths["/tickets"]!.get!
    const param = (name: string) => list.parameters!.find((p) => p.name === name)!.schema as Record<string, any>

    // limit : le maximum documenté passe, le suivant est refusé
    const maxLimit = param("limit").maximum
    expect(parseTicketListQuery({ limit: String(maxLimit) }).ok).toBe(true)
    expect(parseTicketListQuery({ limit: String(maxLimit + 1) }).ok).toBe(false)
    expect(parseTicketListQuery({ limit: String(param("limit").minimum - 1) }).ok).toBe(false)
    // page
    const maxPage = param("page").maximum
    expect(parseTicketListQuery({ page: String(maxPage) }).ok).toBe(true)
    expect(parseTicketListQuery({ page: String(maxPage + 1) }).ok).toBe(false)
    // q
    const maxQ = param("q").maxLength
    expect(parseTicketListQuery({ q: "x".repeat(maxQ) }).ok).toBe(true)
    expect(parseTicketListQuery({ q: "x".repeat(maxQ + 1) }).ok).toBe(false)
    // sortBy, order, status : chaque valeur documentée est acceptée
    for (const sortBy of param("sortBy").enum) expect(parseTicketListQuery({ sortBy }).ok).toBe(true)
    for (const order of param("order").enum) expect(parseTicketListQuery({ order }).ok).toBe(true)
    for (const status of param("status").enum) expect(parseTicketListQuery({ status }).ok).toBe(true)
    // valeurs par défaut documentées
    expect(parseTicketListQuery({})).toMatchObject({
      ok: true,
      value: { page: param("page").default, limit: param("limit").default, sortBy: param("sortBy").default, order: param("order").default },
    })
    // journal d'audit
    for (const action of schemas().AuditAction.enum) expect(parseAuditLogQuery({ action }).ok).toBe(true)
    expect(parseAuditLogQuery({ action: "INCONNUE" }).ok).toBe(false)
  })

  it("documente des ids, titres et mots de passe cohérents avec les validateurs", () => {
    const idSchema = contract.paths["/tickets/{id}"]!.get!.parameters![0]!.schema as Record<string, any>
    expect(parseId(String(idSchema.maximum))).toBe(idSchema.maximum)
    expect(parseId(String(idSchema.maximum + 1))).toBeNull()
    expect(parseId(String(idSchema.minimum))).toBe(idSchema.minimum)
    expect(parseId(String(idSchema.minimum - 1))).toBeNull()

    const { title, description } = schemas().CreateTicketRequest.properties
    expect(parseText("x".repeat(title.maxLength), title.maxLength)).not.toBeNull()
    expect(parseText("x".repeat(title.maxLength + 1), title.maxLength)).toBeNull()
    expect(parseText("x".repeat(description.maxLength), description.maxLength, true)).not.toBeNull()

    const min = schemas().AcceptInvitationRequest.properties.password.minLength
    expect(isValidNewPassword("a".repeat(min))).toBe(true)
    expect(isValidNewPassword("a".repeat(min - 1))).toBe(false)

    // Un vrai code généré par l'API respecte le motif documenté, et inversement.
    const pattern = new RegExp(schemas().AcceptInvitationRequest.properties.token.pattern)
    const { token } = generateActionToken()
    expect(pattern.test(token)).toBe(true)
    expect(isActionTokenFormat("A".repeat(43))).toBe(pattern.test("A".repeat(43)))
    expect(isActionTokenFormat("A".repeat(42))).toBe(pattern.test("A".repeat(42)))
  })
})

describe("Les exemples du contrat sont fictifs et cohérents", () => {
  it("chaque exemple respecte le schéma qui le contient", () => {
    const ajv = createSchemaValidator()
    let checked = 0
    for (const [name, schema] of Object.entries(schemas())) {
      for (const example of schema.examples ?? []) {
        const validate = ajv.compile(schema)
        expect(validate(example), `exemple de ${name} : ${ajv.errorsText(validate.errors)}`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10)
  })

  it("ne contient aucun vrai jeton, code, hash ni secret", () => {
    const text = JSON.stringify(openApiDocument)
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/) // en-tête d'un JWT
    expect(text).not.toMatch(/argon2/i)
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/)
    // Toute longue chaîne base64url doit être un exemple manifestement factice (un seul caractère répété).
    for (const candidate of text.match(/[A-Za-z0-9_-]{30,}/g) ?? []) {
      if (!candidate.includes("-d-")) expect(new Set(candidate).size, candidate).toBeLessThanOrEqual(2)
    }
    // Seuls des domaines réservés aux exemples.
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(email).toMatch(/@example\.com$/)
    // Aucune valeur de secret de l'environnement de test n'a fuité dans le contrat.
    for (const name of ["ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET", "RESEND_API_KEY", "DATABASE_URL", "DATABASE_TEST_URL"]) {
      const value = process.env[name]
      if (value && value.length >= 8) expect(text, name).not.toContain(value)
    }
  })
})

describe("Réglage API_DOCS", () => {
  it("est actif par défaut hors production et inactif en production", () => {
    expect(isApiDocsEnabled(undefined, undefined)).toBe(true)
    expect(isApiDocsEnabled(undefined, "development")).toBe(true)
    expect(isApiDocsEnabled(undefined, "test")).toBe(true)
    expect(isApiDocsEnabled(undefined, "production")).toBe(false)
    expect(isApiDocsEnabled("", "production")).toBe(false)
  })

  it("peut être forcé dans les deux sens et refuse les valeurs ambiguës", () => {
    expect(isApiDocsEnabled("true", "production")).toBe(true)
    expect(isApiDocsEnabled("false", "development")).toBe(false)
    for (const bad of ["1", "yes", "TRUE", "oui"]) expect(() => isApiDocsEnabled(bad, undefined)).toThrow()
  })
})
