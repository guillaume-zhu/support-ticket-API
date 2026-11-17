import { Router } from "express"
import swaggerUi from "swagger-ui-express"
import { openApiDocument } from "../../docs/openapi.js"

// Décider si la documentation est exposée : API_DOCS=true|false l'emporte,
// sinon elle est active partout sauf en production. Toute autre valeur est refusée au démarrage.
export function isApiDocsEnabled(apiDocs: string | undefined, nodeEnv: string | undefined) {
  if (apiDocs === undefined || apiDocs === "") return nodeEnv !== "production"
  if (apiDocs === "true") return true
  if (apiDocs === "false") return false
  throw new Error("API_DOCS doit valoir true ou false")
}

export function docsRoutes() {
  const router = Router()

  // Le contrat brut, lisible par des outils (Postman, générateurs de client...).
  router.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument)
  })

  // L'interface Swagger UI, servie par l'application elle-même (aucun CDN externe).
  router.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: "Support Ticket API",
      swaggerOptions: { persistAuthorization: false },
    }),
  )

  return router
}
