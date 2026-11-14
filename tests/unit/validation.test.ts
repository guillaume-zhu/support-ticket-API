import { describe, expect, it } from "vitest"
import { isValidEmail, normalizeEmail, parseId } from "../../src/utils/validation.js"
import { isActionTokenFormat, isValidNewPassword, generateActionToken, hashActionToken, hashPassword } from "../../src/utils/credentials.js"
import { parseSubjectId } from "../../src/utils/jwt.js"
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
