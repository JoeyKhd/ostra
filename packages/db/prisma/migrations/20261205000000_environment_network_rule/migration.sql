-- Post-v1 (F-052, ADR 0073): an environment's network allowlist. Additive (AGENTS.md: add
-- first): one new table and its enum, nothing seeded, nothing dropped or renamed. An environment
-- with no rows is exactly today's behaviour, and no task spec changes for it.

-- CreateEnum
CREATE TYPE "EnvironmentNetworkRuleKind" AS ENUM ('host', 'cidr');

-- CreateTable
CREATE TABLE "environment_network_rule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "kind" "EnvironmentNetworkRuleKind" NOT NULL,
    "value" TEXT NOT NULL,
    "ports" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_network_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environment_network_rule_environmentId_kind_value_key" ON "environment_network_rule"("environmentId", "kind", "value");

-- CreateIndex
CREATE INDEX "environment_network_rule_environmentId_idx" ON "environment_network_rule"("environmentId");

-- AddForeignKey
ALTER TABLE "environment_network_rule" ADD CONSTRAINT "environment_network_rule_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_network_rule" ADD CONSTRAINT "environment_network_rule_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
