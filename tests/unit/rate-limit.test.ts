import { describe, expect, it } from "vitest"
import type { Request } from "express"
import { byEmail, byIp, byIpAndEmail } from "../../src/middlewares/rate-limit.js"

const req = (ip: string | undefined, email?: unknown) => ({ ip, body: { email } }) as unknown as Request

describe("clés des limiteurs", () => {
  it("normalise l'email : casse et espaces ne changent pas la clé", () => {
    expect(byEmail(req("1.1.1.1", " Alice@Example.COM "))).toBe(byEmail(req("2.2.2.2", "alice@example.com")))
    expect(byIpAndEmail(req("1.1.1.1", "ALICE@example.com"))).toBe(byIpAndEmail(req("1.1.1.1", "alice@example.com ")))
  })

  it("sépare les IP et les emails différents", () => {
    expect(byIpAndEmail(req("1.1.1.1", "a@example.com"))).not.toBe(byIpAndEmail(req("1.1.1.2", "a@example.com")))
    expect(byIpAndEmail(req("1.1.1.1", "a@example.com"))).not.toBe(byIpAndEmail(req("1.1.1.1", "b@example.com")))
  })

  it("n'utilise jamais un email invalide, trop long ou non textuel dans une clé", () => {
    const huge = "x".repeat(100_000) + "@example.com"
    for (const bad of [huge, "pas-un-email", 42, null, undefined, { a: 1 }]) {
      expect(byIpAndEmail(req("1.1.1.1", bad))).toBe("1.1.1.1|invalide")
      expect(byEmail(req("1.1.1.1", bad))).toBe("ip:1.1.1.1")
    }
  })

  it("regroupe les IPv6 d'un même /56 et distingue les autres réseaux", () => {
    expect(byIp(req("2001:db8:abcd:1200::1"))).toBe(byIp(req("2001:db8:abcd:12ff:ffff::9")))
    expect(byIp(req("2001:db8:abcd:1200::1"))).not.toBe(byIp(req("2001:db8:abcd:1300::1")))
  })

  it("traite une IPv6 « mappée » IPv4 comme l'IPv4 correspondante", () => {
    expect(byIp(req("::ffff:1.2.3.4"))).toBe(byIp(req("1.2.3.4")))
  })

  it("ne plante pas sans IP", () => {
    expect(typeof byIp(req(undefined))).toBe("string")
  })
})
