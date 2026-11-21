-- Milestone 8 (F-142, ADR 0068): a person named on a preview's `named` level is told, in the panel
-- and by mail, with a link to the preview's own page (`/previews/<id>`). Additive: one enum value.

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'preview_shared';
