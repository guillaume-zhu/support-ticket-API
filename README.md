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

## Intégration continue

Le workflow `.github/workflows/ci.yml` s'exécute sur GitHub à chaque `git push`
(toutes les branches), à chaque pull request et à la demande (onglet Actions,
« Run workflow »). Sur une machine Ubuntu vierge, avec Node 24 et un PostgreSQL 17
jetable, il enchaîne :

1. `npm ci` : installation exacte du `package-lock.json` ;
2. `npx prisma generate` : client Prisma ;
3. `npx tsc --noEmit` : vérification TypeScript ;
4. `npm run build` : compilation ;
5. `npm test` : migrations sur la base jetable, puis tests unitaires et HTTP.

Une coche verte ou une croix rouge s'affiche à côté du commit. Le workflow
n'a que le droit `contents: read`, n'utilise aucun secret du dépôt et ne déploie
rien. Les tests simulent toujours Resend.

La base du workflow porte les noms attendus par `scripts/test-database.ts`
(rôle `support_ticket_test_runner`, base `support_ticket_test`, hôte `127.0.0.1`).
Son mot de passe est écrit dans le fichier : ce n'est pas un secret, la base
n'existe que le temps du contrôle. Une première étape refuse toute URL
différente. `DATABASE_URL` est définie aussi pour `prisma generate`, car
`prisma.config.ts` la lit.

Les deux actions utilisées (`actions/checkout`, `actions/setup-node`) sont
officielles et épinglées sur le commit exact d'une version stable ; la version
est notée en commentaire. Pour les mettre à jour, remplacer le commit et le
commentaire ensemble.

`npm audit` n'est volontairement pas bloquant dans la CI.

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
| GET     | `/audit-logs` | Consulter l'historique des actions sensibles (Super Admin) |
| POST    | `/ai/chat` | Poser une question à l'assistant IA (tout compte connecté) |

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

## Validation des données entrantes

Toutes les requêtes Prisma sont paramétrées : une valeur n'est jamais interprétée
comme du SQL, donc un texte qui ressemble à du SQL est traité comme un texte
ordinaire. Le seul SQL brut du projet est un verrou PostgreSQL écrit avec un
*tagged template* (`$executeRaw`), dont la valeur est passée en paramètre.

Les données sont aussi validées avant d'atteindre la base. Une entrée invalide
renvoie `400`, jamais `500`.

| Donnée                              | Règle                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| Body JSON                           | objet uniquement ; tout champ non prévu pour l'endpoint donne `400`   |
| Id dans l'URL, `createdById`        | entier décimal de 1 à 2 147 483 647 (`1e2`, `0x10`, `012` refusés)     |
| Email                               | 254 caractères max, format valide, sans espaces ni caractères de contrôle |
| `title` d'un ticket                 | 1 à 200 caractères, une seule ligne                                   |
| `description` d'un ticket           | 1 à 5 000 caractères, retours à la ligne permis                       |
| `q` (recherche)                     | 100 caractères max, sans caractères de contrôle                       |
| Mot de passe                        | 15 caractères min, 1 024 octets max                                   |
| JWT reçu (`Bearer`, `refreshToken`) | 2 048 caractères max (les vrais tokens en font environ 350)           |

Les caractères de contrôle, dont l'octet NUL que PostgreSQL refuse dans un
texte, sont interdits. Un test parcourt `src/` et `scripts/` pour détecter les
usages évidents de SQL brut dangereux (`*Unsafe`, `Prisma.raw`) ; c'est un
simple garde-fou textuel, pas une garantie exhaustive.

## Documentation de l'API (OpenAPI et Swagger UI)

Le contrat de l'API est décrit en **OpenAPI 3.1** dans `src/docs/openapi.ts`
(objet TypeScript, descriptions en français, noms techniques en anglais).
Deux adresses sont exposées :

| URL             | Contenu                                                    |
| --------------- | ---------------------------------------------------------- |
| `/docs`         | Swagger UI : lire le contrat et tester les endpoints       |
| `/openapi.json` | Le contrat brut, pour Postman ou un générateur de client   |

