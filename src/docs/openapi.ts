import { defaultRateLimits as limits } from "../middlewares/rate-limit.js"
import { ACTION_TOKEN_LENGTH, PASSWORD_MIN_LENGTH } from "../utils/credentials.js"
import { MAX_JWT_LENGTH } from "../utils/jwt.js"
import {
  AUDIT_ACTIONS,
  EMAIL_MAX_LENGTH,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_SEARCH_MAX_LENGTH,
  TICKET_SORT_FIELDS,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "../utils/validation.js"

// Contrat OpenAPI 3.1 de l'API, écrit à la main.
// Il DÉCRIT l'API ; il ne la valide pas : les règles réelles restent dans les controllers et les utils.
// Les tests (tests/unit/openapi.test.ts, tests/integration/openapi-contract.test.ts) vérifient qu'il reste fidèle.
// Les exemples sont fictifs : jamais de vrai token, mot de passe ou secret.

const INT32_MAX = 2_147_483_647
const ROLES = ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] as const
type Role = (typeof ROLES)[number]
const STAFF: Role[] = ["SUPER_ADMIN", "ADMIN", "AGENT"]

// --- Petites fonctions d'aide : elles évitent de répéter les mêmes blocs sur chaque opération ---

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object) => ({ "application/json": { schema } })

// Réponse d'erreur : toujours le même corps { "error": "..." }
const errorResponse = (description: string) => ({ description, content: json(ref("Error")) })

type Operation = {
  tag: string
  operationId: string
  summary: string
  description: string
  // "public" : aucun token ; sinon la liste exacte des rôles autorisés
  roles: "public" | Role[]
  parameters?: object[]
  requestBody?: string // nom du schéma du body JSON
  responses: Record<string, object>
}

// Construire une opération : ajoute la sécurité, la description des rôles et les réponses communes
// (429 limitation de débit et 500 erreur interne pour tous ; 413 pour les routes qui reçoivent un body).
function operation(o: Operation) {
  const access =
    o.roles === "public"
      ? "**Accès** : public, aucun token requis."
      : `**Rôles autorisés** : ${o.roles.join(", ")}. Un autre rôle reçoit \`403\`, une absence de token valide \`401\`.`
  return {
    tags: [o.tag],
    operationId: o.operationId,
    summary: o.summary,
    description: `${o.description}\n\n${access}`,
    // Authentification (JWT) ; les rôles sont décrits ci-dessus et dans x-roles (lisible par un outil).
    security: o.roles === "public" ? [] : [{ bearerAuth: [] }],
    "x-roles": o.roles === "public" ? [] : o.roles,
    ...(o.parameters && { parameters: o.parameters }),
    ...(o.requestBody && {
      requestBody: { required: true, content: json(ref(o.requestBody)) },
    }),
    responses: {
      ...o.responses,
      ...(o.requestBody && {
        "413": errorResponse(`Corps de requête de plus de 100 Ko.`),
      }),
      "429": { $ref: "#/components/responses/TooManyRequests" },
      "500": errorResponse("Erreur interne : le détail reste dans les logs du serveur, jamais dans la réponse."),
    },
  }
}

const idParameter = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "integer", minimum: 1, maximum: INT32_MAX, examples: [12] },
})

const pageParameters = [
  {
    name: "page",
    in: "query",
    description: `Numéro de page (1 à ${MAX_PAGE}).`,
    schema: { type: "integer", minimum: 1, maximum: MAX_PAGE, default: 1 },
  },
  {
    name: "limit",
    in: "query",
    description: `Éléments par page (1 à ${MAX_PAGE_SIZE}).`,
    schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: 20 },
  },
]

const QUERY_NOTE =
  "Un paramètre inconnu, répété ou invalide renvoie `400`. Une page au-delà de la dernière renvoie `200` avec `data` vide."

