"use client";

import { useQuery } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { followDescription } from "./project-models-words";

// New project's `Keys` field (F-135, ticket 53; app-targets/m1/project-new grown): an organization
// admin picks whether the project follows the organization's default list or has its own, with
// the keys as checkboxes. Anyone else creates it on the default list and sees no field.

export type KeysChoice = { readonly own: boolean; readonly providerIds: ReadonlySet<string> };

export const defaultKeysChoice: KeysChoice = { own: false, providerIds: new Set() };

export const ProjectKeysField = ({ value, onChange }: { readonly value: KeysChoice; readonly onChange: (value: KeysChoice) => void }) => {
  const trpc = useTRPC();
  const providers = useQuery(trpc.providers.list.queryOptions());
  const keys = [...(providers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const onDefault = keys.filter((key) => key.onDefaultList);
  const pickMode = (mode: string) => {
    // Its own list starts from a copy of the default list (ADR 0065).
    onChange(mode === "own" ? { own: true, providerIds: value.own ? value.providerIds : new Set(onDefault.map((key) => key.id)) } : { own: false, providerIds: value.providerIds });
  };
  const toggle = (providerId: string, on: boolean) => {
    const next = new Set(value.providerIds);
    if (on) next.add(providerId);
    else next.delete(providerId);
    onChange({ own: true, providerIds: next });
  };
  return (
    <div data-testid="project-keys-field">
      <RadioGroup value={value.own ? "own" : "default"} onValueChange={pickMode} aria-label={t("projects.keys")} className="rows">
        {(["default", "own"] as const).map((mode) => (
          <label key={mode} className={cn("flex min-h-[38px] cursor-pointer flex-wrap items-center gap-x-3 px-3 py-1.5", (mode === "own") === value.own && "bg-sel")}>
            <RadioGroupItem value={mode} />
            <span className="text-text">{mode === "own" ? t("projectModels.own.label") : t("projectModels.follow.label")}</span>
            <span className="truncate text-faint">
              {mode === "own" ? t("projectModels.own.description") : followDescription(onDefault.map((key) => key.name))}
            </span>
          </label>
        ))}
      </RadioGroup>
      {value.own ? (
        <ul className="ml-7 mt-1" aria-label={t("projects.keys")}>
          {keys.map((key) => (
            <li key={key.id} className="border-b border-line last:border-b-0">
              <label className="flex h-10 cursor-pointer items-center gap-3 px-1">
                <Checkbox checked={value.providerIds.has(key.id)} onCheckedChange={(checked) => { toggle(key.id, checked === true); }} aria-label={key.name} />
                <span className="w-[180px] shrink-0 truncate font-mono text-ui text-text">{key.name}</span>
                <span className="min-w-0 truncate text-sm text-muted">
                  <span className="font-mono">{key.host}</span> · {plural(key.modelCount, "models.countOne", "models.countMany")}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
