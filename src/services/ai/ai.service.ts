import type { PrismaClient } from "../../generated/prisma/client.js"
import type { AuthenticatedUser } from "../../middlewares/auth.js"
import { AI_MAX_PROPOSALS_PER_REQUEST, type ChatMessage } from "../../utils/validation.js"
import { ticketsService } from "../tickets/tickets.service.js"
import { SYSTEM_PROMPT, SYSTEM_PROMPT_WITH_ACTIONS, SYSTEM_PROMPT_WITH_TICKETS } from "./ai.prompt.js"
import { executeTicketTool, toolsFor, type Proposal, type TicketToolName } from "./ai.tools.js"

// Appel du fournisseur d'IA (OpenAI ou DeepSeek) avec l'API « Responses », que les deux documentent.
// Un seul point d'appel : si le format change, c'est ici et seulement ici qu'il faut intervenir.
// Ce service ne stocke rien (l'enregistrement des conversations est dans ai.conversations.service.ts) et ne journalise
// aucun contenu (messages, réponses, résultats d'outils, raisonnement, corps d'erreur du fournisseur) : seuls des
// messages fixes, sans contenu, sont écrits dans les logs.

// `declaresStrictFalse` : OpenAI documente `strict` sur les outils de l'API Responses, donc on écrit explicitement
// strict: false (les arguments sont validés côté serveur de toute façon). DeepSeek ne le documente pas pour ce format
// (strict n'existe que dans son mode bêta) : on omet le champ, ce qui revient au mode non strict.
const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", declaresStrictFalse: true },
  deepseek: { baseUrl: "https://api.deepseek.com", declaresStrictFalse: false },
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
  // Autoriser l'assistant à consulter les tickets (outils list_tickets et get_ticket). Désactivé par défaut :
  // activer cette option envoie au fournisseur le contenu des tickets que l'utilisateur a le droit de voir.
  ticketTools: boolean
  // Autoriser l'assistant à PROPOSER de créer un ticket ou d'en changer le statut. Exige ticketTools. Désactivé par défaut.
  // C'est aussi un coupe-circuit : désactivé, aucune confirmation n'est exécutée, même pour une action déjà en attente.
  ticketActions: boolean
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REPLY_CHARS = 6000
const MAX_PROVIDER_BODY_CHARS = 1_000_000

// Bornes de la boucle d'outils : elles limitent le coût, la durée et l'effet d'un modèle qui boucle.
export const MAX_PROVIDER_CALLS = 3 // appels au fournisseur par requête HTTP (au plus 2 tours d'outils, puis la réponse)
export const MAX_TOOL_CALLS_PER_ROUND = 4
const MAX_TOTAL_MS = 60_000
const MIN_CALL_BUDGET_MS = 1000
const MAX_OUTPUT_ITEMS = 50
const MAX_CALL_ID_CHARS = 64

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

  const ticketTools = env.AI_TICKET_TOOLS
  if (ticketTools && ticketTools !== "true" && ticketTools !== "false") {
    throw new Error("AI_TICKET_TOOLS doit valoir true ou false")
  }

  const ticketActions = env.AI_TICKET_ACTIONS
  if (ticketActions && ticketActions !== "true" && ticketActions !== "false") {
    throw new Error("AI_TICKET_ACTIONS doit valoir true ou false")
  }
  if (ticketActions === "true" && ticketTools !== "true") {
    throw new Error("AI_TICKET_ACTIONS=true exige AI_TICKET_TOOLS=true")
  }

  return {
    provider: provider as AiProvider,
    apiKey,
    model,
    baseUrl,
    maxOutputTokens: readInteger("AI_MAX_OUTPUT_TOKENS", env.AI_MAX_OUTPUT_TOKENS, 16, 8000, DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: readInteger("AI_TIMEOUT_MS", env.AI_TIMEOUT_MS, 5000, 120_000, DEFAULT_TIMEOUT_MS),
    reasoningEffort: (effort || undefined) as AiConfig["reasoningEffort"],
    ticketTools: ticketTools === "true",
    ticketActions: ticketActions === "true",
  }
}

