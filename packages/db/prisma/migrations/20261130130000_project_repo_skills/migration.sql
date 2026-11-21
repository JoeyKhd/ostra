-- F-021 (2026-11-21, the maintainer's "yes", ADR 0049 amended): whether each repo's own skills reach the
-- agent beside the profile's, a project admin's switch. Additive only: a column with its default,
-- on, so a project made before it gets the repos' skills as a new one does.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "repoSkills" BOOLEAN NOT NULL DEFAULT true;
