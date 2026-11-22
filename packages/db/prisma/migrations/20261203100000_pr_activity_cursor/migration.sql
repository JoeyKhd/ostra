-- 2026-11-22 (F-044, Q344): with webhooks off, the reconcile brings a task PR's comments, reviews
-- and line comments, from a cursor per open PR. Additive: one nullable column. Every PR open now
-- starts its cursor at this migration's time, so an upgrade reads only what comes after it and
-- never acts on an old comment or review again; a PR opened later starts with none, and its first
-- pass reads all of its comments.

-- AlterTable
ALTER TABLE "task_repo" ADD COLUMN     "prActivityCursor" JSONB;

-- Seed the open PRs' cursors at the upgrade.
UPDATE "task_repo"
SET "prActivityCursor" = jsonb_build_object(
  'prNumber', "prNumber",
  'comments', jsonb_build_object('at', (floor(extract(epoch from now()) * 1000))::bigint, 'seen', '[]'::jsonb),
  'reviews', jsonb_build_object('at', (floor(extract(epoch from now()) * 1000))::bigint, 'seen', '[]'::jsonb)
)
WHERE "state" = 'pr_open' AND "prNumber" IS NOT NULL;
