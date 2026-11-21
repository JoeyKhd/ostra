-- Milestone 8's core (ticket 15, F-121, F-140, ADR 0068): a finding's attachments, and where an
-- environment proposal came from ("Keep it" on a port an agent announced, or the onboarding task).
-- Additive: one new enum and two new columns, each with a default, so nothing is backfilled.

-- CreateEnum
CREATE TYPE "EnvironmentProposalSource" AS ENUM ('onboarding', 'kept');

-- AlterTable
ALTER TABLE "environment_proposal" ADD COLUMN     "source" "EnvironmentProposalSource" NOT NULL DEFAULT 'onboarding';

-- AlterTable
ALTER TABLE "finding" ADD COLUMN     "attachmentIds" JSONB NOT NULL DEFAULT '[]';

-- ostra: a finding names at most 5 attachments, as an array of the runner's IDs.
ALTER TABLE "finding" ADD CONSTRAINT "finding_attachment_ids_array" CHECK (jsonb_typeof("attachmentIds") = 'array' AND jsonb_array_length("attachmentIds") <= 5);
