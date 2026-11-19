"use client";

import { InfoIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import type { EffortLevel } from "@ostra/protocol";

import { effortHint, effortLabel, offersChoice, runsAt } from "@/components/effort/effort-words";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The profile's Effort (F-137; agent-profile-effort.md): a field inside `Agent and model`, under
// the model. It offers exactly the levels the profile's agent can send for its model, `Default`
// first, each with its one-line hint. A stored level the model lacks is named with the level it
// runs at (ADR 0066's clamp), never an error.

/** What the field can offer, from the profile's agent and model. */
export type EffortChoice =
  | { readonly kind: "loading" }
  /** The model's levels as the agent can send them, `Default` first. `Default` alone offers no choice. */
  | { readonly kind: "levels"; readonly modelName: string; readonly levels: readonly EffortLevel[] }
  /** A custom model whose reasoning nobody has set: it doesn't reason until an admin says. */
  | { readonly kind: "unset-custom"; readonly modelName: string; readonly modelsHref: string | null }
  /** The agent can't set an effort at all (`reasoningEffort: "none"`). */
  | { readonly kind: "agent-none"; readonly agentName: string };

/** `agentProfiles.effortLevels`: the levels the profile's agent offers on a model (ticket 61). */
export type EffortOptions = RouterOutputs["agentProfiles"]["effortLevels"];

/**
 * The choice for the router's options: an agent that takes no level, a custom model nobody set
 * (with the link to Models for an admin), or the model's levels. `undefined` while they load.
 */
export const effortChoiceOf = (
  options: EffortOptions | undefined,
  names: { readonly model: string; readonly agent: string },
  modelsHref: string | null,
): EffortChoice => {
  if (options === undefined) return { kind: "loading" };
  if (!options.agentTakesEffort) return { kind: "agent-none", agentName: names.agent };
  if (options.customModel && options.reasoningSource === null) return { kind: "unset-custom", modelName: names.model, modelsHref };
  return { kind: "levels", modelName: names.model, levels: options.levels.map((view) => view.level) };
};

/** What the field shows for `value`: the list, or the quiet line that replaces it. */
export type EffortFieldView =
  | { readonly kind: "loading" }
  | { readonly kind: "list"; readonly levels: readonly EffortLevel[]; readonly chosen: EffortLevel | null; readonly stored: { readonly saved: EffortLevel; readonly runAt: EffortLevel } | null }
  | { readonly kind: "line"; readonly text: string; readonly link: string | null };

/** The field's state for a choice and the level in the draft. */
export const effortFieldView = (choice: EffortChoice, value: EffortLevel): EffortFieldView => {
  switch (choice.kind) {
    case "loading":
      return { kind: "loading" };
    case "agent-none":
      return { kind: "line", text: t("agentProfiles.editor.effort.agentNone", { agent: choice.agentName }), link: null };
    case "unset-custom":
      return { kind: "line", text: t("agentProfiles.editor.effort.unsetCustom", { model: choice.modelName }), link: choice.modelsHref };
    case "levels": {
      if (!offersChoice(choice.levels)) {
        return { kind: "line", text: t("agentProfiles.editor.effort.noReasoning", { model: choice.modelName }), link: null };
      }
      const runAt = runsAt(value, choice.levels);
      return runAt === null
        ? { kind: "list", levels: choice.levels, chosen: value, stored: null }
        : { kind: "list", levels: choice.levels, chosen: null, stored: { saved: value, runAt } };
    }
    default:
      return choice satisfies never;
  }
};

/** The level the properties panel shows: the saved one, or `Default` when the model offers no choice. */
export const panelEffort = (choice: EffortChoice, saved: EffortLevel): EffortLevel => {
  if (choice.kind === "levels" && offersChoice(choice.levels)) return saved;
  return "default";
};

const helpOf = (choice: EffortChoice): string | null =>
  choice.kind === "levels" && offersChoice(choice.levels) ? t("agentProfiles.editor.effort.help", { model: choice.modelName }) : null;

export const EffortField = ({ choice, value, readOnly, onChange }: {
  readonly choice: EffortChoice;
  readonly value: EffortLevel;
  readonly readOnly: boolean;
  readonly onChange: (level: EffortLevel) => void;
}) => {
  const id = useId();
  const view = effortFieldView(choice, value);
  const help = helpOf(choice);
  return (
    <div className="mt-3" data-testid="profile-effort" data-view={view.kind}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3">
        <span id={`${id}-label`} className="text-sm font-medium text-muted">{t("agentProfiles.editor.effort.label")}</span>
        {help === null ? null : <span className="text-[12.5px] text-faint">{help}</span>}
      </div>
      {view.kind === "loading" ? (
        <div aria-busy className="grid gap-2">
          {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-[26px] w-full" />)}
        </div>
      ) : view.kind === "line" ? (
        <p className="text-ui text-muted" data-testid="profile-effort-line">
          {view.text}
          {view.link === null ? null : (
            <>
              {" "}
              <Link href={view.link} className="text-teal hover:underline">{t("agentProfiles.editor.effort.setInModels")}</Link>
            </>
          )}
        </p>
      ) : readOnly ? (
        <p className="text-ui" data-testid="profile-effort-read">
          {effortLabel(view.chosen ?? value)}
          <span className="ml-3 text-muted">{effortHint(view.chosen ?? value, view.levels)}</span>
        </p>
      ) : (
        <>
          {view.stored === null ? null : (
            <p className="mb-1.5 flex items-center gap-1.5 text-ui text-text" data-testid="profile-effort-stored">
              <InfoIcon aria-hidden className="size-[14px] shrink-0 text-muted" />
              {t("agentProfiles.editor.effort.stored", {
                saved: effortLabel(view.stored.saved),
                model: choice.kind === "levels" ? choice.modelName : "",
                runAt: effortLabel(view.stored.runAt),
              })}
            </p>
          )}
          <RadioGroup
            aria-labelledby={`${id}-label`}
            value={view.chosen ?? ""}
            onValueChange={(next) => {
              const level = view.levels.find((candidate) => candidate === next);
              if (level !== undefined) onChange(level);
            }}
            className="border-y border-line"
          >
            {view.levels.map((level) => {
              const on = view.chosen === level;
              return (
                <label
                  key={level}
                  data-level={level}
                  data-chosen={on ? "true" : undefined}
                  className={cn(
                    "flex min-h-[34px] cursor-pointer flex-wrap items-center border-b border-line px-2 py-1.5 last:border-b-0 hover:bg-sel/50 max-[700px]:min-h-[52px]",
                    on && "bg-sel hover:bg-sel",
                  )}
                >
                  <span className="flex w-[220px] shrink-0 items-center gap-3 max-[700px]:w-full">
                    <RadioGroupItem value={level} className="size-4" />
                    <span className="text-body text-text">{effortLabel(level)}</span>
                  </span>
                  <span className="min-w-0 flex-1 text-ui text-muted max-[700px]:pl-7">{effortHint(level, view.levels)}</span>
                </label>
              );
            })}
          </RadioGroup>
        </>
      )}
      {view.kind === "list" && !readOnly ? <p className="mt-2 text-[12.5px] text-faint">{t("agentProfiles.editor.effort.note")}</p> : null}
    </div>
  );
};
