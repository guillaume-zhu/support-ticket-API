// Validation et normalisation des données reçues, sans dépendance à Prisma, Express ou aux services.

// Mettre un email au format de stockage (minuscules, sans espaces autour) ; "" si ce n'est pas du texte
export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

// Caractères de contrôle (dont l'octet NUL, que PostgreSQL refuse dans un texte)
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/
// Idem, en tolérant tabulation et retours à la ligne (pour un texte sur plusieurs lignes)
const CONTROL_CHARS_EXCEPT_NEWLINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export const EMAIL_MAX_LENGTH = 254
export const TICKET_TITLE_MAX_LENGTH = 200
export const TICKET_DESCRIPTION_MAX_LENGTH = 5000

// Vérifier le format d'un email déjà normalisé (254 caractères maximum, sans espaces ni caractères de contrôle)
export function isValidEmail(email: string) {
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && /^[^\s@\u0000-\u001F\u007F]+@[^\s@\u0000-\u001F\u007F]+\.[^\s@\u0000-\u001F\u007F]+$/.test(email)
}

// Plus grand entier d'une colonne PostgreSQL de type Int (32 bits)
export const INT32_MAX = 2_147_483_647

// Lire un identifiant : entier décimal écrit sous sa forme canonique (pas de "1e2", "0x10", "012", "+5"),
// entre 1 et INT32_MAX pour correspondre aux colonnes Int ; null s'il est invalide
export function parseId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return null
  const id = Number(value)
  return id <= INT32_MAX ? id : null
}

// Lire un texte : sans espaces autour, non vide, longueur maximale en caractères, sans caractères de contrôle.
// Avec multiline, les retours à la ligne et tabulations sont permis. Renvoie null si le texte est invalide.
// Un texte qui ressemble à du SQL est valide : les requêtes Prisma sont paramétrées.
export function parseText(value: unknown, maxLength: number, multiline = false) {
  if (typeof value !== "string") return null
  const text = value.trim()
  const forbidden = multiline ? CONTROL_CHARS_EXCEPT_NEWLINES : CONTROL_CHARS
  if (text === "" || [...text].length > maxLength || forbidden.test(text)) return null
  return text
}

// Lire le body JSON d'une requête : un objet ne contenant que les champs autorisés de l'endpoint.
// Un champ inconnu est refusé (400) plutôt qu'ignoré ; l'absence de body équivaut à un objet vide.
export function parseBody(
  body: unknown,
  allowedFields: readonly string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, value: {} }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "corps JSON invalide : un objet est attendu" }
  }
  for (const name of Object.keys(body)) {
    if (!allowedFields.includes(name)) {
      return { ok: false, error: `champ inconnu : ${name.slice(0, 50)}` }
    }
  }
  return { ok: true, value: body as Record<string, unknown> }
}

export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED"] as const
export const TICKET_SORT_FIELDS = ["id", "createdAt", "title", "status"] as const
export const TICKET_SEARCH_MAX_LENGTH = 100
const TICKET_LIST_PARAMS = ["page", "limit", "status", "q", "createdById", "sortBy", "order"]
export const MAX_PAGE_SIZE = 100
export const MAX_PAGE = 1_000_000

export type TicketListOptions = {
  page: number
  limit: number
  status?: (typeof TICKET_STATUSES)[number] | undefined
  q?: string | undefined
  createdById?: number | undefined
  sortBy: (typeof TICKET_SORT_FIELDS)[number]
  order: "asc" | "desc"
}

// Lire un entier positif dans une valeur de query string ; undefined si absente, null si invalide
function parsePositiveInt(value: string | undefined, max: number) {
  if (value === undefined) return undefined
  if (!/^[0-9]{1,9}$/.test(value)) return null
  const number = Number(value)
  return number >= 1 && number <= max ? number : null
}

// Lire les paramètres d'une query string : refuse les paramètres inconnus, répétés (?a=1&a=2) ou imbriqués (a[b]=1).
function readQueryParams(
  query: Record<string, unknown>,
  allowedNames: readonly string[],
): { ok: true; raw: Record<string, string | undefined> } | { ok: false; error: string } {
  // Une faute de frappe (ex. "sort") ne doit pas être ignorée en silence.
  for (const name of Object.keys(query)) {
    if (!allowedNames.includes(name)) {
      return { ok: false, error: `paramètre inconnu : ${name.slice(0, 50)}` }
    }
  }
  const raw: Record<string, string | undefined> = {}
  for (const name of allowedNames) {
    const value = query[name]
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `paramètre ${name} invalide` }
    }
    raw[name] = value
  }
  return { ok: true, raw }
}

