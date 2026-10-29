import * as argon2 from "argon2"
import { randomUUID } from "node:crypto"
import { Router } from "express"
import { SignJWT } from "jose"
import type { PrismaClient } from "./generated/prisma/client.js"

const ISSUER = "support-ticket-api"
const AUDIENCE = "support-ticket-api"

function jwtKey(name: string): Buffer {
  const encoded = process.env[name]
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  const key = Buffer.from(encoded, "base64url")
  if (key.length !== 32) {
    throw new Error(`${name} doit contenir 32 octets aléatoires en base64url`)
  }
  return key
}

export function authRouter(prisma: PrismaClient) {
  const accessKey = jwtKey("ACCESS_TOKEN_SECRET")
  const refreshKey = jwtKey("REFRESH_TOKEN_SECRET")
  if (accessKey.equals(refreshKey)) {
    throw new Error("Les secrets JWT doivent être différents")
  }

  const router = Router()

  router.post("/login", async (req, res) => {
    const { email, password } = req.body ?? {}
    if (
      typeof email !== "string" ||
      email.trim() === "" ||
      email.length > 254 ||
      typeof password !== "string" ||
      password === "" ||
      Buffer.byteLength(password, "utf8") > 1024
    ) {
      return res.status(400).json({ error: "email et password requis" })
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    })
    if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
      return res.status(401).json({ error: "Identifiants invalides" })
    }
    if (!(await argon2.verify(user.passwordHash, password))) {
      return res.status(401).json({ error: "Identifiants invalides" })
    }

    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const accessToken = await new SignJWT({ token_use: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(accessKey)
    const refreshToken = await new SignJWT({ token_use: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setJti(sessionId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(refreshKey)

    await prisma.session.create({
      data: { id: sessionId, userId: user.id, expiresAt },
    })
    return res.json({ accessToken, refreshToken })
  })

  return router
}
