-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" SERIAL NOT NULL,
    "queue" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "replica_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_event" (
    "id" SERIAL NOT NULL,
    "group_key" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "replica_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "group_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_fire" (
    "id" SERIAL NOT NULL,
    "schedule_key" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "replica_id" TEXT NOT NULL,
    "job_created" TIMESTAMPTZ(6) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "schedule_fire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_queue_job_id_idx" ON "job_run"("queue", "job_id");

-- CreateIndex
CREATE INDEX "group_event_group_key_idx" ON "group_event"("group_key");

-- CreateIndex
CREATE INDEX "schedule_fire_schedule_key_idx" ON "schedule_fire"("schedule_key");

