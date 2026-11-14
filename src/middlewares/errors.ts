import type { ErrorRequestHandler, RequestHandler } from "express"

// Dernier recours pour une URL qu'aucune route n'a traitée : réponse JSON, pas la page HTML d'Express.
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "route introuvable" })
}

// Attrape toute erreur transmise par next(error) ou levée dans un handler async (Express 5).
// Express reconnaît un gestionnaire d'erreurs à ses 4 paramètres : ne pas en retirer.
export const handleError: ErrorRequestHandler = (error, req, res, next) => {
  // Si la réponse est déjà partie, on ne peut plus écrire : Express ferme la connexion.
  if (res.headersSent) {
    return next(error)
  }

  // Erreurs du parseur JSON (body-parser), reconnues par leur `type`.
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON invalide" })
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "corps de requête trop volumineux" })
  }

  // Autres erreurs client (encodage non supporté, etc.) : message volontairement générique.
  const status = error?.status ?? error?.statusCode
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: "requête invalide" })
  }

  // Erreur inattendue : détail dans les logs serveur uniquement, jamais dans la réponse.
  console.error(`Erreur interne sur ${req.method} ${req.path}`, error)
  return res.status(500).json({ error: "erreur interne" })
}
