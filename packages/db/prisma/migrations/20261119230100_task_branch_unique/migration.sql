-- Milestone 2's ticket 46 (F-016, Q136 item 10): two tasks of a project never share a branch. A
-- create writes the placeholder `pending` first and the real name after, in one transaction, so
-- the index leaves the placeholder out and two creates at once never wait on each other for it.
--
-- Additive. An install that somehow holds two tasks of a project with one branch name stops here
-- and names them: a branch already on a code host is never renamed by a migration. Rename one of
-- the tasks' branches by hand (on the code host and in "task" and "task_repo"), then run the
-- migration again.

DO $$
DECLARE
  clash record;
BEGIN
  SELECT "projectId", "branchName", string_agg("id", ', ' ORDER BY "createdAt") AS "taskIds"
    INTO clash
    FROM "task"
    WHERE "branchName" <> 'pending'
    GROUP BY "projectId", "branchName"
    HAVING count(*) > 1
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ostra: tasks % of project % share the branch %. Rename all but one of them by hand, then migrate again.',
      clash."taskIds", clash."projectId", clash."branchName";
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX "task_project_branch_unique" ON "task"("projectId", "branchName") WHERE ("branchName" <> 'pending');
