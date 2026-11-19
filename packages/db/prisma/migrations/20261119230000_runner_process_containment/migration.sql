-- Milestone 2's ticket 42 (2026-11-19): how a runner ends a task's processes together, as its
-- status says. Additive and nullable: a runner that hasn't said yet has none (AGENTS.md: add first).

-- CreateEnum
CREATE TYPE "ProcessContainment" AS ENUM ('container', 'job_object', 'cgroup', 'process_tree');

-- AlterTable
ALTER TABLE "runner" ADD COLUMN "processContainment" "ProcessContainment";
