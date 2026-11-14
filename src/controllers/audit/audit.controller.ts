import type { Request, Response } from "express"
import type { PrismaClient } from "../../generated/prisma/client.js"
import { auditService } from "../../services/shared/audit.service.js"
import { parseAuditLogQuery } from "../../utils/validation.js"

export function auditController(prisma: PrismaClient) {
  const service = auditService(prisma)

  return {
    // Lister le registre d'audit : pagination et filtres validés avant toute requête en base.
    list: async (req: Request, res: Response) => {
      const parsed = parseAuditLogQuery(req.query)
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error })
      }
      return res.json(await service.list(parsed.value))
    },
  }
}
