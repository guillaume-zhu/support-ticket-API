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

export const CHAT_MAX_MESSAGES = 20
export const CHAT_MESSAGE_MAX_LENGTH = 2000
export const CHAT_TOTAL_MAX_LENGTH = 8000
export const CHAT_ROLES = ["user", "assistant"] as const

export type ChatMessage = { role: (typeof CHAT_ROLES)[number]; content: string }

// Valider le body de POST /ai/chat : { messages: [{ role, content }] }.
// Seuls les rôles « user » et « assistant » viennent du client : un message « system » (les règles de
// l'assistant) ou « tool » est refusé, car c'est le serveur qui écrit les règles. Les tailles bornent le coût.
export function parseChatBody(
  body: unknown,
): { ok: true; value: ChatMessage[] } | { ok: false; error: string } {
  const parsed = parseBody(body, ["messages"])
  if (!parsed.ok) return parsed

  const { messages } = parsed.value
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > CHAT_MAX_MESSAGES) {
    return { ok: false, error: `messages doit être une liste de 1 à ${CHAT_MAX_MESSAGES} messages` }
  }

  const result: ChatMessage[] = []
  let total = 0
  for (const [index, message] of messages.entries()) {
    const item = parseBody(message, ["role", "content"])
    if (!item.ok || message === null || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, error: `messages[${index}] invalide : { role, content } attendu` }
    }
    const { role, content } = item.value
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: `messages[${index}].role doit valoir user ou assistant` }
    }
    const text = parseText(content, CHAT_MESSAGE_MAX_LENGTH, true)
    if (text === null) {
      return {
        ok: false,
        error: `messages[${index}].content invalide (texte non vide de ${CHAT_MESSAGE_MAX_LENGTH} caractères maximum, sans caractères de contrôle)`,
      }
    }
    total += [...text].length
    result.push({ role, content: text })
  }

  if (total > CHAT_TOTAL_MAX_LENGTH) {
    return { ok: false, error: `la conversation dépasse ${CHAT_TOTAL_MAX_LENGTH} caractères au total` }
  }
  if (result[result.length - 1]!.role !== "user") {
    return { ok: false, error: "le dernier message doit venir de l'utilisateur (role user)" }
  }
  return { ok: true, value: result }
}
