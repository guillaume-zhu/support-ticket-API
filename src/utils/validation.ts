// Validation et normalisation des données reçues, sans dépendance à Prisma, Express ou aux services.

// Mettre un email au format de stockage (minuscules, sans espaces autour) ; "" si ce n'est pas du texte
export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

// Vérifier le format d'un email déjà normalisé (254 caractères maximum)
export function isValidEmail(email: string) {
  return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// Lire un identifiant numérique (entier sûr, 1 minimum) ; null s'il est invalide
export function parseId(value: unknown) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id >= 1 ? id : null
}

export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED"] as const
export const TICKET_SORT_FIELDS = ["id", "createdAt", "title", "status"] as const
export const TICKET_SEARCH_MAX_LENGTH = 100
const TICKET_LIST_PARAMS = ["page", "limit", "status", "q", "createdById", "sortBy", "order"]
const MAX_PAGE_SIZE = 100
const MAX_PAGE = 1_000_000

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

// Valider les paramètres de GET /tickets (valeurs par défaut incluses) ; renvoie une erreur lisible si invalide.
// Un paramètre inconnu, répété ou imbriqué (a[b]=1) est refusé.
export function parseTicketListQuery(
  query: Record<string, unknown>,
): { ok: true; value: TicketListOptions } | { ok: false; error: string } {
  // Refuser les paramètres inconnus : une faute de frappe (ex. "sort") ne doit pas être ignorée en silence.
  for (const name of Object.keys(query)) {
    if (!TICKET_LIST_PARAMS.includes(name)) {
      return { ok: false, error: `paramètre inconnu : ${name.slice(0, 50)}` }
    }
  }

  const raw: Record<string, string | undefined> = {}
  for (const name of TICKET_LIST_PARAMS) {
    const value = query[name]
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `paramètre ${name} invalide` }
    }
    raw[name] = value
  }

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
