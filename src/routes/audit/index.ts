import { Router } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { auditController } from "../../controllers/audit/audit.controller.js"
import { authenticate, requireRoles } from "../../middlewares/auth.js"

export function auditRoutes(prisma: PrismaClient) {
  const router = Router()
  const audit = auditController(prisma)

  // Le registre est en lecture seule et réservé au Super Admin connecté.
  router.get("/", authenticate(prisma), requireRoles("SUPER_ADMIN"), audit.list)

  return router
}
