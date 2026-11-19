-- Reasoning effort (F-137, ADR 0066, milestone 4's ticket 56; spec section 5.6). Additive only:
-- a new enum, a command kind, and new columns with defaults, so every existing profile and task
-- reads `default`. Nothing to backfill: the next catalog sync fills `catalogReasoning`.

-- CreateEnum
CREATE TYPE "EffortLevel" AS ENUM ('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on');

-- AlterEnum
ALTER TYPE "CommandKind" ADD VALUE 'set_effort';

-- AlterTable
ALTER TABLE "model" ADD COLUMN "catalogReasoning" JSONB,
ADD COLUMN "adminReasoning" JSONB;

-- AlterTable
ALTER TABLE "agent_profile" ADD COLUMN "effort" "EffortLevel" NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "task" ADD COLUMN "effort" "EffortLevel" NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "turn" ADD COLUMN "effort" "EffortLevel",
ADD COLUMN "effortAdjustedFrom" "EffortLevel",
ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "session" ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0;
