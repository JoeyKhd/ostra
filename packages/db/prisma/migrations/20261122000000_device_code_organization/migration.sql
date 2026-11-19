-- Milestone 3 review fix (F-103): the organization a device code was approved in. Additive only.
-- AlterTable
ALTER TABLE "deviceCode" ADD COLUMN "organizationId" TEXT;
