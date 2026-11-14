import express, { type ErrorRequestHandler } from "express"
import type { PrismaClient } from "./generated/prisma/client.js"
import { registerRoutes } from "./routes/index.js"

// Construire l'application sans ouvrir de port, pour les tests HTTP.
export function createApp(prisma: PrismaClient) {
  const app = express()
  app.use(express.json())
  registerRoutes(app, prisma)

  const handleError: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) {
      return next(error)
    }

    const status = error?.status ?? error?.statusCode
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).json({ error: "requête invalide" })
    }

    console.error(`Erreur interne sur ${req.method} ${req.path}`, error)
    return res.status(500).json({ error: "erreur interne" })
  }
  app.use(handleError)
  return app
}
