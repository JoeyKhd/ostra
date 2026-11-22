-- 2026-11-22 (F-097, Q31): the project's setting "Make a ticket for every prompt task", kept on the
-- board the tickets go to. Additive: one column, off on every board, and at most one board of a
-- project with it on. Nothing is seeded.

-- AlterTable
ALTER TABLE "board" ADD COLUMN     "ticketsForPromptTasks" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "board_one_prompt_ticket_board_per_project" ON "board"("projectId") WHERE ("ticketsForPromptTasks");
