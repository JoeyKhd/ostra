-- Milestone 8 (ticket 19, F-141, ADR 0068): what a runner reports it can show of a preview, from
-- its `hello` and `status` at protocol minor 7 (`previewSupportSchema`: the browser view and the
-- tunnel). Core checks it with `isPreviewable` before a view opens, and fails closed without it.
-- Additive: one nullable column, `null` for every runner until it reports.

-- AlterTable
ALTER TABLE "runner" ADD COLUMN "preview" JSONB;
