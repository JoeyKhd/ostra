import { notFound } from "next/navigation";
import { Suspense } from "react";

import { taskIdSchema } from "@ostra/protocol";

import { ReviewScreen } from "@/components/tasks/review/review-screen";

// The review screen (milestone 6's ticket 35, app-targets/m6/review-screen.md): a code task's pull
// requests, their findings and reviewers. The PR's tab lives in `?pr=`.
const ReviewPage = async ({ params }: { readonly params: Promise<{ "task-id": string }> }) => {
  const taskId = taskIdSchema.safeParse((await params)["task-id"]);
  if (!taskId.success) notFound();
  return (
    <Suspense>
      <ReviewScreen taskId={taskId.data} />
    </Suspense>
  );
};

export default ReviewPage;
