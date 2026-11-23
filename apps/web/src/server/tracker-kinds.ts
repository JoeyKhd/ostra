import { headers } from "next/headers";

import type { KindCapabilities, PickerKinds } from "@/components/trackers/tracker-words";

import { getApiDeps } from "./deps";

/** Only what the tiles show, so nothing else of a declaration rides to the browser. */
const shown = (declared: KindCapabilities): KindCapabilities => ({
  agentSessions: declared.agentSessions,
  subIssues: declared.subIssues,
  magicWords: declared.magicWords,
  transitions: declared.transitions,
  jqlFilter: declared.jqlFilter,
});

/**
 * What each kind's adapter declares, for the picker's chips (F-152; trackers.md: "The chips are the
 * adapter's declared capabilities, not marketing"): the adapters' own declarations, read through
 * the API's tracker directory, so a kind with no connection yet still shows its own.
 */
export const trackerPickerKinds = async (): Promise<PickerKinds> => {
  // Reading the request's headers makes the page dynamic: nothing runs at build time.
  await headers();
  const { capabilities } = (await getApiDeps()).trackers;
  return { linear: shown(capabilities.linear), jira: shown(capabilities.jira) };
};
