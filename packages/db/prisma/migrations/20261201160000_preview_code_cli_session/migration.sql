-- Milestone 8 (ticket 23, F-143, ADR 0068): the CLI session an `ostra preview` ticket was issued
-- to, so core checks that session again while the tunnel lasts and ends the tunnel once it's
-- revoked. Additive: one nullable column, `null` for a native preview's one-time code.

-- AlterTable
ALTER TABLE "preview_code" ADD COLUMN     "cliSessionId" TEXT;

-- CreateIndex
CREATE INDEX "preview_code_cliSessionId_idx" ON "preview_code"("cliSessionId");

-- AddForeignKey
ALTER TABLE "preview_code" ADD CONSTRAINT "preview_code_cliSessionId_fkey" FOREIGN KEY ("cliSessionId") REFERENCES "cli_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
