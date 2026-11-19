import type { TaskKind } from "@ostra/protocol";

import { formatAge } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { groupRules, shortMatch } from "./rule-drafts";
import type { MatchWords, RuleDraft } from "./rule-drafts";
import type { ProfileDefault, ProfileRow } from "./profile-types";

// The words of the agent profile screens (agent-profiles.md, agent-profile.md). Pure, so tested alone.

const kindKeys: Readonly<Record<TaskKind, MessageKey>> = {
  refine: "agentProfiles.kind.refine",
  code: "agentProfiles.kind.code",
  review: "agentProfiles.kind.review",
};

const kindTaskKeys: Readonly<Record<TaskKind, MessageKey>> = {
  refine: "agentProfiles.kindTasks.refine",
  code: "agentProfiles.kindTasks.code",
  review: "agentProfiles.kindTasks.review",
};

/** `code`, as the list's Default for column reads a kind. */
export const kindWord = (kind: TaskKind): string => t(kindKeys[kind]);

/** `code tasks`, as the panel's Default for rows read it. */
export const kindTasksWord = (kind: TaskKind): string => t(kindTaskKeys[kind]);

/** `calculator · code` per default. */
export const defaultEntry = (entry: ProfileDefault): string => t("agentProfiles.defaultEntry", { project: entry.projectName, kind: kindWord(entry.kind) });

/**
 * The Default for column: the entries that fit `max` characters, comma-separated, then `+N` for
 * the rest (agent-profiles.md: "one line, truncated, then `+2`"). Always at least one entry.
 */
export const defaultsLine = (defaults: readonly ProfileDefault[], max = 34): { readonly shown: string; readonly more: number } => {
  const entries = defaults.map(defaultEntry);
  let shown = "";
  let count = 0;
  for (const entry of entries) {
    const next = shown === "" ? entry : `${shown}, ${entry}`;
    if (count > 0 && next.length > max) break;
    shown = next;
    count += 1;
  }
  return { shown, more: entries.length - count };
};

/** The rules the panel shows: a preset's several stored rules are one. */
export const profileRules = (profile: Pick<ProfileRow, "rules">): readonly RuleDraft[] => groupRules(profile.rules);

/** A match in words, from `shortMatch` or `longMatch`. */
export const matchText = (words: MatchWords): string => (words.kind === "text" ? words.text : t(words.key, words.params));

/** The short match of a rule, for the list's panel. */
export const shortMatchText = (draft: RuleDraft): string => matchText(shortMatch(draft));

/** `2 members`, `1 member`. */
export const membersWord = (n: number): string => plural(n, "agentProfiles.membersOne", "agentProfiles.membersMany");

/** `plan first · 3 rules · calculator · code`: the narrow row's second line. */
export const narrowFacts = (profile: ProfileRow): string => {
  const rules = profileRules(profile).length;
  const facts = [
    ...(profile.planFirst ? [t("agentProfiles.narrowFacts.planFirst")] : []),
    ...(rules === 0 ? [] : [plural(rules, "agentProfiles.narrowFacts.rulesOne", "agentProfiles.narrowFacts.rulesMany")]),
    ...profile.defaults.map(defaultEntry),
  ];
  return facts.join(" · ");
};

/** `Claude Opus 5.5 · plan first · 3 rules`: the phone row's second line (agent-profiles.md, "Phone"). */
export const phoneFacts = (profile: ProfileRow): string => {
  const rules = profileRules(profile).length;
  return [
    profile.model === null ? t("agentProfiles.noModel") : modelName(profile.model),
    ...(profile.planFirst ? [t("agentProfiles.narrowFacts.planFirst")] : []),
    ...(rules === 0 ? [] : [plural(rules, "agentProfiles.narrowFacts.rulesOne", "agentProfiles.narrowFacts.rulesMany")]),
  ].join(" · ");
};

/** `3 Nov`: a day as the panel writes it. */
export const dayText = (at: number): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** `Edited 2h ago by Alex Kim`, or `Created 12 Nov` when never edited. */
export const lastChangeText = (profile: Pick<ProfileRow, "lastEdit" | "createdAt">, now: number = Date.now()): string => {
  const change = profile.lastEdit;
  if (change === null || change.action === "created") return t("agentProfiles.panel.created", { date: dayText(change?.at ?? profile.createdAt) });
  const name = change.actorName ?? t("taskPage.someone");
  const age = formatAge(change.at, now);
  return age === "now" ? t("agentProfiles.panel.editedJustNow", { name }) : t("agentProfiles.panel.edited", { age, name });
};

/** The model's name as the panel shows it: its display name, else the endpoint's ID. */
export const modelName = (model: { readonly displayName: string | null; readonly endpointModelId: string }): string => model.displayName ?? model.endpointModelId;