export const API_VERSION = "1.0.0"

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Support Ticket API",
    version: API_VERSION,
    description: [
      "API de gestion de tickets de support : authentification par JWT, comptes, tickets et journal d'audit.",
      "",
      "## Authentification",
      "1. Appeler `POST /auth/login` pour obtenir un `accessToken` (valable 15 minutes) et un `refreshToken` (7 jours).",
      "2. Envoyer `Authorization: Bearer <accessToken>` sur les routes protégées. Dans Swagger UI, utiliser le bouton **Authorize**.",
      "3. Renouveler les jetons avec `POST /auth/refresh`.",
      "",
      "## Rôles et permissions",
      "Le jeton prouve l'identité ; le **rôle** du compte (relu en base à chaque requête) décide de ce qui est permis.",
      "Chaque opération indique ses rôles autorisés dans sa description et dans l'extension `x-roles`.",
      "",
      "| Action | USER | AGENT, ADMIN, SUPER_ADMIN |",
      "| --- | --- | --- |",
      "| Créer un ticket | oui | oui |",
      "| Lire ses propres tickets | oui | oui |",
      "| Lire tous les tickets, filtrer par auteur | non | oui |",
      "| Modifier le statut d'un ticket | non | oui |",
      "",
      "Seul le **SUPER_ADMIN** gère les comptes (création, invitation, désactivation, réactivation) et lit le journal d'audit.",
      "Un `USER` qui demande le ticket d'un autre reçoit `404` (l'existence du ticket n'est pas révélée).",
      "",
      "## Conventions",
      '- Toutes les erreurs ont le même corps : `{ "error": "message" }`.',
      "- Un champ inconnu dans un body JSON, ou un paramètre de query inconnu, renvoie `400`.",
      "- Les routes sont limitées en débit (`429` avec l'en-tête `Retry-After`).",
      "- Certaines réponses n'ont volontairement **pas de corps** (`204`).",
      "",
      "Ce contrat décrit l'API ; les règles de validation réelles sont celles du code.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "Serveur courant" }],
  tags: [
    { name: "Authentification", description: "Connexion, jetons, invitations et réinitialisation du mot de passe." },
    { name: "Comptes", description: "Gestion des comptes, réservée au SUPER_ADMIN." },
    { name: "Tickets", description: "Création, lecture et suivi des tickets." },
    { name: "Audit", description: "Journal des actions sensibles, en lecture seule." },
  ],
  paths: {
    "/auth/login": {
      post: operation({
        tag: "Authentification",
        operationId: "login",
        summary: "Se connecter",
        description:
          `Vérifie l'email et le mot de passe et ouvre une session. Limité à ${limits.loginPerIp} tentatives par IP et ${limits.loginFailuresPerIpAndEmail} échecs d'authentification par couple IP + email sur 15 minutes.`,
        roles: "public",
        requestBody: "LoginRequest",
        responses: {
          "200": { description: "Connexion réussie.", content: json(ref("AuthTokens")) },
          "400": errorResponse("Corps invalide (email mal formé, mot de passe manquant ou trop long, champ inconnu)."),
          "401": errorResponse("Identifiants invalides, ou compte non actif."),
        },
      }),
    },
    "/auth/refresh": {
      post: operation({
        tag: "Authentification",
        operationId: "refreshTokens",
        summary: "Renouveler les jetons",
        description: "Échange un refresh token valide contre une nouvelle paire de jetons (rotation : l'ancien refresh token devient inutilisable).",
        roles: "public",
        requestBody: "RefreshRequest",
        responses: {
          "200": { description: "Nouvelle paire de jetons.", content: json(ref("AuthTokens")) },
          "400": errorResponse("Corps invalide."),
          "401": errorResponse("Refresh token invalide, expiré ou révoqué."),
        },
      }),
    },
    "/auth/logout": {
      post: operation({
        tag: "Authentification",
        operationId: "logout",
        summary: "Se déconnecter",
        description: "Révoque la session liée au refresh token.",
        roles: "public",
        requestBody: "RefreshRequest",
        responses: {
          "204": { description: "Session révoquée. Réponse sans corps." },
          "400": errorResponse("Corps invalide."),
          "401": errorResponse("Refresh token invalide, expiré ou déjà révoqué."),
        },
      }),
    },
    "/auth/accept-invitation": {
      post: operation({
        tag: "Authentification",
        operationId: "acceptInvitation",
        summary: "Activer un compte invité",
        description:
          `Active le compte lié au code reçu par email et définit son mot de passe. Le code est à usage unique. Limité à ${limits.codesPerIp} tentatives par IP sur 15 minutes, quota partagé avec \`reset-password\`.`,
        roles: "public",
        requestBody: "AcceptInvitationRequest",
        responses: {
          "204": { description: "Compte activé. Réponse sans corps." },
          "400": errorResponse("Code ou mot de passe invalide, ou invitation invalide ou expirée."),
        },
      }),
    },
    "/auth/request-password-reset": {
      post: operation({
        tag: "Authentification",
        operationId: "requestPasswordReset",
        summary: "Demander un code de réinitialisation",
        description:
          `Envoie un code par email si un compte actif correspond. La réponse est identique que le compte existe ou non. Limité à ${limits.passwordResetPerIp} demandes par IP et ${limits.passwordResetPerEmail} par adresse email sur 15 minutes : un tiers peut donc empêcher une adresse de demander un code pendant au plus 15 minutes, jamais définitivement.`,
        roles: "public",
        requestBody: "EmailRequest",
        responses: {
          "202": { description: "Demande acceptée.", content: json(ref("MessageResponse")) },
          "400": errorResponse("Email invalide."),
          "503": errorResponse("Envoi d'email non configuré."),
        },
      }),
    },
    "/auth/reset-password": {
      post: operation({
        tag: "Authentification",
        operationId: "resetPassword",
        summary: "Définir un nouveau mot de passe",
        description:
          "Change le mot de passe avec le code reçu par email (usage unique) et révoque toutes les sessions du compte.",
        roles: "public",
        requestBody: "ResetPasswordRequest",
        responses: {
          "204": { description: "Mot de passe changé. Réponse sans corps." },
          "400": errorResponse("Code ou mot de passe invalide, ou code invalide ou expiré."),
        },
      }),
    },
    "/users": {
      post: operation({
        tag: "Comptes",
        operationId: "createUser",
        summary: "Créer un compte",
        description:
          "Crée un compte en attente d'activation, sans mot de passe. Le rôle SUPER_ADMIN ne peut pas être attribué ici (script CLI dédié). Action tracée dans le journal d'audit.",
        roles: ["SUPER_ADMIN"],
        requestBody: "CreateUserRequest",
        responses: {
          "201": { description: "Compte créé (statut INVITED).", content: json(ref("User")) },
          "400": errorResponse("Email ou rôle invalide, champ inconnu."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : réservé au SUPER_ADMIN."),
          "409": errorResponse("Email déjà utilisé."),
        },
      }),
    },
    "/users/{id}/invitation": {
      post: operation({
        tag: "Comptes",
        operationId: "inviteUser",
        summary: "Envoyer une invitation",
        description:
          "Génère un code d'invitation (24 h) et l'envoie par email. Aucun body. Le code est enregistré avant l'envoi ; si l'email est refusé, la réponse est `502` et l'échec est tracé dans le journal d'audit.",
        roles: ["SUPER_ADMIN"],
        parameters: [idParameter("id", "Identifiant du compte.")],
        responses: {
          "202": { description: "Invitation transmise.", content: json(ref("MessageResponse")) },
          "400": errorResponse("Identifiant invalide, ou body fourni."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : réservé au SUPER_ADMIN."),
          "404": errorResponse("Utilisateur introuvable."),
          "409": errorResponse("Compte non invitable (déjà activé)."),
          "502": errorResponse("L'envoi de l'email a échoué."),
          "503": errorResponse("Envoi d'email non configuré."),
        },
      }),
    },
    "/users/{id}/disable": {
      patch: operation({
        tag: "Comptes",
        operationId: "disableUser",
        summary: "Désactiver un compte",
        description:
          "Passe un compte actif en DISABLED et révoque toutes ses sessions. Le SUPER_ADMIN ne peut pas être désactivé. Aucun body. Action tracée dans le journal d'audit.",
        roles: ["SUPER_ADMIN"],
        parameters: [idParameter("id", "Identifiant du compte.")],
        responses: {
          "200": { description: "Compte désactivé.", content: json(ref("User")) },
          "400": errorResponse("Identifiant invalide, ou body fourni."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : rôle insuffisant, ou compte SUPER_ADMIN non désactivable."),
          "404": errorResponse("Utilisateur introuvable."),
          "409": errorResponse("Compte non actif, ou statut modifié entre-temps."),
        },
      }),
    },
    "/users/{id}/enable": {
      patch: operation({
        tag: "Comptes",
        operationId: "enableUser",
        summary: "Réactiver un compte",
        description:
          "Passe un compte DISABLED en ACTIVE, sans restaurer ses anciennes sessions. Aucun body. Action tracée dans le journal d'audit.",
        roles: ["SUPER_ADMIN"],
        parameters: [idParameter("id", "Identifiant du compte.")],
        responses: {
          "200": { description: "Compte réactivé.", content: json(ref("User")) },
          "400": errorResponse("Identifiant invalide, ou body fourni."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : réservé au SUPER_ADMIN."),
          "404": errorResponse("Utilisateur introuvable."),
          "409": errorResponse("Compte non désactivé, ou statut modifié entre-temps."),
        },
      }),
    },
    "/tickets": {
      get: operation({
        tag: "Tickets",
        operationId: "listTickets",
        summary: "Lister les tickets",
        description: `Renvoie une page de tickets. Un \`USER\` ne voit et ne compte que ses propres tickets ; le personnel voit tous les tickets, y compris ceux sans auteur. Tri par défaut : du plus récent au plus ancien, \`id\` départageant les égalités. ${QUERY_NOTE}`,
        roles: ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"],
        parameters: [
          ...pageParameters,
          {
            name: "status",
            in: "query",
            description: "Filtrer par statut.",
            schema: ref("TicketStatus"),
          },
          {
            name: "q",
            in: "query",
            description: `Recherche littérale dans le titre, sans tenir compte de la casse (${TICKET_SEARCH_MAX_LENGTH} caractères maximum, sans caractères de contrôle).`,
            schema: { type: "string", maxLength: TICKET_SEARCH_MAX_LENGTH },
          },
          {
            name: "createdById",
            in: "query",
            description: "Filtrer par auteur. **Réservé au personnel** : un `USER` reçoit `403`.",
            schema: { type: "integer", minimum: 1, maximum: INT32_MAX },
          },
          {
            name: "sortBy",
            in: "query",
            description: "Champ de tri.",
            schema: { type: "string", enum: [...TICKET_SORT_FIELDS], default: "createdAt" },
          },
          {
            name: "order",
            in: "query",
            description: "Sens du tri.",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
        ],
        responses: {
          "200": { description: "Page de tickets.", content: json(ref("TicketPage")) },
          "400": errorResponse("Paramètre de query invalide, inconnu ou répété."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Un USER ne peut pas filtrer par `createdById`."),
        },
      }),
      post: operation({
        tag: "Tickets",
        operationId: "createTicket",
        summary: "Créer un ticket",
        description:
          "Crée un ticket. L'auteur est l'utilisateur authentifié : il ne peut jamais être fourni dans le body (un champ `createdById` est refusé avec `400`).",
        roles: ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"],
        requestBody: "CreateTicketRequest",
        responses: {
          "201": { description: "Ticket créé (statut OPEN).", content: json(ref("Ticket")) },
          "400": errorResponse("Titre ou description invalide, champ inconnu."),
          "401": errorResponse("Authentification requise."),
        },
      }),
    },
    "/tickets/{id}": {
      get: operation({
        tag: "Tickets",
        operationId: "getTicket",
        summary: "Lire un ticket",
        description:
          "Renvoie un ticket. Un `USER` qui demande le ticket d'un autre, ou un ticket sans auteur, reçoit `404` comme si le ticket n'existait pas.",
        roles: ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"],
        parameters: [idParameter("id", "Identifiant du ticket.")],
        responses: {
          "200": { description: "Le ticket.", content: json(ref("Ticket")) },
          "400": errorResponse("Identifiant invalide."),
          "401": errorResponse("Authentification requise."),
          "404": errorResponse("Ticket introuvable, ou non visible par ce compte."),
        },
      }),
    },
    "/tickets/{id}/status": {
      patch: operation({
        tag: "Tickets",
        operationId: "updateTicketStatus",
        summary: "Modifier le statut d'un ticket",
        description: "Change le statut d'un ticket. Réservé au personnel, même pour un ticket dont l'utilisateur est l'auteur.",
        roles: STAFF,
        parameters: [idParameter("id", "Identifiant du ticket.")],
        requestBody: "UpdateTicketStatusRequest",
        responses: {
          "200": { description: "Ticket mis à jour.", content: json(ref("Ticket")) },
          "400": errorResponse("Identifiant ou statut invalide, champ inconnu."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : réservé au personnel."),
          "404": errorResponse("Ticket introuvable."),
        },
      }),
    },
    "/audit-logs": {
      get: operation({
        tag: "Audit",
        operationId: "listAuditLogs",
        summary: "Consulter le journal d'audit",
        description: `Renvoie une page du journal, du plus récent au plus ancien. Lecture seule : aucune route ne permet de créer, modifier ou supprimer une ligne. Le journal ne contient jamais de mot de passe, de jeton, de code ni d'email. ${QUERY_NOTE}`,
        roles: ["SUPER_ADMIN"],
        parameters: [
          ...pageParameters,
          {
            name: "action",
            in: "query",
            description: "Filtrer par type d'action.",
            schema: ref("AuditAction"),
          },
          {
            name: "actorId",
            in: "query",
            description: "Filtrer par compte qui a agi.",
            schema: { type: "integer", minimum: 1, maximum: INT32_MAX },
          },
          {
            name: "targetUserId",
            in: "query",
            description: "Filtrer par compte concerné.",
            schema: { type: "integer", minimum: 1, maximum: INT32_MAX },
          },
        ],
        responses: {
          "200": { description: "Page du journal.", content: json(ref("AuditLogPage")) },
          "400": errorResponse("Paramètre de query invalide, inconnu ou répété."),
          "401": errorResponse("Authentification requise."),
          "403": errorResponse("Accès interdit : réservé au SUPER_ADMIN."),
        },
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Access token obtenu avec `POST /auth/login` (valable 15 minutes). Il prouve l'identité ; les rôles autorisés de chaque opération sont indiqués dans sa description (`x-roles`).",
      },
    },
    responses: {
      TooManyRequests: {
        description:
          "Limite de débit dépassée. Réessayer après le délai indiqué par `Retry-After`. Toutes les routes sont concernées, les routes d'authentification ont des limites plus strictes.",
        headers: {
          "Retry-After": {
            description: "Nombre de secondes à attendre avant de réessayer.",
            schema: { type: "integer", minimum: 0 },
          },
          RateLimit: { description: "Quota restant et délai avant remise à zéro.", schema: { type: "string" } },
          "RateLimit-Policy": { description: "Politique de limitation appliquée.", schema: { type: "string" } },
        },
        content: json(ref("Error")),
      },
    },
    schemas: {
      Error: {
        type: "object",
        description: "Corps de toutes les réponses d'erreur.",
        properties: { error: { type: "string", description: "Message lisible, sans détail interne." } },
        required: ["error"],
        additionalProperties: false,
        examples: [{ error: "ticket introuvable" }],
      },
      MessageResponse: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
        examples: [{ message: "Invitation transmise" }],
      },
      Role: { type: "string", enum: [...ROLES], description: "Rôle d'un compte." },
      UserStatus: {
        type: "string",
        enum: ["INVITED", "ACTIVE", "DISABLED"],
        description: "INVITED : en attente d'activation. ACTIVE : peut se connecter. DISABLED : désactivé.",
      },
      TicketStatus: { type: "string", enum: [...TICKET_STATUSES], description: "Statut d'un ticket." },
      AuditAction: { type: "string", enum: [...AUDIT_ACTIONS], description: "Type d'action tracée." },
      AuthTokens: {
        type: "object",
        properties: {
          accessToken: { type: "string", maxLength: MAX_JWT_LENGTH, description: "JWT d'accès, valable 15 minutes." },
          refreshToken: { type: "string", maxLength: MAX_JWT_LENGTH, description: "JWT de renouvellement, valable 7 jours." },
        },
        required: ["accessToken", "refreshToken"],
        additionalProperties: false,
        examples: [{ accessToken: "<jeton-d-acces-d-exemple>", refreshToken: "<jeton-de-renouvellement-d-exemple>" }],
      },
      LoginRequest: {
        type: "object",
        properties: {
          email: { type: "string", maxLength: EMAIL_MAX_LENGTH, description: "Adresse email du compte." },
          password: { type: "string", minLength: 1, description: "Mot de passe (1024 octets au maximum en UTF-8)." },
        },
        required: ["email", "password"],
        additionalProperties: false,
        examples: [{ email: "alice@example.com", password: "mot-de-passe-d-exemple" }],
      },
      RefreshRequest: {
        type: "object",
        properties: {
          refreshToken: { type: "string", minLength: 1, maxLength: MAX_JWT_LENGTH },
        },
        required: ["refreshToken"],
        additionalProperties: false,
        examples: [{ refreshToken: "<jeton-de-renouvellement-d-exemple>" }],
      },
      AcceptInvitationRequest: {
        type: "object",
        properties: {
          token: {
            type: "string",
            pattern: `^[A-Za-z0-9_-]{${ACTION_TOKEN_LENGTH}}$`,
            description: `Code reçu par email (${ACTION_TOKEN_LENGTH} caractères base64url, usage unique).`,
          },
          password: {
            type: "string",
            minLength: PASSWORD_MIN_LENGTH,
            description: `Nouveau mot de passe : ${PASSWORD_MIN_LENGTH} caractères minimum, 1024 octets maximum en UTF-8.`,
          },
        },
        required: ["token", "password"],
        additionalProperties: false,
        examples: [{ token: "A".repeat(ACTION_TOKEN_LENGTH), password: "mot-de-passe-d-exemple" }],
      },
      EmailRequest: {
        type: "object",
        properties: { email: { type: "string", maxLength: EMAIL_MAX_LENGTH } },
        required: ["email"],
        additionalProperties: false,
        examples: [{ email: "alice@example.com" }],
      },
      ResetPasswordRequest: {
        type: "object",
        properties: {
          token: {
            type: "string",
            pattern: `^[A-Za-z0-9_-]{${ACTION_TOKEN_LENGTH}}$`,
            description: `Code reçu par email (${ACTION_TOKEN_LENGTH} caractères base64url, usage unique).`,
          },
          password: {
            type: "string",
            minLength: PASSWORD_MIN_LENGTH,
            description: `Nouveau mot de passe : ${PASSWORD_MIN_LENGTH} caractères minimum, 1024 octets maximum en UTF-8.`,
          },
        },
        required: ["token", "password"],
        additionalProperties: false,
        examples: [{ token: "A".repeat(ACTION_TOKEN_LENGTH), password: "mot-de-passe-d-exemple" }],
      },
      CreateUserRequest: {
        type: "object",
        properties: {
          email: { type: "string", maxLength: EMAIL_MAX_LENGTH },
          role: { type: "string", enum: ["ADMIN", "AGENT", "USER"], description: "SUPER_ADMIN n'est pas attribuable ici." },
        },
        required: ["email", "role"],
        additionalProperties: false,
        examples: [{ email: "agent@example.com", role: "AGENT" }],
      },
      User: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          email: { type: "string" },
          role: ref("Role"),
          status: ref("UserStatus"),
        },
        required: ["id", "email", "role", "status"],
        additionalProperties: false,
        examples: [{ id: 7, email: "agent@example.com", role: "AGENT", status: "INVITED" }],
      },
      CreateTicketRequest: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: TICKET_TITLE_MAX_LENGTH,
            description: "Une seule ligne, sans caractères de contrôle.",
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: TICKET_DESCRIPTION_MAX_LENGTH,
            description: "Retours à la ligne permis, autres caractères de contrôle interdits.",
          },
        },
        required: ["title", "description"],
        additionalProperties: false,
        examples: [{ title: "Connexion impossible", description: "Une erreur s'affiche quand je me connecte." }],
      },
      UpdateTicketStatusRequest: {
        type: "object",
        properties: { status: ref("TicketStatus") },
        required: ["status"],
        additionalProperties: false,
        examples: [{ status: "IN_PROGRESS" }],
      },
      Ticket: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          title: { type: "string" },
          description: { type: "string" },
          status: ref("TicketStatus"),
          createdById: {
            type: ["integer", "null"],
            description: "Auteur du ticket ; `null` pour un ancien ticket sans auteur (visible du personnel uniquement).",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "title", "description", "status", "createdById", "createdAt", "updatedAt"],
        additionalProperties: false,
        examples: [
          {
            id: 12,
            title: "Connexion impossible",
            description: "Une erreur s'affiche quand je me connecte.",
            status: "OPEN",
            createdById: 3,
            createdAt: "2026-11-14T14:02:00.000Z",
            updatedAt: "2026-11-14T14:02:00.000Z",
          },
        ],
      },
      PageMeta: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
          total: { type: "integer", minimum: 0, description: "Nombre total d'éléments correspondant aux filtres." },
          totalPages: { type: "integer", minimum: 0 },
        },
        required: ["page", "limit", "total", "totalPages"],
        additionalProperties: false,
        examples: [{ page: 1, limit: 20, total: 37, totalPages: 2 }],
      },
      TicketPage: {
        type: "object",
        properties: { data: { type: "array", items: ref("Ticket") }, meta: ref("PageMeta") },
        required: ["data", "meta"],
        additionalProperties: false,
      },
      AuditLog: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          createdAt: { type: "string", format: "date-time" },
          action: ref("AuditAction"),
          actorId: { type: ["integer", "null"], description: "Compte qui a agi ; `null` pour le script CLI ou un compte supprimé." },
          actorRole: {
            oneOf: [ref("Role"), { type: "null" }],
            description: "Rôle de l'acteur au moment de l'action (conservé même si le compte est supprimé).",
          },
          targetUserId: { type: ["integer", "null"], description: "Compte concerné ; `null` s'il a été supprimé." },
          metadata: {
            type: ["object", "null"],
            description: "Informations utiles et non sensibles (rôle, états avant/après, nombre de sessions révoquées...).",
          },
        },
        required: ["id", "createdAt", "action", "actorId", "actorRole", "targetUserId", "metadata"],
        additionalProperties: false,
        examples: [
          {
            id: 42,
            createdAt: "2026-11-14T14:02:00.000Z",
            action: "USER_DISABLED",
            actorId: 1,
            actorRole: "SUPER_ADMIN",
            targetUserId: 7,
            metadata: { statusBefore: "ACTIVE", statusAfter: "DISABLED", revokedSessions: 2 },
          },
        ],
      },
      AuditLogPage: {
        type: "object",
        properties: { data: { type: "array", items: ref("AuditLog") }, meta: ref("PageMeta") },
        required: ["data", "meta"],
        additionalProperties: false,
      },
    },
  },
}
