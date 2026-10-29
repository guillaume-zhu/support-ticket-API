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

## Routes

| Méthode | URL                   | Action              |
| ------- | --------------------- | ------------------- |
| GET     | `/tickets`            | Lister les tickets  |
| POST    | `/tickets`            | Créer un ticket     |
| GET     | `/tickets/:id`        | Lire un ticket      |
| PATCH   | `/tickets/:id/status` | Modifier son statut |

Pour `POST /tickets`, envoyer un corps JSON :

```json
{ "title": "Connexion", "description": "Je ne peux pas me connecter" }
```

Pour `PATCH /tickets/:id/status`, envoyer par exemple :

```json
{ "status": "IN_PROGRESS" }
```

Statuts autorisés : `OPEN`, `IN_PROGRESS`, `CLOSED`.