Dans Swagger UI : appeler `POST /auth/login`, copier l'`accessToken`, cliquer sur
**Authorize** et le coller (sans le mot `Bearer`). Chaque opération indique ses
rôles autorisés (description et extension `x-roles`), ses champs avec leurs
limites et tous ses codes de réponse, y compris les `204` sans corps et les
`429` avec `Retry-After`. Les exemples sont fictifs.

La documentation est **active par défaut, sauf en production**. La variable
`API_DOCS` force le réglage : `API_DOCS=true` ou `API_DOCS=false` (toute autre
valeur est refusée au démarrage). Elle n'est pas protégée par authentification
et reste soumise à la limitation de débit globale. Désactivée, `/docs` et
`/openapi.json` renvoient le `404` JSON habituel.

**Le contrat décrit l'API, il ne la valide pas** : les règles réelles restent
dans les controllers et `src/utils`. Pour qu'il ne mente pas, les tests :

- vérifient qu'il est un OpenAPI 3.1 valide et que ses schémas compilent avec
  Ajv en JSON Schema 2020-12 (mode strict) ;
- comparent de **vraies réponses HTTP** de chaque opération (succès et erreurs)
  à ses schémas ;
- vérifient que les rôles documentés sont ceux réellement appliqués ;
- vérifient que ses énumérations et limites correspondent aux validateurs ;
- détectent une route du code absente du contrat (contrôle textuel simple, non
  exhaustif).

Ajouter une route demande donc de la décrire dans `src/docs/openapi.ts`.

## Assistant IA

`POST /ai/chat` permet à tout compte connecté de poser des questions à un assistant
spécialisé dans le support et l'utilisation de l'application (statuts, rôles, façon
de formuler un problème, pistes de résolution générales). Il refuse poliment le reste.

Par défaut, **l'assistant n'a accès à aucun ticket**. Avec `AI_TICKET_TOOLS=true`, il peut
en **lire** (voir « Consultation des tickets »). Avec `AI_TICKET_ACTIONS=true` en plus, il peut
**proposer** de créer un ticket ou de changer un statut (voir « Actions proposées »). Dans tous les cas,
il n'écrit jamais lui-même : seule votre confirmation HTTP exécute, et son message système lui interdit d'inventer un ticket.

```json
{ "message": "Que signifie le statut IN_PROGRESS ?" }
```

Pour poursuivre une conversation, ajouter son identifiant : `{ "conversationId": "<uuid>", "message": "Et pour CLOSED ?" }`.
**Le client n'envoie que son nouveau message** : le serveur retrouve l'historique dans PostgreSQL (voir « Conversations
enregistrées »).

