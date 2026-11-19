-- Milestone 4, ticket 19: the account mails' deliveries (F-002, F-115, ADR 0053). Additive only.
-- CreateEnum
CREATE TYPE "AccountMailPurpose" AS ENUM ('invitation', 'email_verification', 'password_reset');

-- CreateTable
CREATE TABLE "account_mail_delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" "AccountMailPurpose" NOT NULL,
    "recordId" TEXT NOT NULL,
    "adapter" TEXT,
    "state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_mail_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_mail_delivery_organizationId_recordId_idx" ON "account_mail_delivery"("organizationId", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "account_mail_delivery_purpose_recordId_key" ON "account_mail_delivery"("purpose", "recordId");

-- AddForeignKey
ALTER TABLE "account_mail_delivery" ADD CONSTRAINT "account_mail_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

