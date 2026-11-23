"use client";

import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-098, F-104 (ticket 39; growing app-targets/m1/task): every PR of the task in its header, each with
// its repo, its state and `ostra/independent-review` on its newest head: "Waiting for an independent
// reviewer", "Only drivers approved", "Approved by Sam".

type TaskRepo = RouterOutputs["tasks"]["get"]["repos"][number];
type ReviewCheck = NonNullable<TaskRepo["pullRequests"][number]["reviewCheck"]>;

const REASON_WORDS: Readonly<Partial<Record<string, MessageKey>>> = {
  "no-approval": "taskPrs.review.waiting",
  "changes-requested": "taskPrs.review.changesRequested",
  "only-bots-approved": "taskPrs.review.onlyBots",
  "only-unlinked-approved": "taskPrs.review.onlyUnlinked",
  "only-drivers-approved": "taskPrs.review.onlyDrivers",
  "approval-is-stale": "taskPrs.review.stale",
};

/** The check's words: who approved, or why it waits. */
export const reviewCheckText = (check: ReviewCheck): string => {
  if (check.state === "passed") return t("taskPrs.review.approvedBy", { name: check.approver?.name ?? t("taskPage.someone") });
  const key = check.reason === null ? undefined : REASON_WORDS[check.reason];
  return t(key ?? "taskPrs.review.waiting");
};


