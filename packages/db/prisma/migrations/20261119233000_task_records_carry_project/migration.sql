-- F-086 (ADR 0026): every record inside a project carries it. A command, a blob and an upload may sit
-- outside a project, so their projectId is nullable, and their link to a task is the composite key
-- (taskId, projectId). Postgres checks a composite key only when every column is set (MATCH SIMPLE),
-- so a row with a taskId and no projectId named any task, or none, unchecked. These checks close
-- that: a row that names a task names its project too. No code wrote such a row, so they validate.
ALTER TABLE "command" ADD CONSTRAINT "command_task_carries_project" CHECK ("taskId" IS NULL OR "projectId" IS NOT NULL);
ALTER TABLE "blob" ADD CONSTRAINT "blob_task_carries_project" CHECK ("taskId" IS NULL OR "projectId" IS NOT NULL);
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_task_carries_project" CHECK ("taskId" IS NULL OR "projectId" IS NOT NULL);
