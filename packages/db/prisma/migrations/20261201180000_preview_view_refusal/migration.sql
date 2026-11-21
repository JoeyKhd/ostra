-- Milestone 8 (F-141, ADR 0068's note of 2026-11-21): why a box refused a view's `preview.open`,
-- kept on the view core closes for it, so the pane's stream can say why instead of the view
-- waiting for the sweep. Additive: one nullable column, `null` for every view no box refused.

-- AlterTable
ALTER TABLE "preview_view" ADD COLUMN     "refusal" TEXT;

-- ostra: only a closed view has a refusal.
ALTER TABLE "preview_view" ADD CONSTRAINT "preview_view_refusal_when_closed" CHECK ("refusal" IS NULL OR "state" = 'closed');