// Construire la requête envoyée au fournisseur. La clé n'apparaît que dans l'en-tête Authorization.
// `input` est la conversation, suivie (pendant la boucle d'outils) des éléments renvoyés par le modèle et des
// résultats d'outils. Seuls les paramètres communs aux deux fournisseurs sont envoyés ; store: false demande de ne pas
// conserver la réponse côté OpenAI (DeepSeek ignore ce paramètre). Aucune donnée d'identité n'est transmise.
export function buildResponsesRequest(config: AiConfig, input: unknown[], user?: Pick<AuthenticatedUser, "role">) {
  return {
    url: `${config.baseUrl}/responses`,
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: {
      model: config.model,
      instructions: config.ticketActions ? SYSTEM_PROMPT_WITH_ACTIONS : config.ticketTools ? SYSTEM_PROMPT_WITH_TICKETS : SYSTEM_PROMPT,
      input,
      max_output_tokens: config.maxOutputTokens,
      store: false,
      ...(config.ticketTools && {
        tools: toolsFor(user, config.ticketActions).map((tool) => ({ ...tool, ...(PROVIDERS[config.provider].declaresStrictFalse && { strict: false }) })),
      }),
      ...(config.reasoningEffort && { reasoning: { effort: config.reasoningEffort } }),
    },
  }
}

type ProviderItem = { type: string; [key: string]: unknown }

// Éléments de sortie du modèle (messages, appels de fonctions, raisonnement...) ; null si la réponse est démesurée.
function outputItems(body: unknown): ProviderItem[] | null {
  const output = (body as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return []
  if (output.length > MAX_OUTPUT_ITEMS) return null
  return output.filter((item): item is ProviderItem => typeof item === "object" && item !== null && typeof item.type === "string")
}

function responseFailed(body: unknown) {
  if (typeof body !== "object" || body === null) return true
  const response = body as { status?: unknown; error?: unknown }
  return response.status === "failed" || response.status === "cancelled" || Boolean(response.error)
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

  // Pas de caractères de contrôle (sauf retour à la ligne et tabulation) : la réponse est enregistrée en base,
  // et PostgreSQL refuse l'octet NUL dans un texte.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
  if (text === "") return null
  const characters = [...text]
  return characters.length > MAX_REPLY_CHARS ? `${characters.slice(0, MAX_REPLY_CHARS).join("")}…` : text
}

// Les actions proposées par l'assistant sont-elles activées (AI_TICKET_ACTIONS) ? Une configuration invalide compte comme « non ».
export function aiActionsEnabled(env: Record<string, string | undefined> = process.env) {
  try {
    return parseAiConfig(env)?.ticketActions ?? false
  } catch {
    return false
  }
}

export type AiChatResult =
  // toolsUsed : outils exécutés avec succès par le serveur (sans doublon, dans l'ordre du premier usage).
  // Ni un simple appel proposé par le modèle, ni un appel refusé ou en erreur ; ce n'est pas une preuve que la réponse est exacte.
  // proposals : intentions d'action (jamais exécutées) que l'appelant enregistre « en attente » si la réponse aboutit.
  | { status: "OK"; reply: string; toolsUsed: TicketToolName[]; proposals: Proposal[] }
  | { status: "NOT_CONFIGURED" }
  | { status: "PROVIDER_FAILED" }

// Un échec : on journalise seulement une raison fixe (jamais de contenu) et le client reçoit un 502 générique.
function failed(reason: string): AiChatResult {
  console.error(`Assistant IA : ${reason}`)
  return { status: "PROVIDER_FAILED" }
}

// Un appel au fournisseur : renvoie la réponse décodée, ou null (déjà journalisé) en cas d'échec.
async function callProvider(config: AiConfig, input: unknown[], timeoutMs: number, user: AuthenticatedUser): Promise<unknown | null> {
  const request = buildResponsesRequest(config, input, user)
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
    if (!response.ok) {
      // Seul le code HTTP est journalisé : le corps d'erreur du fournisseur n'est ni lu ni conservé.
      console.error(`Assistant IA : le fournisseur a répondu HTTP ${response.status}`)
      return null
    }
    const text = await response.text()
    if (text.length > MAX_PROVIDER_BODY_CHARS) {
      console.error("Assistant IA : réponse du fournisseur trop volumineuse")
      return null
    }
    return JSON.parse(text)
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError"
    console.error(`Assistant IA : appel impossible (${timeout ? "délai dépassé" : "erreur réseau ou réponse illisible"})`)
    return null
  }
}

