-- Milestone 8 (ticket 26, F-144, ADR 0068): the preview domain's last check, kept per install for
-- Instance › Previews (the domain it ran on, its answer, when and by whom), and the framing header
-- core's proxy replaced on a native view's answers, for the pane's notice. Additive: nullable
-- columns only, `null` on every existing row.

-- AlterTable
ALTER TABLE "instance_setting" ADD COLUMN     "previewCheck" JSONB,
ADD COLUMN     "previewCheckAt" TIMESTAMP(3),
ADD COLUMN     "previewCheckByUserId" TEXT,
ADD COLUMN     "previewCheckDomain" TEXT;

-- AlterTable
ALTER TABLE "preview_view" ADD COLUMN     "framingHeader" TEXT,
ADD COLUMN     "framingValue" TEXT;
