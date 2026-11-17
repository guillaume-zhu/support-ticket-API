import express from "express"
import type { PrismaClient } from "./generated/prisma/client.js"
import { handleError, notFound } from "./middlewares/errors.js"
import {
  createDisabledRateLimiters,
  createRateLimiters,
  DEFAULT_WINDOW_MS,
  defaultRateLimits,
  type RateLimits,
} from "./middlewares/rate-limit.js"
import { docsRoutes } from "./routes/docs/index.js"
import { registerRoutes } from "./routes/index.js"

export type AppOptions = {
  // Limites personnalisées, ou false pour désactiver la limitation (tests étrangers au rate limiting).
  rateLimits?: Partial<RateLimits> | false
  // Durée de la fenêtre de comptage (15 minutes par défaut ; réduite dans les tests d'expiration).
  rateLimitWindowMs?: number
  // Nombre de proxys de confiance devant l'application (0 = aucun).
  trustProxy?: number
  // Exposer /docs (Swagger UI) et /openapi.json. Désactivé par défaut : index.ts applique la règle API_DOCS.
  apiDocs?: boolean
}

// Construire l'application sans ouvrir de port, pour les tests HTTP.
export function createApp(prisma: PrismaClient, options: AppOptions = {}) {
  const app = express()
  app.set("trust proxy", options.trustProxy ?? 0)
  app.use(express.json({ limit: "100kb" }))

  // Limiteur global avant toute route : une requête bloquée n'atteint jamais un controller.
  const limiters =
    options.rateLimits === false
      ? createDisabledRateLimiters()
      : createRateLimiters(
          { ...defaultRateLimits, ...options.rateLimits },
          options.rateLimitWindowMs ?? DEFAULT_WINDOW_MS,
        )
  app.use(limiters.global)
  if (options.apiDocs) {
    app.use(docsRoutes())
  }
  registerRoutes(app, prisma, limiters)

  // L'ordre compte : routes, puis 404, puis gestionnaire d'erreurs en dernier.
  app.use(notFound)
  app.use(handleError)
  return app
}
