import express from "express"
import type { PrismaClient } from "./generated/prisma/client.js"
import { handleError, notFound } from "./middlewares/errors.js"
import { registerRoutes } from "./routes/index.js"

// Construire l'application sans ouvrir de port, pour les tests HTTP.
export function createApp(prisma: PrismaClient) {
  const app = express()
  app.use(express.json({ limit: "100kb" }))
  registerRoutes(app, prisma)

  // L'ordre compte : routes, puis 404, puis gestionnaire d'erreurs en dernier.
  app.use(notFound)
  app.use(handleError)
  return app
}
