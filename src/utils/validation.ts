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
