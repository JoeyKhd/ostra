import type { Tone } from "@/components/ui/status";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// A runner's state in the panel's words (domain-model.md). The type comes from the database enum
// through the API, so a new state fails the typecheck here until it has a word and a tone.

export type RunnerState = RouterOutputs["runners"]["mine"][number]["state"];

export const runnerStateText = (state: RunnerState): string => {
  switch (state) {
    case "joining":
      return t("runners.state.joining");
    case "online":
      return t("runners.state.online");
    case "offline":
      return t("runners.state.offline");
    case "draining":
      return t("runners.state.draining");
    case "revoked":
      return t("runners.state.revoked");
    default:
      return state satisfies never;
  }
};

/** Green is online, amber a runner that is leaving (draining), grey every other state. */
export const runnerTone = (state: RunnerState): Tone => {
  switch (state) {
    case "online":
      return "green";
    case "draining":
      return "amber";
    case "joining":
    case "offline":
    case "revoked":
      return "grey";
    default:
      return state satisfies never;
  }
};
