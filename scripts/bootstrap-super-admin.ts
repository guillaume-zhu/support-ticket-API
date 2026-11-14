import "dotenv/config"
import password from "@inquirer/password"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../src/generated/prisma/client.js"
import { hashPassword, isValidNewPassword } from "../src/utils/credentials.js"
import { recordAudit } from "../src/services/shared/audit.service.js"
import { isValidEmail, normalizeEmail } from "../src/utils/validation.js"

async function main() {
  const email = normalizeEmail(process.argv[2])

  if (!isValidEmail(email)) {
    console.error("Usage : npm run bootstrap:super-admin -- admin@example.com")
    process.exitCode = 1
    return
  }

  if (!process.env.DATABASE_URL || !process.stdin.isTTY) {
    console.error("DATABASE_URL et un terminal interactif sont nécessaires.")
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })

  try {
    const existing = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" } })
    if (existing) {
      console.error("Un Super Admin existe déjà.")
      process.exitCode = 1
      return
    }

    if (await prisma.user.findUnique({ where: { email } })) {
      console.error("Cet email est déjà utilisé.")
      process.exitCode = 1
      return
    }

    const first = await password({
      message: "Mot de passe (15 caractères minimum)",
      mask: "*",
      toggleMask: false,
      validate: (value) =>
        isValidNewPassword(value) ? true : "Utilise entre 15 caractères et 1024 octets.",
    })
    const confirmation = await password({
      message: "Confirmer le mot de passe",
      mask: "*",
      toggleMask: false,
    })

    if (first !== confirmation) {
      console.error("Les mots de passe ne correspondent pas.")
      process.exitCode = 1
      return
    }

    const passwordHash = await hashPassword(first)

    // Créer le compte et tracer l'événement ensemble (acteur : personne, c'est une commande CLI).
    await prisma.$transaction(async (tx) => {
      const superAdmin = await tx.user.create({
        data: { email, passwordHash, role: "SUPER_ADMIN", status: "ACTIVE" },
      })
      await recordAudit(tx, {
        action: "SUPER_ADMIN_BOOTSTRAPPED",
        actor: null,
        targetUserId: superAdmin.id,
        metadata: { source: "cli" },
      })
    })
    console.log(`Super Admin créé : ${email}`)
  } catch {
    console.error("Création impossible. Vérifie la connexion PostgreSQL.")
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

void main()
