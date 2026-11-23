-- Post-v1 (F-057, ADR 0074): Slack notifications, per member. Additive (AGENTS.md: add first):
-- one enum value and two tables, nothing seeded, nothing dropped or renamed. An older release reads
-- every existing row: `slack` is a value it never writes, and no preference, notification or
-- delivery row changes. Every secret column holds a `SecretRef`, never a value.

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'slack';

-- CreateEnum
CREATE TYPE "SlackInstallState" AS ENUM ('pending', 'active', 'failed', 'revoked');

-- CreateTable
CREATE TABLE "slack_installation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "state" "SlackInstallState" NOT NULL DEFAULT 'pending',
    "clientId" TEXT NOT NULL,
    "clientSecretSecretRef" TEXT NOT NULL,
    "botTokenSecretRef" TEXT,
    "refreshTokenSecretRef" TEXT,
    "teamId" TEXT,
    "teamName" TEXT,
    "botUserId" TEXT,
    "appId" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenExpiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "oauthStateHash" TEXT,
    "oauthStateExpiresAt" TIMESTAMP(3),
    "installedByMemberId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_identity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "matchedEmail" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_installation_organizationId_key" ON "slack_installation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_identity_organizationId_memberId_key" ON "slack_identity"("organizationId", "memberId");

-- CreateIndex
CREATE INDEX "slack_identity_organizationId_slackUserId_idx" ON "slack_identity"("organizationId", "slackUserId");

-- AddForeignKey
ALTER TABLE "slack_installation" ADD CONSTRAINT "slack_installation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_identity" ADD CONSTRAINT "slack_identity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_identity" ADD CONSTRAINT "slack_identity_memberId_organizationId_fkey" FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
