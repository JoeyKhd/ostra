-- Protocol minor 7 (milestone 8, ticket 01, ADR 0068): the app's and the views' commands.
-- Additive: enum values only. The rest of milestone 8's schema is ticket 04's migration.

-- AlterEnum
ALTER TYPE "CommandKind" ADD VALUE 'app_start';
ALTER TYPE "CommandKind" ADD VALUE 'app_stop';
ALTER TYPE "CommandKind" ADD VALUE 'screenshot_take';
ALTER TYPE "CommandKind" ADD VALUE 'preview_open';
ALTER TYPE "CommandKind" ADD VALUE 'preview_close';
ALTER TYPE "CommandKind" ADD VALUE 'preview_input';
