-- Milestone 4, several GitHub accounts (ticket 46, spec section 5.5, ADR 0065): the App's owner on
-- each connection, the linked installations, and `Repo`'s composite key to its installation.
-- Additive only. The backfill writes one `linked` row per installation an existing repo uses,
-- linked by nobody, before the key goes on, so the key holds for every existing row. Its account
-- is the repo's owner as of its full name; the next read fills the account's ID and kind.

-- CreateEnum
CREATE TYPE "InstallationState" AS ENUM ('linked', 'removed');

-- CreateEnum
CREATE TYPE "InstallationAccountKind" AS ENUM ('organization', 'user');

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "ownerAccountId" TEXT,
ADD COLUMN     "ownerLogin" TEXT;

-- CreateTable
CREATE TABLE "code_host_installation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountId" TEXT,
    "accountLogin" TEXT NOT NULL,
    "accountKind" "InstallationAccountKind",
    "state" "InstallationState" NOT NULL DEFAULT 'linked',
    "linkedByMemberId" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_host_installation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "code_host_installation_connectionId_installationId_key" ON "code_host_installation"("connectionId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_host_installation_organizationId_connectionId_installa_key" ON "code_host_installation"("organizationId", "connectionId", "installationId");

-- AddForeignKey
ALTER TABLE "code_host_installation" ADD CONSTRAINT "code_host_installation_connectionId_organizationId_fkey" FOREIGN KEY ("connectionId", "organizationId") REFERENCES "connection"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- backfill: linked installations (begin)
INSERT INTO "code_host_installation" ("id", "organizationId", "connectionId", "installationId", "accountLogin", "state", "linkedAt", "createdAt", "updatedAt")
SELECT DISTINCT ON (r."connectionId", r."installationId")
       gen_random_uuid()::text, r."organizationId", r."connectionId", r."installationId", split_part(r."fullName", '/', 1), 'linked', now(), now(), now()
FROM "repo" AS r
ORDER BY r."connectionId", r."installationId", r."createdAt"
ON CONFLICT DO NOTHING;
-- backfill: linked installations (end)

-- AddForeignKey
ALTER TABLE "repo" ADD CONSTRAINT "repo_organizationId_connectionId_installationId_fkey" FOREIGN KEY ("organizationId", "connectionId", "installationId") REFERENCES "code_host_installation"("organizationId", "connectionId", "installationId") ON DELETE NO ACTION ON UPDATE CASCADE;
