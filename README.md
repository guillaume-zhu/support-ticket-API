# Support Ticket API

API de tickets créée avec Express, TypeScript, PostgreSQL et Prisma.

Auteur : Guillaume Zhu - WEB2 - HETIC

## Prérequis

- Node.js 24
- PostgreSQL 17 installé avec Homebrew

## Tests automatisés

`npm run test:unit` lance les tests des fonctions réutilisables sans PostgreSQL.
`npm test` applique les migrations puis lance les tests unitaires et HTTP sur une
base **distincte**. Les tests HTTP purgent leurs données avant chaque scénario.

Créer une fois un rôle et une base de test dans PostgreSQL (avec un compte
administrateur PostgreSQL) :

```sql
CREATE ROLE support_ticket_test_runner LOGIN PASSWORD 'choisir-un-mot-de-passe';
CREATE DATABASE support_ticket_test OWNER support_ticket_test_runner;
```

Copier `.env.test.example` vers `.env.test`, puis renseigner le mot de passe et le
port PostgreSQL. Ce fichier est ignoré par Git. La commande refuse de démarrer
si l'URL ne cible pas la base locale `support_ticket_test` avec le rôle
`support_ticket_test_runner`, ou si elle correspond à l'URL de développement.
Elle remplace les secrets JWT par des valeurs temporaires et désactive tout envoi
Resend. On peut aussi fournir `DATABASE_TEST_URL` directement dans l'environnement.

```bash
npm run test:unit
npm test
```

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
Les access tokens sont également liés à leur session et refusés après sa révocation.

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
| POST    | `/users/:id/invitation` | Envoyer une invitation |
| POST    | `/auth/accept-invitation` | Activer un compte |
| POST    | `/auth/request-password-reset` | Demander un code de réinitialisation |
| POST    | `/auth/reset-password` | Définir un nouveau mot de passe |
| PATCH   | `/users/:id/disable` | Désactiver un compte |
| PATCH   | `/users/:id/enable` | Réactiver un compte |

Pour `POST /tickets`, envoyer un corps JSON :

```json
{ "title": "Connexion", "description": "Je ne peux pas me connecter" }
```

`GET /tickets` renvoie une page de résultats :

```json
{ "data": [], "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } }
```

Paramètres de query (tous optionnels ; `400` si invalides ou inconnus) :

| Paramètre     | Valeurs                                           | Défaut      |
| ------------- | ------------------------------------------------- | ----------- |
| `page`        | entier >= 1                                       | `1`         |
| `limit`       | entier de 1 à 100                                 | `20`        |
| `status`      | `OPEN`, `IN_PROGRESS`, `CLOSED`                   | tous        |
| `q`           | texte cherché dans le titre (100 car. max)        | aucun       |
| `createdById` | id d'un auteur (personnel uniquement, sinon `403`) | tous        |
| `sortBy`      | `id`, `createdAt`, `title`, `status`              | `createdAt` |
| `order`       | `asc`, `desc`                                     | `desc`      |

Une page au-delà de la dernière renvoie `200` avec `data: []`.

Pour `PATCH /tickets/:id/status`, envoyer par exemple :

```json
{ "status": "IN_PROGRESS" }
```

Statuts autorisés : `OPEN`, `IN_PROGRESS`, `CLOSED`.

Les routes `/tickets` demandent le header
`Authorization: Bearer <accessToken>`. Les quatre rôles peuvent créer et lire
des tickets : un `USER` ne voit que les siens (`404` sur le ticket d'un autre),
le personnel voit tout. Le changement de statut est réservé à `SUPER_ADMIN`,
`ADMIN` et `AGENT`. Un token absent ou invalide donne `401` ;
un rôle insuffisant donne `403`.

`POST /users` demande un access token de `SUPER_ADMIN` et un corps JSON :

```json
{ "email": "nouveau@example.com", "role": "AGENT" }
```

La réponse `201` contient `id`, `email`, `role` et `status: "INVITED"`.
Les rôles autorisés à la création sont `ADMIN`, `AGENT` et `USER`.
Un email invalide ou un rôle inconnu donne `400` ; un email déjà utilisé donne `409`.

## Invitations

Dans `.env`, renseigner `RESEND_API_KEY` et `RESEND_FROM_EMAIL` avec une adresse
expéditrice autorisée par Resend. Ces valeurs ne doivent pas être commitées.

Un Super Admin appelle `POST /users/:id/invitation` avec son access token.
L'API transmet un code valable 24 heures à l'email de l'utilisateur et répond `202`.
Un nouvel envoi invalide le code précédent.

Le destinataire appelle `POST /auth/accept-invitation` avec :

```json
{ "token": "code reçu par email", "password": "mot de passe de 15 caractères minimum" }
```

La réponse est `204`. Le code ne fonctionne plus ensuite ; le compte peut se connecter.

## Réinitialiser un mot de passe

`POST /auth/request-password-reset` reçoit `{ "email": "adresse@example.com" }`
et répond `202`, que le compte existe ou non. Si le compte est actif, un code
valable 1 heure est envoyé par email. Un nouveau code ne peut être demandé
qu'après 5 minutes.

`POST /auth/reset-password` reçoit :

```json
{ "token": "code reçu par email", "password": "nouveau mot de passe de 15 caractères minimum" }
```

La réponse `204` confirme le changement. Le code est consommé et les refresh
tokens existants sont révoqués. Un code invalide, expiré ou réutilisé donne `400`.

## Désactiver ou réactiver un compte

Un Super Admin appelle `PATCH /users/:id/disable` pour désactiver un compte
actif et révoquer ses sessions. `PATCH /users/:id/enable` réactive un compte
désactivé ; l'utilisateur doit ensuite se reconnecter. Les comptes `INVITED`
ne sont pas modifiés par ces routes, et le Super Admin ne peut pas être désactivé.
