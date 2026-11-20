-- Milestone 6's review (ticket 41, F-113): the environment as a proposal's decision found it, so the
-- decided proposal's diff stays readable for 7 days. Additive only: one nullable column, written at
-- each decision from now on; a proposal decided before it has none and shows its outcome only.

-- AlterTable
ALTER TABLE "environment_proposal" ADD COLUMN     "baseline" JSONB;
