import { describe, expect, it } from "vitest"
import { assertTestDatabase } from "../../scripts/test-database.js"

describe("garde-fou de la base de test", () => {
  const safe = "postgresql://support_ticket_test_runner:password@127.0.0.1:5433/support_ticket_test"

  it("accepte uniquement une base locale dédiée avec son rôle", () => {
    expect(assertTestDatabase(safe)).toBe(safe)
  })

  it.each([
    undefined,
    "postgresql://support_ticket_test_runner:password@127.0.0.1:5433/support_ticket",
    "postgresql://development_user@127.0.0.1:5433/support_ticket_test",
    "postgresql://support_ticket_test_runner:password@db.example.com:5433/support_ticket_test",
    "not a url",
  ])("refuse une configuration ambiguë ou dangereuse", (url) => {
    expect(() => assertTestDatabase(url)).toThrow()
  })
})
