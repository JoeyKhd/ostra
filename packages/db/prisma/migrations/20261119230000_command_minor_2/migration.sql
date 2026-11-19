-- Protocol minor 2 (milestone 3, ticket 01): the `question-answer`, `plan-answer` and
-- `snapshot-build` commands. Additive: enum values only. The rest of milestone 3's schema is
-- ticket 06's migration.

-- AlterEnum
ALTER TYPE "CommandKind" ADD VALUE 'question_answer';
ALTER TYPE "CommandKind" ADD VALUE 'plan_answer';
ALTER TYPE "CommandKind" ADD VALUE 'snapshot_build';
