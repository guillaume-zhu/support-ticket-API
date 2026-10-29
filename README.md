# Support Ticket API

API de tickets créée avec Express, TypeScript, PostgreSQL et Prisma.

Auteur : Guillaume Zhu - WEB2 - HETIC

## Prérequis

- Node.js 24
- PostgreSQL 17 installé avec Homebrew

## Lancer le projet

Dans le dossier du projet :

```bash
nvm use 24
npm ci
cp -n .env.example .env
```

Dans `.env`, remplacer `YOUR_USER` par son nom d'utilisateur macOS.
Ce fichier est ignoré par Git.

Si PostgreSQL n'est pas déjà démarré, le lancer sur le port `5433` :

```bash
"$(brew --prefix postgresql@17)/bin/pg_ctl" \
  -D "$(brew --prefix)/var/postgresql@17" \
  -o "-p 5433" \
  -l /tmp/support-ticket-postgres.log start
```

À la première installation seulement, créer la base :

```bash
"$(brew --prefix postgresql@17)/bin/createdb" \
  -h 127.0.0.1 -p 5433 support_ticket
```

Créer la table, générer le client Prisma, puis démarrer l'API :

```bash
npx prisma migrate deploy
npx prisma generate
npm run dev
```

L'API est disponible sur `http://localhost:3000`.

## Premier Super Admin

Une fois la migration appliquée, exécuter dans le dossier du projet :

```bash
npm run bootstrap:super-admin -- admin@example.com
```

Remplacer l'adresse par celle du premier administrateur. Le mot de passe est
demandé deux fois sans s'afficher. La commande refuse de créer un compte si
un Super Admin existe déjà. Il n'y a pas de route d'inscription publique.

## Connexion

Dans `.env`, ajouter deux secrets JWT différents. Pour générer une valeur, exécuter
deux fois cette commande et copier chaque résultat dans une variable différente :

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

`POST /auth/login` reçoit `email` et `password` en JSON et renvoie
`accessToken` (15 minutes) et `refreshToken` (7 jours).
`POST /auth/refresh` reçoit `{ "refreshToken": "..." }` et renvoie une
nouvelle paire. L'ancien refresh token ne peut plus être réutilisé.
`POST /auth/logout` reçoit le même format et révoque la session liée au token.

```json
{ "email": "admin@example.com", "password": "votre mot de passe" }
```

## Routes

| Méthode | URL                   | Action              |
| ------- | --------------------- | ------------------- |
| POST    | `/auth/login`         | Se connecter        |
| POST    | `/auth/refresh`       | Renouveler les tokens |
| POST    | `/auth/logout`        | Se déconnecter        |
| GET     | `/tickets`            | Lister les tickets  |
| POST    | `/tickets`            | Créer un ticket     |
| GET     | `/tickets/:id`        | Lire un ticket      |
| PATCH   | `/tickets/:id/status` | Modifier son statut |
| POST    | `/users`              | Créer un compte invité |

Pour `POST /tickets`, envoyer un corps JSON :

```json
{ "title": "Connexion", "description": "Je ne peux pas me connecter" }
```

Pour `PATCH /tickets/:id/status`, envoyer par exemple :

```json
{ "status": "IN_PROGRESS" }
```

Statuts autorisés : `OPEN`, `IN_PROGRESS`, `CLOSED`.

Les routes `/tickets` demandent le header
`Authorization: Bearer <accessToken>`. Les quatre rôles peuvent créer un
ticket. La lecture et le changement de statut sont réservés à
`SUPER_ADMIN`, `ADMIN` et `AGENT`. Un token absent ou invalide donne `401` ;
un rôle insuffisant donne `403`.

`POST /users` demande un access token de `SUPER_ADMIN` et un corps JSON :

```json
{ "email": "nouveau@example.com", "role": "AGENT" }
```

La réponse `201` contient `id`, `email`, `role` et `status: "INVITED"`.
Les rôles autorisés à la création sont `ADMIN`, `AGENT` et `USER`.
Un email invalide ou un rôle inconnu donne `400` ; un email déjà utilisé donne `409`.
