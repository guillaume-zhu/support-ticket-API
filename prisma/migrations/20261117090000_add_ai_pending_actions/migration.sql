-- Migration additive : 2 types, 1 table, 2 valeurs ajoutées à l'énumération AuditAction. Aucune donnée existante n'est modifiée.
-- ALTER TYPE ... ADD VALUE : une valeur d'énumération ne peut pas être retirée facilement ; elle n'est pas utilisée dans cette migration
-- (PostgreSQL interdit d'utiliser une valeur ajoutée dans la transaction qui l'ajoute). Nécessite PostgreSQL 12 ou plus.

-- CreateEnum
CREATE TYPE "AiPendingActionKind" AS ENUM ('CREATE_TICKET', 'CHANGE_STATUS');

-- CreateEnum
CREATE TYPE "AiPendingActionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_TICKET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_TICKET_STATUS_CHANGED';

-- CreateTable
CREATE TABLE "AiPendingAction" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" "AiPendingActionKind" NOT NULL,
    "status" "AiPendingActionStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AiPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiPendingAction_userId_status_expiresAt_idx" ON "AiPendingAction"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AiPendingAction_conversationId_idx" ON "AiPendingAction"("conversationId");

-- CreateIndex
CREATE INDEX "AiPendingAction_expiresAt_idx" ON "AiPendingAction"("expiresAt");

-- AddForeignKey
ALTER TABLE "AiPendingAction" ADD CONSTRAINT "AiPendingAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPendingAction" ADD CONSTRAINT "AiPendingAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

