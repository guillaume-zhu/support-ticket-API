import "dotenv/config"
import * as argon2 from "argon2"
import password from "@inquirer/password"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client.js"

async function main() {
  const email = process.argv[2]?.trim().toLowerCase()

  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
        [...value].length >= 15 && Buffer.byteLength(value, "utf8") <= 1024
          ? true
          : "Utilise entre 15 caractères et 1024 octets.",
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

    const passwordHash = await argon2.hash(first, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    })

    await prisma.user.create({
      data: { email, passwordHash, role: "SUPER_ADMIN", status: "ACTIVE" },
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
