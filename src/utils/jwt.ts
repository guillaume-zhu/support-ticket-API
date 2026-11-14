import { parseId } from "./validation.js"

// Constantes et lecture des clés communes à la création des JWT (auth.service)
// et à leur vérification (middleware d'authentification).
export const JWT_ISSUER = "support-ticket-api"
export const JWT_AUDIENCE = "support-ticket-api"

// Taille maximale acceptée pour un JWT reçu (les nôtres font environ 350 caractères) :
// évite de traiter inutilement des chaînes énormes
export const MAX_JWT_LENGTH = 2048

// Durée de l'access token : sert à le signer ET à refuser un token trop ancien (maxTokenAge)
export const ACCESS_TOKEN_LIFETIME = "15m"

// Lire une clé de signature depuis l'environnement (32 octets aléatoires en base64url)
export function jwtKey(name: string): Buffer {
  const encoded = process.env[name]
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  const key = Buffer.from(encoded, "base64url")
  if (key.length !== 32) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  return key
}

// Lire l'id utilisateur du champ "sub" ; null s'il est invalide ou pas sous sa forme exacte
// (refuse par exemple "01" ou "1.0", qui désigneraient le même compte sous un autre texte)
export function parseSubjectId(sub: string) {
  const userId = parseId(sub)
  return userId !== null && String(userId) === sub ? userId : null
}