// Conversation avec le fournisseur d'IA, avec boucle d'outils de consultation des tickets si elle est activée.
export function aiService(prisma: PrismaClient) {
  const tickets = ticketsService(prisma)

  return {
    // proposalBudget : nombre maximal de propositions acceptées pour cette requête (le quota d'actions en attente restant).
    chat: async (messages: ChatMessage[], user: AuthenticatedUser, options: { proposalBudget?: number } = {}): Promise<AiChatResult> => {
      let config: AiConfig | null
      try {
        config = parseAiConfig(process.env)
      } catch (error) {
        console.error(`Assistant IA mal configuré : ${(error as Error).message}`)
        return { status: "NOT_CONFIGURED" }
      }
      if (!config) return { status: "NOT_CONFIGURED" }

      const startedAt = Date.now()
      const input: unknown[] = messages.map(({ role, content }) => ({ role, content }))
      const toolsUsed: TicketToolName[] = []
      const proposals: Proposal[] = []
      const proposalBudget = Math.min(options.proposalBudget ?? AI_MAX_PROPOSALS_PER_REQUEST, AI_MAX_PROPOSALS_PER_REQUEST)

      for (let attempt = 1; attempt <= MAX_PROVIDER_CALLS; attempt++) {
        const remaining = MAX_TOTAL_MS - (Date.now() - startedAt)
        if (remaining < MIN_CALL_BUDGET_MS) return failed("délai global dépassé")

        const body = await callProvider(config, input, Math.min(config.timeoutMs, remaining), user)
        if (body === null) return { status: "PROVIDER_FAILED" }
        const items = outputItems(body)
        if (items === null || responseFailed(body)) return failed("réponse du fournisseur inutilisable (échec ou démesurée)")

        const calls = items.filter((item) => item.type === "function_call")
        if (calls.length === 0) {
          const reply = extractReply(body)
          if (reply === null) return failed("réponse du fournisseur inutilisable (vide, ou plafond de tokens atteint avant le texte)")
          return { status: "OK", reply, toolsUsed, proposals }
        }

        // Le modèle propose des appels de fonctions. Plusieurs garde-fous AVANT d'exécuter quoi que ce soit :
        if (!config.ticketTools) return failed("le fournisseur demande un outil alors qu'aucun n'est déclaré")
        // Une réponse coupée par le plafond de tokens peut contenir des arguments tronqués : on n'exécute rien.
        if ((body as { status?: unknown }).status === "incomplete") {
          return failed("réponse incomplète pendant un appel d'outil : aucun outil exécuté")
        }
        // Dernier appel autorisé : exécuter des outils dont le résultat ne pourrait plus servir n'a pas de sens.
        if (attempt === MAX_PROVIDER_CALLS) return failed("limite d'appels d'outils atteinte sans réponse finale")
        const callIds = calls.map((call) => call.call_id)
        const validIds = callIds.every((id) => typeof id === "string" && id !== "" && id.length <= MAX_CALL_ID_CHARS)
        if (!validIds || new Set(callIds).size !== callIds.length) return failed("appels d'outils sans identifiant valide")

        // Rejouer TOUS les éléments de sortie dans l'ordre (appels, raisonnement...), tels quels : OpenAI (sans stockage)
        // et DeepSeek l'exigent pour que le modèle poursuive. Puis répondre à CHAQUE appel, même refusé :
        // un appel sans résultat correspondant est rejeté par le fournisseur.
        input.push(...items)
        for (const [index, call] of calls.entries()) {
          let output: string
          if (index >= MAX_TOOL_CALLS_PER_ROUND) {
            output = JSON.stringify({ ok: false, error: "trop d'appels d'outils dans le même tour" })
          } else {
            // L'utilisateur est celui du JWT, jamais une valeur donnée par le modèle.
            const execution = await executeTicketTool(call.name, call.arguments, user, tickets, { actions: config.ticketActions })
            output = execution.output
            let used = execution.tool
            if (execution.proposal) {
              // Une proposition n'écrit rien : on retient l'intention, dans la limite du quota, sans doublon.
              const key = JSON.stringify([execution.proposal.kind, execution.proposal.payload])
              if (proposals.length >= proposalBudget) {
                output = JSON.stringify({ ok: false, error: "trop d'actions proposées ou en attente : l'utilisateur doit d'abord confirmer ou annuler les précédentes" })
                used = null
              } else if (proposals.some((existing) => JSON.stringify([existing.kind, existing.payload]) === key)) {
                output = JSON.stringify({ ok: false, error: "cette action a déjà été proposée" })
                used = null
              } else {
                proposals.push(execution.proposal)
              }
            }
            if (used && !toolsUsed.includes(used)) toolsUsed.push(used)
          }
          input.push({ type: "function_call_output", call_id: call.call_id, output })
        }
      }
      return failed("limite d'appels au fournisseur atteinte")
    },
  }
}