// Valider les paramètres de GET /tickets (valeurs par défaut incluses) ; renvoie une erreur lisible si invalide.
export function parseTicketListQuery(
  query: Record<string, unknown>,
): { ok: true; value: TicketListOptions } | { ok: false; error: string } {
  const params = readQueryParams(query, TICKET_LIST_PARAMS)
  if (!params.ok) return params
  const raw = params.raw

  const page = parsePositiveInt(raw.page, MAX_PAGE)
  if (page === null) return { ok: false, error: "page invalide" }
  const limit = parsePositiveInt(raw.limit, MAX_PAGE_SIZE)
  if (limit === null) return { ok: false, error: `limit invalide (1 à ${MAX_PAGE_SIZE})` }

  const status = raw.status
  if (status !== undefined && !(TICKET_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "status invalide" }
  }

  // Un q vide ou fait d'espaces équivaut à aucune recherche.
  const q = raw.q?.trim() || undefined
  if (q !== undefined && q.length > TICKET_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q trop long (${TICKET_SEARCH_MAX_LENGTH} caractères maximum)` }
  }
  if (q !== undefined && CONTROL_CHARS.test(q)) {
    return { ok: false, error: "q invalide (caractères de contrôle interdits)" }
  }

  let createdById: number | undefined
  if (raw.createdById !== undefined) {
    const id = parseId(raw.createdById)
    if (id === null) return { ok: false, error: "createdById invalide" }
    createdById = id
  }

  const sortBy = raw.sortBy ?? "createdAt"
  if (!(TICKET_SORT_FIELDS as readonly string[]).includes(sortBy)) {
    return { ok: false, error: "sortBy invalide" }
  }
  const order = raw.order ?? "desc"
  if (order !== "asc" && order !== "desc") return { ok: false, error: "order invalide" }

  return {
    ok: true,
    value: {
      page: page ?? 1,
      limit: limit ?? 20,
      status: status as TicketListOptions["status"],
      q,
      createdById,
      sortBy: sortBy as TicketListOptions["sortBy"],
      order,
    },
  }
}

// Neutraliser \, % et _ pour une recherche LIKE littérale (Prisma ne les échappe pas dans `contains`).
export function escapeLikePattern(text: string) {
  return text.replace(/[\\%_]/g, "\\$&")
}

export const AUDIT_ACTIONS = [
  "USER_CREATED",
  "USER_INVITATION_CREATED",
  "USER_INVITATION_SEND_FAILED",
  "USER_DISABLED",
  "USER_ENABLED",
  "INVITATION_ACCEPTED",
  "PASSWORD_RESET_COMPLETED",
  "SUPER_ADMIN_BOOTSTRAPPED",
  "ASSISTANT_TICKET_CREATED",
  "ASSISTANT_TICKET_STATUS_CHANGED",
] as const
const AUDIT_LIST_PARAMS = ["page", "limit", "action", "actorId", "targetUserId"]

export type AuditLogListOptions = {
  page: number
  limit: number
  action?: (typeof AUDIT_ACTIONS)[number] | undefined
  actorId?: number | undefined
  targetUserId?: number | undefined
}

// Valider les paramètres de GET /audit-logs (mêmes règles de pagination que les tickets).
export function parseAuditLogQuery(
  query: Record<string, unknown>,
): { ok: true; value: AuditLogListOptions } | { ok: false; error: string } {
  const params = readQueryParams(query, AUDIT_LIST_PARAMS)
  if (!params.ok) return params
  const raw = params.raw

  const page = parsePositiveInt(raw.page, MAX_PAGE)
  if (page === null) return { ok: false, error: "page invalide" }
  const limit = parsePositiveInt(raw.limit, MAX_PAGE_SIZE)
  if (limit === null) return { ok: false, error: `limit invalide (1 à ${MAX_PAGE_SIZE})` }

  const action = raw.action
  if (action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: "action invalide" }
  }
  const actorId = raw.actorId === undefined ? undefined : parseId(raw.actorId)
  if (actorId === null) return { ok: false, error: "actorId invalide" }
  const targetUserId = raw.targetUserId === undefined ? undefined : parseId(raw.targetUserId)
  if (targetUserId === null) return { ok: false, error: "targetUserId invalide" }

  return {
    ok: true,
    value: { page: page ?? 1, limit: limit ?? 20, action: action as AuditLogListOptions["action"], actorId, targetUserId },
  }
}

export const CHAT_MESSAGE_MAX_LENGTH = 2000
export const CHAT_ROLES = ["user", "assistant"] as const

export type ChatMessage = { role: (typeof CHAT_ROLES)[number]; content: string }

// Limites des conversations enregistrées (voir ai.conversations.service.ts)
export const CONVERSATION_CONTEXT_MAX_MESSAGES = 20 // messages envoyés au fournisseur, nouveau message compris
export const CONVERSATION_CONTEXT_MAX_CHARS = 12_000
export const CONVERSATION_MAX_PER_USER = 30
export const CONVERSATION_MAX_MESSAGES = 100
export const CONVERSATION_TITLE_MAX_CHARS = 80
export const CONVERSATION_RETENTION_DEFAULT_DAYS = 90

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Lire un identifiant de conversation (uuid en minuscules, tel que PostgreSQL le génère) ; null s'il est invalide.
export function parseConversationId(value: unknown) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null
}

// Valider le body de POST /ai/chat : { message, conversationId? }.
// Le client n'envoie QUE le texte de son nouveau message : l'historique, les rôles et les résultats d'outils viennent
// de la base et du serveur, jamais du client (impossible de fabriquer un faux message « assistant » ou « system »).
export function parseChatRequest(
  body: unknown,
): { ok: true; value: { message: string; conversationId: string | undefined } } | { ok: false; error: string } {
  const parsed = parseBody(body, ["message", "conversationId"])
  if (!parsed.ok) return parsed

  const message = parseText(parsed.value.message, CHAT_MESSAGE_MAX_LENGTH, true)
  if (message === null) {
    return {
      ok: false,
      error: `message invalide (texte non vide de ${CHAT_MESSAGE_MAX_LENGTH} caractères maximum, sans caractères de contrôle)`,
    }
  }

  const rawId = parsed.value.conversationId
  if (rawId === undefined || rawId === null) return { ok: true, value: { message, conversationId: undefined } }
  const conversationId = parseConversationId(rawId)
  if (conversationId === null) return { ok: false, error: "conversationId invalide (identifiant de conversation attendu)" }
  return { ok: true, value: { message, conversationId } }
}

// Valider page et limit d'une liste (même règles que les autres listes paginées de l'API).
export function parsePageQuery(
  query: Record<string, unknown>,
  defaultLimit: number,
  maxLimit: number,
): { ok: true; value: { page: number; limit: number } } | { ok: false; error: string } {
  const params = readQueryParams(query, ["page", "limit"])
  if (!params.ok) return params
  const page = parsePositiveInt(params.raw.page, MAX_PAGE)
  if (page === null) return { ok: false, error: "page invalide" }
  const limit = parsePositiveInt(params.raw.limit, maxLimit)
  if (limit === null) return { ok: false, error: `limit invalide (1 à ${maxLimit})` }
  return { ok: true, value: { page: page ?? 1, limit: limit ?? defaultLimit } }
}

// Lire AI_CONVERSATION_RETENTION_DAYS : nombre de jours d'inactivité avant la suppression d'une conversation.
export function parseRetentionDays(value: string | undefined) {
  if (value === undefined || value === "") return CONVERSATION_RETENTION_DEFAULT_DAYS
  const days = /^[0-9]{1,4}$/.test(value) ? Number(value) : NaN
  if (!(days >= 1 && days <= 3650)) throw new Error("AI_CONVERSATION_RETENTION_DAYS doit être un entier entre 1 et 3650")
  return days
}

// Actions proposées par l'assistant, à confirmer par l'utilisateur (voir ai.actions.service.ts)
export const AI_ACTION_TTL_MINUTES = 10 // au-delà, une action en attente est périmée : elle ne compte plus et ne peut plus être confirmée
export const AI_MAX_PENDING_PER_USER = 5 // actions en attente ET non périmées
export const AI_MAX_PROPOSALS_PER_REQUEST = 3
export const AI_ACTION_CLEANUP_GRACE_DAYS = 1 // le nettoyage quotidien supprime les actions périmées depuis plus de ce délai
export const AI_ACTION_KINDS = ["CREATE_TICKET", "CHANGE_STATUS"] as const

// Valider le body de POST /ai/actions/:id/confirm : { resolutionConfirmed?: boolean }.
export function parseConfirmBody(
  body: unknown,
): { ok: true; value: { resolutionConfirmed: boolean } } | { ok: false; error: string } {
  const parsed = parseBody(body, ["resolutionConfirmed"])
  if (!parsed.ok) return parsed
  const { resolutionConfirmed } = parsed.value
  if (resolutionConfirmed !== undefined && typeof resolutionConfirmed !== "boolean") {
    return { ok: false, error: "resolutionConfirmed doit être un booléen" }
  }
  return { ok: true, value: { resolutionConfirmed: resolutionConfirmed === true } }
}
