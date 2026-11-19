-- Q133, milestone 2's ticket 44 (2026-11-19): a task needs you when the agent left files in the
-- workspace root, outside every repo. Additive (AGENTS.md: add first).

-- AlterEnum
ALTER TYPE "NeedsYouReason" ADD VALUE 'files_outside_repos';
