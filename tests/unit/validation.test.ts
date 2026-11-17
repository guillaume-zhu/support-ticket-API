import { describe, expect, it } from "vitest"
import { escapeLikePattern, isValidEmail, normalizeEmail, parseBody, parseId, parseText, parseTicketListQuery } from "../../src/utils/validation.js"
import { isActionTokenFormat, isValidNewPassword, generateActionToken, hashActionToken, hashPassword } from "../../src/utils/credentials.js"
import { parseSubjectId } from "../../src/utils/jwt.js"
import { parseTrustProxy } from "../../src/middlewares/rate-limit.js"
import * as argon2 from "argon2"

describe("validation des valeurs réutilisables", () => {
  it("normalise les emails et rejette les formats invalides", () => {
    expect(normalizeEmail("  TEST@Example.COM ")).toBe("test@example.com")
    expect(normalizeEmail(42)).toBe("")
    expect(isValidEmail("test@example.com")).toBe(true)
    expect(isValidEmail("sans-arobase")).toBe(false)
    expect(isValidEmail("x".repeat(255) + "@example.com")).toBe(false)
  })

  it("accepte seulement les identifiants entiers positifs sûrs", () => {
    expect(parseId("12")).toBe(12)
    expect(parseId("0")).toBeNull()
    expect(parseId("1.5")).toBeNull()
    expect(parseId("Infinity")).toBeNull()
    expect(parseId("9007199254740992")).toBeNull()
    expect(parseId("2147483647")).toBe(2147483647)
    for (const bad of ["2147483648", "99999999999", "1e2", "0x10", "012", "+5", "5.0", " 12", "12 ", "", "-1", "٣"]) {
      expect(parseId(bad)).toBeNull()
    }
    expect(parseId(12)).toBeNull() // seule une chaîne d'URL ou de JWT est attendue
    expect(parseSubjectId("12")).toBe(12)
    expect(parseSubjectId("012")).toBeNull()
    expect(parseSubjectId("1.0")).toBeNull()
  })

  it("valide longueur et taille des mots de passe", () => {
    expect(isValidNewPassword("a".repeat(15))).toBe(true)
    expect(isValidNewPassword("a".repeat(14))).toBe(false)
    expect(isValidNewPassword("😀".repeat(300))).toBe(false)
    expect(isValidNewPassword(null)).toBe(false)
  })
})

describe("codes et mots de passe", () => {
  it("génère un code aléatoire dont seul le hash est stockable", () => {
    const first = generateActionToken()
    const second = generateActionToken()
    expect(isActionTokenFormat(first.token)).toBe(true)
    expect(isActionTokenFormat(first.tokenHash)).toBe(false)
    expect(first.tokenHash).toBe(hashActionToken(first.token))
    expect(first.token).not.toBe(second.token)
    expect(isActionTokenFormat("x".repeat(42))).toBe(false)
  })

  it("produit un hash Argon2id vérifiable", async () => {
    const hash = await hashPassword("un-mot-de-passe-long")
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(await argon2.verify(hash, "un-mot-de-passe-long")).toBe(true)
    expect(await argon2.verify(hash, "mauvais-mot-de-passe")).toBe(false)
  })
})

