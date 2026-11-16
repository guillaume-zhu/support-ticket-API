import { describe, expect, it } from "vitest"
import { buildContextWindow, deriveTitle } from "../../src/services/ai/ai.conversations.service.js"
import {
  CONVERSATION_CONTEXT_MAX_CHARS,
  CONVERSATION_CONTEXT_MAX_MESSAGES,
  CONVERSATION_RETENTION_DEFAULT_DAYS,
  CONVERSATION_TITLE_MAX_CHARS,
  parsePageQuery,
  parseRetentionDays,
  type ChatMessage,
} from "../../src/utils/validation.js"

const user = (content: string): ChatMessage => ({ role: "user", content })
const assistant = (content: string): ChatMessage => ({ role: "assistant", content })
// Historique numéroté : « m1 » est le plus ancien. Les rôles alternent en commençant par l'utilisateur.
const numbered = (count: number, size = 10): ChatMessage[] =>
  Array.from({ length: count }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: `m${index + 1}`.padEnd(size, ".") }))

describe("Fenêtre de contexte envoyée au fournisseur", () => {
  it("envoie tout quand la conversation est courte, le nouveau message en dernier", () => {
    const history = [user("Bonjour"), assistant("Salut")]
    expect(buildContextWindow(history, user("Et CLOSED ?"))).toEqual([...history, user("Et CLOSED ?")])
    expect(buildContextWindow([], user("Premier message"))).toEqual([user("Premier message")])
  })

  it("garde les 20 derniers messages au plus, nouveau message compris, du plus ancien au plus récent", () => {
    const history = numbered(60)
    const window = buildContextWindow(history, user("nouveau"))
    expect(window.length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_MESSAGES)
    expect(window.at(-1)).toEqual(user("nouveau"))
    // Les messages conservés sont les derniers de l'historique, dans l'ordre.
    const kept = window.slice(0, -1).map((message) => message.content)
    expect(kept).toEqual(history.slice(history.length - kept.length).map((message) => message.content))
  })

  it("commence toujours par un message de l'utilisateur", () => {
    for (let size = 1; size <= 45; size++) {
      const window = buildContextWindow(numbered(size), user("nouveau"))
      expect(window[0]!.role, `historique de ${size}`).toBe("user")
    }
  })

  it("respecte le budget de 12 000 caractères en écartant les messages les plus anciens", () => {
    const history = [user("a".repeat(1900)), assistant("b".repeat(6000)), user("c".repeat(1900)), assistant("d".repeat(6000)), user("e".repeat(100)), assistant("f".repeat(100))]
    const window = buildContextWindow(history, user("g".repeat(100)))
    const total = window.reduce((sum, message) => sum + [...message.content].length, 0)
    expect(total).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_CHARS)
    expect(window.map((message) => message.content[0])).toEqual(["c", "d", "e", "f", "g"]) // « a » et « b » sont écartés
    expect(window[0]!.role).toBe("user")
  })

  it("conserve le nouveau message même si l'historique est énorme, et retire un début d'assistant", () => {
    const history = [assistant("x".repeat(6000)), user("y".repeat(6000)), assistant("z".repeat(6000))]
    const window = buildContextWindow(history, user("n".repeat(2000)))
    expect(window.at(-1)!.content).toBe("n".repeat(2000))
    expect(window[0]!.role).toBe("user")
    expect(window.every((message, index) => index === 0 || window[index - 1] !== message)).toBe(true)
  })

  it("compte des caractères et non des octets", () => {
    const window = buildContextWindow([user("😀".repeat(5000)), assistant("😀".repeat(5000))], user("fin"))
    expect(window).toHaveLength(3) // 10 003 caractères : tout tient, même si c'est plus de 40 000 octets
  })

  it("ne modifie ni l'historique ni le nouveau message reçus", () => {
    const history = numbered(30)
    const copy = structuredClone(history)
    buildContextWindow(history, user("nouveau"))
    expect(history).toEqual(copy)
  })
})

describe("Titre d'une conversation", () => {
  it("reprend le début du premier message, sur une ligne", () => {
    expect(deriveTitle("  Que signifie\n le statut   IN_PROGRESS ?  ")).toBe("Que signifie le statut IN_PROGRESS ?")
  })

  it("coupe à 80 caractères avec une ellipse", () => {
    const title = deriveTitle("x".repeat(500))
    expect([...title]).toHaveLength(CONVERSATION_TITLE_MAX_CHARS)
    expect(title.endsWith("…")).toBe(true)
    expect(deriveTitle("x".repeat(CONVERSATION_TITLE_MAX_CHARS))).toBe("x".repeat(CONVERSATION_TITLE_MAX_CHARS))
    expect([...deriveTitle("😀".repeat(200))]).toHaveLength(CONVERSATION_TITLE_MAX_CHARS)
  })
})

describe("Durée de conservation (AI_CONVERSATION_RETENTION_DAYS)", () => {
  it("vaut 90 jours par défaut", () => {
    expect(CONVERSATION_RETENTION_DEFAULT_DAYS).toBe(90)
    expect(parseRetentionDays(undefined)).toBe(90)
    expect(parseRetentionDays("")).toBe(90)
  })

  it("accepte un nombre de jours entre 1 et 3650 et refuse le reste", () => {
    expect(parseRetentionDays("1")).toBe(1)
    expect(parseRetentionDays("30")).toBe(30)
    expect(parseRetentionDays("3650")).toBe(3650)
    for (const bad of ["0", "-5", "3651", "abc", "1.5", "1e2", " 30", "30 ", "090a", "99999"]) {
      expect(() => parseRetentionDays(bad), bad).toThrow("AI_CONVERSATION_RETENTION_DAYS")
    }
  })
})

describe("Pagination des conversations et des messages", () => {
  it("applique la limite par défaut propre à chaque liste", () => {
    expect(parsePageQuery({}, 20, 100)).toEqual({ ok: true, value: { page: 1, limit: 20 } })
    expect(parsePageQuery({}, 50, 100)).toEqual({ ok: true, value: { page: 1, limit: 50 } })
    expect(parsePageQuery({ page: "3", limit: "7" }, 20, 100)).toEqual({ ok: true, value: { page: 3, limit: 7 } })
  })

  it("refuse les valeurs invalides, les paramètres inconnus ou répétés", () => {
    for (const query of [{ page: "0" }, { page: "abc" }, { limit: "0" }, { limit: "101" }, { limit: "1.5" }, { sort: "asc" }, { page: ["1", "2"] }, { q: "x" }]) {
      expect(parsePageQuery(query, 20, 100).ok, JSON.stringify(query)).toBe(false)
    }
    expect(parsePageQuery({ limit: "100" }, 20, 100).ok).toBe(true)
  })
})
