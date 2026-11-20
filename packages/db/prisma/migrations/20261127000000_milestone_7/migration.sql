-- Milestone 7 (ticket 04, spec section 5.3): a member's theme. Additive only: a new enum and a
-- column with its default, so every account, old and new, starts dark and no row is rewritten
-- by hand. The audit action `account.theme_changed` needs nothing here: `audit_entry.action` is
-- text, and the closed list of actions is the domain's (`packages/domain/src/audit/actions.ts`).

-- CreateEnum
CREATE TYPE "ThemePreference" AS ENUM ('dark', 'light', 'system');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "theme" "ThemePreference" NOT NULL DEFAULT 'dark';
