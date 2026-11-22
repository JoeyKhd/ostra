-- 2026-11-22 (F-096, F-079, Q343): a `docker` box or a `kubernetes` pod goes with its sidecar when
-- its session ends, and core records it released for that reason. Additive (AGENTS.md: add first).

-- AlterEnum
ALTER TYPE "BoxReleaseReason" ADD VALUE 'session_ended';
