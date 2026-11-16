import type { Request, RequestHandler, Response } from "express"
import { ipKeyGenerator, rateLimit } from "express-rate-limit"
import { isValidEmail, normalizeEmail } from "../utils/validation.js"
import type { AuthenticatedUser } from "./auth.js"

export const DEFAULT_WINDOW_MS = 15 * 60 * 1000

// Nombre maximum de requêtes par fenêtre de 15 minutes. Modifiable ici, en un seul endroit.
export const defaultRateLimits = {
  global: 1000, // toutes les routes, par IP
  loginPerIp: 60, // tentatives de login (réussies ou non), par IP
  loginFailuresPerIpAndEmail: 5, // échecs d'authentification (401), par IP et par email
  passwordResetPerIp: 5, // demandes d'email de réinitialisation, par IP
  passwordResetPerEmail: 3, // demandes d'email de réinitialisation, par adresse (toutes IP confondues)
  codesPerIp: 10, // reset-password + accept-invitation (devinette de codes), quota partagé par IP
  refreshPerIp: 30,
  aiPerUser: 30, // questions à l'assistant, par utilisateur connecté
  aiGlobal: 300, // questions à l'assistant, tous utilisateurs confondus : borne la dépense en cas d'abus
}
export type RateLimits = typeof defaultRateLimits

type KeyGenerator = (req: Request) => string
// Une clé peut aussi lire la réponse, où `authenticate` a placé l'identité (res.locals.authUser).
type LimiterKey = (req: Request, res: Response) => string

// Identifier l'appelant par son IP. ipKeyGenerator regroupe les IPv6 d'un même réseau (/56) :
// sans cela, un attaquant IPv6 changerait d'adresse à chaque requête pour contourner la limite.
// req.ip dépend du réglage "trust proxy" : X-Forwarded-For n'est lu que pour les proxys déclarés.
export const byIp: KeyGenerator = (req) => ipKeyGenerator(req.ip ?? "")

// Identifier l'appelant par son compte : la clé vient du JWT validé par `authenticate` (jamais du client).
// Sans compte (cas qui ne doit pas arriver après authenticate), on retombe sur l'IP.
export const byUser: LimiterKey = (req, res) => {
  const user = res.locals.authUser as AuthenticatedUser | undefined
  return user ? `user:${user.id}` : `ip:${byIp(req)}`
}

// Clé unique : tous les appels à l'assistant partagent un même compteur.
const allAiCalls: LimiterKey = () => "assistant"

// Email normalisé comme le fait le login (minuscules, sans espaces) ; null s'il est invalide.
// Un email invalide ou énorme n'est jamais utilisé dans une clé : le body peut peser 100 Ko
// et chaque clé reste en mémoire pendant toute la fenêtre.
function keyEmail(req: Request) {
  const email = normalizeEmail(req.body?.email)
  return isValidEmail(email) ? email : null
}

export const byEmail: KeyGenerator = (req) => {
  const email = keyEmail(req)
  return email === null ? `ip:${byIp(req)}` : `email:${email}`
}
export const byIpAndEmail: KeyGenerator = (req) => `${byIp(req)}|${keyEmail(req) ?? "invalide"}`

// Créer un limiteur : au-delà de `limit` requêtes par fenêtre, répondre 429 avant d'atteindre le controller.
// Avec countOnly401, seuls les vrais échecs d'authentification (401) consomment le quota :
// ni les succès, ni les 400 de validation, ni les erreurs 500 ne comptent.
function limiter(
  limit: number,
  keyGenerator: LimiterKey,
  windowMs: number,
  countOnly401 = false,
): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests: countOnly401,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: "draft-7", // RateLimit-* et Retry-After
    legacyHeaders: false,
    message: { error: "trop de requêtes, réessayez plus tard" },
  })
}

// Les compteurs sont gardés en mémoire dans chaque jeu de limiteurs : ils sont perdus au redémarrage
// et ne sont pas partagés entre plusieurs processus.
export function createRateLimiters(limits: RateLimits = defaultRateLimits, windowMs = DEFAULT_WINDOW_MS) {
  return {
    global: limiter(limits.global, byIp, windowMs),
    login: [
      limiter(limits.loginPerIp, byIp, windowMs),
      limiter(limits.loginFailuresPerIpAndEmail, byIpAndEmail, windowMs, true),
    ],
    // Compromis : le quota par adresse protège la boîte mail d'une victime (et le quota Resend) contre
    // un envoi en rafale depuis plusieurs IP, mais un tiers peut empêcher cette adresse de demander
    // un nouveau code pendant au plus une fenêtre. Ce blocage est temporaire (le compteur repart à zéro
    // à la fin de la fenêtre), ne touche ni le login ni un code déjà reçu, et ne révèle pas si le compte existe.
    passwordReset: [
      limiter(limits.passwordResetPerIp, byIp, windowMs),
      limiter(limits.passwordResetPerEmail, byEmail, windowMs),
    ],
    codes: limiter(limits.codesPerIp, byIp, windowMs),
    refresh: limiter(limits.refreshPerIp, byIp, windowMs),
    // Chaque appel à l'assistant est facturé par le fournisseur : un quota par utilisateur, puis un plafond global.
    ai: [limiter(limits.aiPerUser, byUser, windowMs), limiter(limits.aiGlobal, allAiCalls, windowMs)],
  }
}
export type RateLimiters = ReturnType<typeof createRateLimiters>

// Désactivé pour les tests qui ne portent pas sur la limitation de débit.
export function createDisabledRateLimiters(): RateLimiters {
  const pass: RequestHandler = (_req, _res, next) => next()
  return { global: pass, login: [pass], passwordReset: [pass], codes: pass, refresh: pass, ai: [pass] }
}

// Lire TRUST_PROXY : nombre de proxys de confiance devant l'application (0 par défaut).
// Seul un nombre est accepté (jamais "true") : avec N proxys, Express lit l'IP en partant de la droite
// de X-Forwarded-For, donc les entrées ajoutées à gauche par un client sont ignorées.
export function parseTrustProxy(value: string | undefined) {
  if (value === undefined || value === "") return 0
  if (!/^[0-9]{1,2}$/.test(value)) {
    throw new Error("TRUST_PROXY doit être un entier entre 0 et 99")
  }
  return Number(value)
}
