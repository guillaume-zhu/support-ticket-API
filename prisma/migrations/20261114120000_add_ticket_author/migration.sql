-- Migration additive : aucune donnée existante n'est supprimée ni modifiée.
-- Les anciens tickets gardent createdById = NULL (auteur inconnu).

-- AlterTable
-- updatedAt reçoit temporairement une valeur par défaut pour remplir les lignes existantes.
ALTER TABLE "Ticket" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Prisma gère updatedAt côté application : on retire la valeur par défaut.
ALTER TABLE "Ticket" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Ticket_createdById_idx" ON "Ticket"("createdById");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
