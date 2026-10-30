// Fonctions techniques sur les mots de passe et les codes à usage unique.
// Ce dossier ne dépend ni de Prisma, ni d'Express, ni des services, et ne contient aucune règle métier.
import * as argon2 from "argon2"
import { createHash, randomBytes } from "node:crypto"

// Hacher un mot de passe en Argon2id : mêmes paramètres pour tous les comptes
export function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
}

// Politique de mot de passe : 15 caractères minimum, 1024 octets maximum
export function isValidNewPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length >= 15 &&
    Buffer.byteLength(value, "utf8") <= 1024
  )
}

// Hacher un code à usage unique : seul ce hash est conservé en base
export function hashActionToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

// Générer un code à usage unique (32 octets en base64url, soit 43 caractères) et son hash
export function generateActionToken() {
  const token = randomBytes(32).toString("base64url")
  return { token, tokenHash: hashActionToken(token) }
}

// Format d'un code reçu : doit correspondre à generateActionToken
export function isActionTokenFormat(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
}
