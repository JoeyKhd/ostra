-- Milestone 8 (ticket 25, F-144, ADR 0068): the panel's login session a native preview's one-time
-- code was minted in, so the preview's cookie lasts no longer than that session and ends when it's
-- signed out. Additive: one nullable column, `null` for a link's code and a CLI ticket.

-- AlterTable
ALTER TABLE "preview_code" ADD COLUMN     "authSessionId" TEXT;
