-- Milestone 1's ticket 41 (Q129, ADR 0034): a box's sidecar connects as its own peer, with the task
-- token. Additive: the sidecar's presence and command counter on the box, and its commands.


-- AlterTable
ALTER TABLE "box" ADD COLUMN     "sidecarCommandSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sidecarConnectedAt" TIMESTAMP(3),
ADD COLUMN     "sidecarConnectionEpoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sidecarDisconnectedAt" TIMESTAMP(3),
ADD COLUMN     "sidecarLastSeenAt" TIMESTAMP(3),
ADD COLUMN     "sidecarReplicaId" TEXT;

-- CreateTable
CREATE TABLE "sidecar_command" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "CommandKind" NOT NULL,
    "body" JSONB NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "result" "CommandResult",
    "reason" TEXT,

    CONSTRAINT "sidecar_command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sidecar_command_taskId_idx" ON "sidecar_command"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "sidecar_command_boxId_seq_key" ON "sidecar_command"("boxId", "seq");

-- AddForeignKey
ALTER TABLE "sidecar_command" ADD CONSTRAINT "sidecar_command_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sidecar_command" ADD CONSTRAINT "sidecar_command_boxId_taskId_fkey" FOREIGN KEY ("boxId", "taskId") REFERENCES "box"("id", "taskId") ON DELETE CASCADE ON UPDATE CASCADE;

