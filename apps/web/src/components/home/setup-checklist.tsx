"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Section } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { SetupSteps, SetupStepsLoading, settledCount } from "./setup-steps";

/**
 * The first-run checklist (F-076), on Home for a new organization: in its order, each step where
 * `setup.status` says it stands. Done and skipped steps count toward the progress; the Linear step
 * can be set aside with "Skip for now" (an admin's action), and is never counted against setup
 * being `complete`.
 */
export const SetupChecklist = ({ admin }: { readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.setup.status.queryOptions());
  const skip = useMutation(
    trpc.setup.skip.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
      },
    }),
  );
  if (status.data === undefined) return <SetupStepsLoading />;
  // Setup is done without Linear (F-076): the optional step never keeps the checklist up.
  if (status.data.complete) return null;
  return (
    <Section
      title={t("checklist.title")}
      end={<span className="font-mono text-faint">{t("checklist.progress", { done: settledCount(status.data.steps), total: status.data.steps.length })}</span>}
    >
      <SetupSteps
        steps={status.data.steps}
        next={status.data.next}
        admin={admin}
        skip={{
          run: () => {
            skip.mutate({ step: "tracker" });
          },
          pending: skip.isPending,
        }}
      />
    </Section>
  );
};