describe("validation de la query de GET /tickets", () => {
  const invalid = (query: Record<string, unknown>) => parseTicketListQuery(query).ok

  it("applique les valeurs par défaut", () => {
    expect(parseTicketListQuery({})).toEqual({
      ok: true,
      value: { page: 1, limit: 20, sortBy: "createdAt", order: "desc" },
    })
  })

  it("accepte des paramètres valides", () => {
    const result = parseTicketListQuery({
      page: "2", limit: "100", status: "OPEN", q: "  connexion ", createdById: "7", sortBy: "title", order: "asc",
    })
    expect(result).toEqual({
      ok: true,
      value: { page: 2, limit: 100, status: "OPEN", q: "connexion", createdById: 7, sortBy: "title", order: "asc" },
    })
  })

  it("rejette page et limit hors bornes ou non numériques", () => {
    for (const bad of [{ page: "0" }, { page: "-1" }, { page: "abc" }, { page: "1.5" }, { page: "1e3" }, { page: "9999999" }]) {
      expect(invalid(bad)).toBe(false)
    }
    for (const bad of [{ limit: "0" }, { limit: "101" }, { limit: "abc" }, { limit: "" }]) {
      expect(invalid(bad)).toBe(false)
    }
  })

  it("rejette status, sortBy, order et createdById invalides", () => {
    for (const bad of [{ status: "open" }, { status: "DONE" }, { sortBy: "description" }, { sortBy: "id; DROP TABLE" },
      { order: "ASC" }, { order: "up" }, { createdById: "0" }, { createdById: "x" }]) {
      expect(invalid(bad)).toBe(false)
    }
  })

  it("rejette les paramètres inconnus, même mêlés à des paramètres valides", () => {
    expect(parseTicketListQuery({ sort: "title" })).toEqual({ ok: false, error: "paramètre inconnu : sort" })
    expect(invalid({ page: "1", foo: "bar" })).toBe(false)
    expect(invalid({ "a": { b: "1" } })).toBe(false)
  })

  it("rejette les paramètres répétés ou imbriqués", () => {
    expect(invalid({ status: ["OPEN", "CLOSED"] })).toBe(false)
    expect(invalid({ q: { a: "b" } })).toBe(false)
  })

  it("traite un q vide comme absent et limite sa longueur", () => {
    expect(parseTicketListQuery({ q: "   " })).toMatchObject({ ok: true, value: { q: undefined } })
    expect(invalid({ q: "x".repeat(100) })).toBe(true)
    expect(invalid({ q: "x".repeat(101) })).toBe(false)
  })

  it("échappe \\, % et _ pour une recherche LIKE littérale", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b")
    expect(escapeLikePattern("simple")).toBe("simple")
  })
})

describe("lecture de TRUST_PROXY", () => {
  it("vaut 0 par défaut et accepte un petit entier", () => {
    expect(parseTrustProxy(undefined)).toBe(0)
    expect(parseTrustProxy("")).toBe(0)
    expect(parseTrustProxy("1")).toBe(1)
  })

  it("refuse les valeurs ambiguës", () => {
    for (const bad of ["true", "-1", "1.5", "loopback", "100"]) {
      expect(() => parseTrustProxy(bad)).toThrow()
    }
  })
})

describe("validation de texte, d'email et de body", () => {
  it("rejette les caractères de contrôle dans un email", () => {
    expect(isValidEmail("a\u0000@example.com")).toBe(false)
    expect(isValidEmail("a\u001f@example.com")).toBe(false)
    expect(isValidEmail("a'--@example.com")).toBe(true) // ressemble à du SQL mais reste un email bien formé
  })

  it("valide un texte : trim, non vide, longueur, caractères de contrôle", () => {
    expect(parseText("  Bonjour  ", 200)).toBe("Bonjour")
    expect(parseText("   ", 200)).toBeNull()
    expect(parseText(42, 200)).toBeNull()
    expect(parseText("x".repeat(200), 200)).not.toBeNull()
    expect(parseText("x".repeat(201), 200)).toBeNull()
    expect(parseText("😀".repeat(200), 200)).not.toBeNull() // compte des caractères, pas des octets
    expect(parseText("a\u0000b", 200)).toBeNull()
    expect(parseText("a\nb", 200)).toBeNull()
    expect(parseText("a\nb\tc", 200, true)).toBe("a\nb\tc")
    expect(parseText("a\u0000b", 200, true)).toBeNull()
  })

  it("accepte du SQL comme texte ordinaire", () => {
    const sql = `'; DROP TABLE "Ticket"; --`
    expect(parseText(sql, 200)).toBe(sql)
  })

  it("lit un body en refusant champs inconnus, tableaux et valeurs non objet", () => {
    expect(parseBody(undefined, ["a"])).toEqual({ ok: true, value: {} })
    expect(parseBody({ a: 1 }, ["a", "b"])).toEqual({ ok: true, value: { a: 1 } })
    expect(parseBody({ a: 1, c: 2 }, ["a"])).toEqual({ ok: false, error: "champ inconnu : c" })
    expect(parseBody({ x: 1 }, [])).toEqual({ ok: false, error: "champ inconnu : x" })
    expect(parseBody([], ["a"]).ok).toBe(false)
    expect(parseBody("texte", ["a"]).ok).toBe(false)
    expect(parseBody(JSON.parse('{"__proto__":{"admin":true}}'), ["a"]).ok).toBe(false)
  })

  it("refuse un caractère de contrôle dans q", () => {
    expect(parseTicketListQuery({ q: "a\u0000b" }).ok).toBe(false)
    expect(parseTicketListQuery({ q: "DROP TABLE" }).ok).toBe(true)
  })
})
