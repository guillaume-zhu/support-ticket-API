import { existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { parse } from "dotenv"
import { assertTestDatabase } from "./test-database.js"

const fileEnv = existsSync(".env.test") ? parse(readFileSync(".env.test")) : {}
const testUrl = assertTestDatabase(process.env.DATABASE_TEST_URL ?? fileEnv.DATABASE_TEST_URL)
const env = {
  ...process.env,
  DATABASE_URL: testUrl,
  DATABASE_TEST_URL: testUrl,
  ACCESS_TOKEN_SECRET: randomBytes(32).toString("base64url"),
  REFRESH_TOKEN_SECRET: randomBytes(32).toString("base64url"),
  RESEND_API_KEY: "test-only",
  RESEND_FROM_EMAIL: "test@example.invalid",
  NODE_ENV: "test",
  // Aucune clé d'IA réelle ne doit atteindre les tests, même présente dans le shell : jamais d'appel facturé.
  AI_PROVIDER: "",
  AI_API_KEY: "",
  AI_MODEL: "",
  AI_BASE_URL: "",
  AI_MAX_OUTPUT_TOKENS: "",
  AI_TIMEOUT_MS: "",
  AI_REASONING_EFFORT: "",
}

// Migrer uniquement la base de test validée avant de démarrer Vitest.
for (const [command, args] of [
  ["./node_modules/.bin/prisma", ["migrate", "deploy"]],
  ["./node_modules/.bin/vitest", ["run"]],
] as const) {
  const result = spawnSync(command, args, { env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