Réponse : `{ "conversationId": "...", "reply": "...", "toolsUsed": ["get_ticket"] }`. `toolsUsed` liste les outils
exécutés **avec succès** par le serveur (arguments valides, requête lancée avec les droits de l'utilisateur,
résultat transmis au modèle), jamais leurs arguments ni leur contenu. Un appel seulement proposé par le modèle, refusé
ou en erreur n'y figure pas ; un ticket introuvable ou non accessible y figure (la consultation a eu lieu, sans résultat) ;
cela ne prouve pas que la réponse est exacte. Vide sans consultation aboutie.
Un message fait 2 000 caractères au maximum. Le client **ne peut envoyer ni rôle, ni historique, ni résultat d'outil** :
un champ `messages`, `role` ou `system` est refusé, et les règles de l'assistant sont écrites par le serveur
(`src/services/ai/ai.prompt.ts`).
Erreurs : `400` requête invalide, `401`, `404` conversation introuvable (absente ou à un autre utilisateur, indiscernables),
`409` conversation pleine ou trop de conversations, `429`, `502` fournisseur indisponible (rien n'est enregistré),
`503` assistant non configuré.

### Configuration

Dans `.env` (jamais dans Git) :

| Variable | Rôle |
| --- | --- |
| `AI_PROVIDER` | `openai` ou `deepseek` |
| `AI_API_KEY` | clé du fournisseur, uniquement côté serveur |
| `AI_MODEL` | nom exact d'un modèle autorisé par la clé (obligatoire, aucune valeur par défaut) |
| `AI_BASE_URL` | optionnel : adresse `https` du fournisseur (ex. région UE d'OpenAI) |
| `AI_MAX_OUTPUT_TOKENS` | optionnel, 2000 par défaut : plafond de TOUS les tokens générés, **raisonnement compris** |
| `AI_TIMEOUT_MS` | optionnel, 30 000 par défaut : délai maximal avant `502` |
| `AI_REASONING_EFFORT` | optionnel : `none`, `low`, `medium` ou `high` |
| `AI_CONVERSATION_RETENTION_DAYS` | optionnel, `90` par défaut : jours d'inactivité avant le nettoyage d'une conversation (utilisé par la tâche planifiée, voir « Nettoyage quotidien ») |
| `AI_TICKET_ACTIONS` | optionnel, `false` par défaut : `true` (exige `AI_TICKET_TOOLS=true`) permet à l'assistant de proposer des actions ; remettre `false` coupe immédiatement toute exécution, même des actions déjà en attente |
| `AI_TICKET_TOOLS` | optionnel, `false` par défaut : `true` autorise la consultation des tickets (le contenu des tickets visibles est alors envoyé au fournisseur) |

Sans les trois premières variables, l'assistant est désactivé et la route répond `503`. Une
configuration incomplète ou invalide arrête le démarrage avec un message qui cite le nom des
variables, jamais leur valeur.

L'appel utilise l'API **Responses** (`POST {adresse}/responses`), que OpenAI et DeepSeek
documentent toutes deux. Le serveur n'envoie que les paramètres communs : `model`,
`instructions`, `input`, `max_output_tokens`, `store: false` et, si configuré, `reasoning`.
Changer de fournisseur revient à changer ces variables.

**Raisonnement et plafond.** Un modèle qui raisonne dépense des tokens avant d'écrire sa
réponse, et ils comptent dans `AI_MAX_OUTPUT_TOKENS` : trop bas, la réponse arrive vide (le
serveur répond alors `502` et l'indique dans ses logs, sans contenu). Pour un assistant de
support, mieux vaut désactiver le raisonnement quand le modèle le permet
(`AI_REASONING_EFFORT=none`) ; sinon, augmenter le plafond et le délai.

### Conversations enregistrées

Chaque échange est enregistré dans PostgreSQL (`AiConversation` et `AiMessage`) : le texte de l'utilisateur et
la **réponse finale** de l'assistant, avec les noms des outils utilisés. Les appels de fonctions, leurs résultats et le
raisonnement du modèle ne sont **jamais** stockés. Le contenu est stocké **en clair** (pas de chiffrement applicatif) et
n'est jamais journalisé ni copié dans le journal d'audit.

| Route | Rôle |
| --- | --- |
| `POST /ai/chat` | démarre une conversation, ou la poursuit avec `conversationId` |
| `GET /ai/conversations` | mes conversations, de la plus récemment active à la plus ancienne (paginé) |
| `GET /ai/conversations/:id/messages` | l'historique d'une de mes conversations, du plus ancien au plus récent (paginé) |
| `DELETE /ai/conversations/:id` | supprime **immédiatement** une de mes conversations et ses messages |

- **Chacun ne voit que ses conversations**, quel que soit son rôle (SUPER_ADMIN compris). Une conversation absente et la
  conversation d'un autre donnent le même `404`. L'identité vient du JWT ; ouvrir une conversation ne donne **aucun droit** sur
  les tickets : les outils s'exécutent toujours avec les droits actuels de l'utilisateur.
- **Fenêtre de contexte** : à chaque question, seuls les 20 derniers messages au plus (12 000 caractères) sont envoyés au
  fournisseur, le nouveau message toujours compris. Les plus anciens restent consultables mais ne sont plus transmis.
- **Quotas** : 30 conversations par utilisateur et 100 messages par conversation (`409` au-delà, sans appeler le
  fournisseur). Ils sont revérifiés dans la transaction d'enregistrement, sous un verrou PostgreSQL court propre à
  l'utilisateur : ils tiennent même si plusieurs requêtes arrivent en même temps.
- **Enregistrement après succès** : le message de l'utilisateur et la réponse sont écrits ensemble, en une transaction, une
  fois la réponse obtenue. Un échec du fournisseur (`502`) ne laisse rien en base.
- **Rétrogradation d'un compte (limite assumée).** Une réponse de l'assistant peut résumer des tickets : elle reste dans
  la conversation de celui qui l'a demandée, même si ses droits baissent ensuite (AGENT vers USER, par exemple). Les outils
  appliquent toujours ses droits ACTUELS, mais son ancien texte reste lisible par lui. Aucun code ne modifie un rôle après la
  création du compte : une rétrogradation se fait aujourd'hui par modification directe de la base. **Procédure à appliquer
  en même temps** : supprimer ses conversations (les messages partent par cascade).

  ```sql
  DELETE FROM "AiConversation" WHERE "userId" = <id du compte>;
  ```

  Le jour où un endpoint de changement de rôle sera ajouté, cette suppression devra être faite dans la même transaction.
- **Requêtes simultanées dans une même conversation.** Aucune corruption : chaque échange (question et réponse) est
  enregistré en bloc dans une transaction, sous un verrou propre à l'utilisateur ; chaque réponse reste appariée à sa question,
  et les quotas tiennent (30 conversations, 100 messages). Deux limites assumées : (1) les requêtes simultanées lisent le même
  historique, donc la seconde ne tient pas compte de la première ; l'ordre final suit l'ordre d'enregistrement ; (2) les
  contrôles rapides faits avant l'appel au fournisseur peuvent laisser passer plusieurs requêtes, dont l'enregistrement est
  ensuite refusé (`409`) : le fournisseur a alors été appelé, mais jamais plus d'une fois par requête, et le quota par
  utilisateur borne ce coût.

#### Nettoyage quotidien

Une conversation est supprimée quand sa **dernière activité** (dernier échange enregistré) remonte à plus de
`AI_CONVERSATION_RETENTION_DAYS` jours (90 par défaut). Ses messages partent avec elle (cascade PostgreSQL). Il n'y a
**ni statut d'expiration, ni archivage, ni vérification à chaque lecture** : une tâche planifiée indépendante du serveur
fait le ménage.

```bash
npm run ai:purge-conversations              # supprime
npm run ai:purge-conversations -- --dry-run # compte sans rien supprimer
```

La tâche n'affiche que des compteurs, jamais de contenu. Pour un futur hébergement, à lancer **une fois par jour** par
cron, avec les variables d'environnement du serveur (`DATABASE_URL`, éventuellement `AI_CONVERSATION_RETENTION_DAYS`),
hors des heures de pointe. Exemple de ligne de crontab (tous les jours à 03h15) :

```cron
15 3 * * * cd /chemin/vers/support-ticket && npm run ai:purge-conversations >> /var/log/support-ticket-purge.log 2>&1
```

Sur un serveur sans dépendances de développement, utiliser la version compilée (`npm run build` d'abord) :
`node dist/jobs/purge-ai-conversations.js`. Aucun service de déploiement n'est fourni à ce stade.

**Limite assumée** : tant que la tâche n'est pas passée, une conversation reste lisible, même après ses 90 jours
d'inactivité (potentiellement jusqu'à environ 24 heures de plus, ou davantage si la tâche échoue ou n'est pas configurée).
Le seul moyen de suppression immédiate est `DELETE /ai/conversations/:id`.

### Actions proposées (`AI_TICKET_ACTIONS=true`)

L'assistant dispose de deux outils de **proposition** : `propose_create_ticket` et `propose_status_change` (ce dernier
déclaré au seul personnel). Ils n'écrivent rien. Le serveur enregistre l'intention dans `AiPendingAction`, **dans la même
transaction que l'échange**, et la réponse du chat contient `pendingActions` (`id`, `kind`, `summary`, `expiresAt`).
Le résumé est écrit par le serveur, jamais par le modèle.

```
POST /ai/chat                      → propose (rien n'est écrit)
GET  /ai/actions                   → mes actions en attente et non expirées
POST /ai/actions/:id/confirm       → exécute avec MES droits, revérifiés (corps facultatif : { "resolutionConfirmed": true })
POST /ai/actions/:id/cancel        → annule (toujours possible)
```

Règles : validité de **10 minutes** ; usage unique ; **5 actions en attente** au plus par utilisateur (les actions
périmées ne comptent pas) et 3 propositions par requête ; propriétaire seul (l'action d'un autre répond `404`) ; la clôture
d'un ticket exige `resolutionConfirmed: true` ; un statut modifié depuis la proposition (PATCH, autre agent) annule l'action
(`409`) grâce à une mise à jour conditionnelle atomique ; un rôle perdu donne `403`. L'exécution, l'audit
(`ASSISTANT_TICKET_CREATED`, `ASSISTANT_TICKET_STATUS_CHANGED`) et le message de résultat sont écrits dans **une transaction** :
si l'un échoue, l'action reste en attente. Une action résolue voit son contenu (titre, description, résumé) effacé.
Le nettoyage quotidien supprime les actions périmées depuis plus d'un jour.

Migration : elle ajoute deux valeurs à l'enum `AuditAction` (`ALTER TYPE ... ADD VALUE`). Ces valeurs ne sont pas
retirables simplement et ne sont utilisables qu'**après** la validation de la transaction qui les ajoute (le fichier de
migration ne les utilise pas). PostgreSQL 12 ou plus est requis.

### Consultation des tickets (`AI_TICKET_TOOLS=true`)

Le modèle ne fait que **proposer** d'appeler une fonction ; c'est le serveur qui exécute
(`src/services/ai/ai.tools.ts`). Deux outils, en lecture seule, et aucun autre :

| Outil | Rôle |
| --- | --- |
| `list_tickets` | tickets visibles de l'utilisateur ; filtres `status`, `q` (recherche **dans les titres**), `page`, `limit`, `sortBy`, `order` ; 10 tickets par appel au maximum (5 par défaut) |
| `get_ticket` | un ticket visible (titre, description coupée à 1 500 caractères, statut, dates) |

- **Les droits sont ceux de l'utilisateur du JWT**, jamais ceux que le modèle annonce : les outils
  appellent `ticketsService` (un `USER` ne voit que ses tickets) et n'ont aucun paramètre d'identité.
  Un ticket inexistant et un ticket non accessible donnent la même réponse.
- Les arguments proposés par le modèle sont **toujours validés côté serveur**, avec les validateurs de
  l'API (`parseTicketListQuery`, `parseId`) : champ inconnu, type ou valeur invalide = erreur renvoyée
  au modèle, sans accès à la base. `strict: false` est déclaré explicitement chez OpenAI ; chez DeepSeek
  le champ n'est pas documenté pour ce format et est omis (même effet).
- Les résultats ne contiennent ni auteur ni email. Le titre et la description des tickets sont du
  **texte écrit par des utilisateurs** : donnée non fiable, jamais une instruction. Le résultat le rappelle
  et le message système interdit d'obéir à un ticket. Comme les outils sont en lecture seule et
  s'exécutent avec les droits de l'appelant, un ticket piégé ne peut rien faire de plus.
- **Boucle bornée** : 3 appels au fournisseur par requête (2 tours d'outils puis la réponse), 4 appels
  d'outils par tour (les suivants reçoivent une erreur), résultat de 6 000 caractères au maximum,
  60 secondes au total. Une limite atteinte, une réponse incomplète pendant un appel d'outil ou un
  identifiant d'appel invalide donnent `502` : **aucune réussite n'est inventée** et aucun outil n'est
  exécuté dans ces cas. Une panne de base de données donne `500`.
- Les éléments renvoyés par le modèle (appels, raisonnement) sont rejoués tels quels à l'appel suivant,
  comme l'exigent OpenAI (sans stockage) et DeepSeek ; ils ne sont ni renvoyés au client ni journalisés.
  Avec un modèle qui raisonne, `AI_REASONING_EFFORT=none` simplifie le rejeu quand le modèle l'accepte.

### Coûts

Chaque question est facturée par le fournisseur. Le serveur limite à 30 questions par
utilisateur et 300 au total par 15 minutes (`src/middlewares/rate-limit.ts`), plafonne la
taille des messages et de la réponse, et ne relance jamais un appel. Ces limites comptent les
requêtes HTTP : avec la consultation des tickets, une requête peut coûter jusqu'à 3 appels au
fournisseur, avec le texte des tickets lus en plus. Ces compteurs sont en
mémoire : **ce n'est pas un plafond de dépense ferme**. Fixer aussi un budget maximal dans le
tableau de bord du fournisseur.

### Confidentialité

L'application **enregistre** les conversations en base (voir « Conversations enregistrées »), mais ne journalise jamais
le contenu des messages, des réponses ni des résultats d'outils (ces derniers ne sont même pas stockés), et n'envoie au
fournisseur aucune donnée d'identité (ni email, ni identifiant, ni rôle).
Les messages sont néanmoins **transmis à un tiers** : ne pas y saisir de mot de passe, de jeton ni
de donnée personnelle sensible. **Avec `AI_TICKET_TOOLS=true`, le titre et la description des tickets
consultés sont aussi transmis** : activer cette option engage cette décision de confidentialité. D'après la documentation officielle consultée le 16 novembre 2026 (à
revérifier, elle évolue) :

- **OpenAI** : les données envoyées à l'API ne servent pas à l'entraînement par défaut ;
  des journaux de détection d'abus sont conservés jusqu'à 30 jours ; la rétention nulle
  (*Zero Data Retention*) n'est pas activable par un paramètre, elle exige une approbation
  d'OpenAI pour l'organisation ; la résidence des données (ex. Europe) se choisit à la création
  du projet. Le serveur envoie `store: false` pour ne pas conserver l'état de la réponse.
- **DeepSeek** : la politique de confidentialité indique que les données sont traitées et
  stockées en République populaire de Chine ; aucune option de rétention nulle ni de refus
  d'entraînement propre à l'API n'a été trouvée ; un cache de prompts sur disque est actif par
  défaut ; les conditions demandent au développeur d'informer les utilisateurs finaux et de
  disposer d'une base légale.

Rien ici ne garantit l'absence de conservation côté fournisseur.

### Tests

Les tests automatisés remplacent `fetch` par un faux fournisseur, parfois scripté pour rejouer une
conversation d'outils : aucun appel réseau, aucune clé réelle (`npm test` vide les variables `AI_*`). Le comportement du modèle lui-même (refus du
hors-sujet, respect du message système) ne peut être vérifié que par un **test manuel** avec une
vraie clé, à lancer volontairement.

## Journal d'audit

Chaque action sensible réussie ajoute une ligne à la table `AuditLog` : qui
(`actorId`, `actorRole`), quoi (`action`), sur quel compte (`targetUserId`),
quand (`createdAt`) et quelques `metadata` non sensibles. Les lignes ne sont
jamais modifiées ni supprimées par l'application, et supprimer un compte ne les
supprime pas (les liens passent à `NULL`).

| Action                        | Déclencheur                                              | Acteur            |
| ----------------------------- | -------------------------------------------------------- | ----------------- |
| `USER_CREATED`                | `POST /users` (metadata : rôle)                          | Super Admin       |
| `USER_INVITATION_CREATED`     | code d'invitation créé (`POST /users/:id/invitation`)    | Super Admin       |
| `USER_INVITATION_SEND_FAILED` | Resend a refusé l'email (réponse `502`)                  | Super Admin       |
| `USER_DISABLED`               | désactivation (états avant/après, sessions révoquées)    | Super Admin       |
| `USER_ENABLED`                | réactivation (états avant/après)                         | Super Admin       |
| `INVITATION_ACCEPTED`         | compte activé avec son code                              | le compte lui-même |
| `PASSWORD_RESET_COMPLETED`    | mot de passe changé avec un code (sessions révoquées)    | le compte lui-même |
| `SUPER_ADMIN_BOOTSTRAPPED`    | script `bootstrap:super-admin`                           | aucun (CLI)       |

Pour les deux actions « le compte lui-même », l'acteur est le compte retrouvé
grâce au code, jamais une donnée du body. Ne sont **pas** tracés : les
connexions, les demandes de réinitialisation, les changements de statut de
ticket et les actions refusées (`401`, `403`, `404`, `409`).

L'audit est écrit dans la **même transaction** que l'action : si l'écriture de
l'audit échoue, l'action est annulée (`500`). Une invitation suit trois temps :
code et audit créés en transaction, email envoyé ensuite (jamais dans une
transaction), puis `USER_INVITATION_SEND_FAILED` si Resend refuse. L'absence de
cet événement après `USER_INVITATION_CREATED` signifie que l'email a été accepté.
Cette dernière écriture n'est pas atomique avec l'envoi, car un email ne
s'annule pas : si elle échoue, la réponse `502` est conservée.

Aucun mot de passe, JWT, code temporaire, hash ni email n'est stocké dans le
registre. `GET /audit-logs` (Super Admin) est paginé comme `GET /tickets`
(`page`, `limit`) et se filtre avec `action`, `actorId` et `targetUserId` ;
paramètre invalide ou inconnu : `400`.

Limites : le registre n'est protégé que par l'application (rien n'empêche une
personne ayant accès à PostgreSQL de le modifier) et il n'a pas de politique de
conservation.

## Limitation de débit

Les requêtes sont limitées par fenêtre de 15 minutes. Au-delà, l'API répond
`429` avec `{ "error": "trop de requêtes, réessayez plus tard" }` et les
en-têtes `Retry-After` et `RateLimit-*`.

| Cible                                              | Limite                         |
| -------------------------------------------------- | ------------------------------ |
| Toutes les routes                                  | 1 000 requêtes par IP          |
| `POST /auth/login`                                 | 60 tentatives par IP ; 5 échecs d'authentification (401) par IP + email |
| `POST /auth/request-password-reset`                | 5 par IP, 3 par adresse email  |
| `POST /auth/reset-password`, `/auth/accept-invitation` | 10 par IP (quota partagé)  |
| `POST /auth/refresh`                               | 30 par IP                      |

Pour le login, seuls les échecs d'authentification (`401`) consomment le quota
« IP + email » : les connexions réussies, les requêtes mal formées (`400`) et
les erreurs serveur (`500`) ne comptent pas. Les emails des clés sont normalisés
(minuscules, sans espaces) ; un email invalide ou trop long n'est jamais gardé
en mémoire. Les IPv6 d'un même réseau (/56) partagent un compteur.

**Compromis sur la réinitialisation.** Le quota de 3 demandes par adresse email
protège la boîte mail d'une victime et le quota d'envoi contre une rafale
depuis plusieurs IP. En contrepartie, un tiers peut empêcher cette adresse de
demander un nouveau code pendant au plus 15 minutes. Ce blocage n'est jamais
permanent (le compteur repart à zéro à la fin de la fenêtre), ne touche ni le
login ni un code déjà reçu, et ne révèle pas si le compte existe (le quota
s'applique à l'email saisi, qu'il existe ou non).

Les valeurs se règlent dans `src/middlewares/rate-limit.ts`. Les compteurs sont
gardés en mémoire : ils sont perdus au redémarrage et non partagés entre
plusieurs instances.

Derrière un proxy (hébergeur, reverse proxy), définir `TRUST_PROXY` avec le
nombre de proxys de confiance (par exemple `1`). La valeur par défaut `0`
ignore `X-Forwarded-For`, qui pourrait sinon être falsifié pour contourner les
limites.

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
