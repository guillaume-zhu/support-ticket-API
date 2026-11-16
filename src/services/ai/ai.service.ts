import type { ChatMessage } from "../../utils/validation.js"
import { SYSTEM_PROMPT } from "./ai.prompt.js"

// Appel du fournisseur d'IA (OpenAI ou DeepSeek) avec l'API « Responses », que les deux documentent.
// Un seul point d'appel : si le format change, c'est ici et seulement ici qu'il faut intervenir.
// Rien de ce qui est échangé (messages, réponses, corps d'erreur du fournisseur) n'est stocké ni journalisé.

const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
} as const
export type AiProvider = keyof typeof PROVIDERS

const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const

export type AiConfig = {
  provider: AiProvider
  apiKey: string
  model: string
  baseUrl: string
  // Plafond de TOUS les tokens générés, raisonnement compris : trop bas, un modèle qui raisonne
  // peut le consommer avant d'écrire la moindre réponse.
  maxOutputTokens: number
  timeoutMs: number
  reasoningEffort: (typeof REASONING_EFFORTS)[number] | undefined
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REPLY_CHARS = 6000
const MAX_PROVIDER_BODY_CHARS = 1_000_000

function readInteger(name: string, value: string | undefined, min: number, max: number, fallback: number) {
  if (value === undefined || value === "") return fallback
  const number = /^[0-9]{1,9}$/.test(value) ? Number(value) : NaN
  if (!(number >= min && number <= max)) throw new Error(`${name} doit être un entier entre ${min} et ${max}`)
  return number
}

// Lire la configuration dans l'environnement. Renvoie null si l'assistant n'est pas configuré (aucune variable
// principale renseignée) et lève une erreur si la configuration est incomplète ou invalide.
// Les messages d'erreur citent le NOM des variables, jamais leur valeur (la clé reste secrète).
export function parseAiConfig(env: Record<string, string | undefined>): AiConfig | null {
  const { AI_PROVIDER: provider, AI_API_KEY: apiKey, AI_MODEL: model } = env
  if (!provider && !apiKey && !model) return null
  if (!provider || !apiKey || !model) {
    throw new Error("Configuration IA incomplète : renseigner AI_PROVIDER, AI_API_KEY et AI_MODEL")
  }
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error("AI_PROVIDER doit valoir openai ou deepseek")
  if (!/^[\x21-\x7E]{8,512}$/.test(apiKey)) throw new Error("AI_API_KEY invalide (8 à 512 caractères, sans espace)")
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)) throw new Error("AI_MODEL invalide")

  // URL du fournisseur : celle du profil, ou une adresse https de remplacement (ex. région UE d'OpenAI).
  let baseUrl: string = PROVIDERS[provider as AiProvider].baseUrl
  if (env.AI_BASE_URL) {
    let url: URL
    try {
      url = new URL(env.AI_BASE_URL)
    } catch {
      throw new Error("AI_BASE_URL invalide")
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("AI_BASE_URL doit être une adresse https sans identifiants, paramètres ni ancre")
    }
    baseUrl = url.href.replace(/\/+$/, "")
  }

  const effort = env.AI_REASONING_EFFORT
  if (effort && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`AI_REASONING_EFFORT doit valoir ${REASONING_EFFORTS.join(", ")}`)
  }

  return {
    provider: provider as AiProvider,
    apiKey,
    model,
    baseUrl,
    maxOutputTokens: readInteger("AI_MAX_OUTPUT_TOKENS", env.AI_MAX_OUTPUT_TOKENS, 16, 8000, DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: readInteger("AI_TIMEOUT_MS", env.AI_TIMEOUT_MS, 5000, 120_000, DEFAULT_TIMEOUT_MS),
    reasoningEffort: (effort || undefined) as AiConfig["reasoningEffort"],
  }
}

// Construire la requête envoyée au fournisseur. La clé n'apparaît que dans l'en-tête Authorization.
// Seuls les paramètres communs aux deux fournisseurs sont envoyés ; store: false demande de ne pas conserver
// la réponse côté OpenAI (DeepSeek ignore ce paramètre). Aucune donnée d'identité n'est transmise.
export function buildResponsesRequest(config: AiConfig, messages: ChatMessage[]) {
  return {
    url: `${config.baseUrl}/responses`,
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: {
      model: config.model,
      instructions: SYSTEM_PROMPT,
      input: messages.map(({ role, content }) => ({ role, content })),
      max_output_tokens: config.maxOutputTokens,
      store: false,
      ...(config.reasoningEffort && { reasoning: { effort: config.reasoningEffort } }),
    },
  }
}

// Extraire le texte de la réponse du fournisseur ; null si elle est inutilisable.
// Une réponse « incomplete » est acceptée si elle contient du texte (plafond de tokens atteint en cours de rédaction).
export function extractReply(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const response = body as { status?: unknown; error?: unknown; output?: unknown; output_text?: unknown }
  if (response.status === "failed" || response.status === "cancelled" || response.error) return null

  let text = ""
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text
      }
    }
  }
  if (text === "" && typeof response.output_text === "string") text = response.output_text

  text = text.trim()
  if (text === "") return null
  const characters = [...text]
  return characters.length > MAX_REPLY_CHARS ? `${characters.slice(0, MAX_REPLY_CHARS).join("")}…` : text
}

export type AiChatResult =
  | { status: "OK"; reply: string }
  | { status: "NOT_CONFIGURED" }
  | { status: "PROVIDER_FAILED" }

// Envoyer la conversation au fournisseur et renvoyer sa réponse.
export function aiService() {
  return {
    chat: async (messages: ChatMessage[]): Promise<AiChatResult> => {
      let config: AiConfig | null
      try {
        config = parseAiConfig(process.env)
      } catch (error) {
        console.error(`Assistant IA mal configuré : ${(error as Error).message}`)
        return { status: "NOT_CONFIGURED" }
      }
      if (!config) return { status: "NOT_CONFIGURED" }

      const request = buildResponsesRequest(config, messages)
      try {
        const response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: "error",
        })
        if (!response.ok) {
          // Seul le code HTTP est journalisé : le corps d'erreur du fournisseur n'est ni lu ni conservé.
          console.error(`Assistant IA : le fournisseur a répondu HTTP ${response.status}`)
          return { status: "PROVIDER_FAILED" }
        }

        const text = await response.text()
        if (text.length > MAX_PROVIDER_BODY_CHARS) {
          console.error("Assistant IA : réponse du fournisseur trop volumineuse")
          return { status: "PROVIDER_FAILED" }
        }
        const reply = extractReply(JSON.parse(text))
        if (reply === null) {
          console.error("Assistant IA : réponse du fournisseur inutilisable (vide, échec, ou plafond de tokens atteint avant le texte)")
          return { status: "PROVIDER_FAILED" }
        }
        return { status: "OK", reply }
      } catch (error) {
        const timeout = error instanceof Error && error.name === "TimeoutError"
        console.error(`Assistant IA : appel impossible (${timeout ? "délai dépassé" : "erreur réseau ou réponse illisible"})`)
        return { status: "PROVIDER_FAILED" }
      }
    },
  }
}
