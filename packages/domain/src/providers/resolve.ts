import type { ModelId, ProviderId } from "@ostra/protocol";

import { modelNameKey } from "./model-name.ts";
import type { ModelName } from "./model-name.ts";

// Keys per project (F-135, ADR 0065, Q270 to Q278): which provider serves a model in a project.
// In each project each model is served by exactly one provider on its list: the one an
// organization admin chose there, or else the only provider on the list that lists it. Nothing but
// an admin's save moves a model to another provider, and nothing falls back to another key. Pure.

/** A provider's listing of a model: one `Model` row. */
export type ListedModel = {
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  readonly name: ModelName;
  /** The endpoint's own ID: one provider may list a name twice, as `x` and `x:batch`. */
  readonly endpointModelId: string;
  /** Whether the provider's endpoint still lists it. */
  readonly listed: boolean;
};

/** A list's choice for one model name: the `Model` row an admin, the keep rule or the upgrade chose. */
export type ModelChoiceRow = { readonly modelKey: string; readonly modelId: ModelId };

export type Resolution =
  | { readonly ok: true; readonly providerId: ProviderId; readonly modelId: ModelId }
  /** `no-provider`: nothing on the list serves it. `not-listed`: the chosen row's provider no longer lists it, or left the list. */
  | { readonly ok: false; readonly reason: "no-provider" | "not-listed" };

/**
 * The provider and model row that serve `name` on a list. A choice wins; a chosen row that's no
 * longer usable is `not-listed`, never another provider. Without a choice, the only provider on
 * the list that lists the model serves it, from its plain row when it lists the name twice; none,
 * or two providers with no choice (which the keep rule never leaves), is `no-provider`.
 */
export const resolveProjectModel = (
  list: readonly ProviderId[],
  choices: readonly ModelChoiceRow[],
  models: readonly ListedModel[],
  name: ModelName,
): Resolution => {
  const key = modelNameKey(name);
  const onList = new Set<string>(list);
  const choice = choices.find((row) => row.modelKey === key);
  if (choice !== undefined) {
    const chosen = models.find((model) => model.modelId === choice.modelId);
    if (chosen === undefined || !chosen.listed || !onList.has(chosen.providerId) || modelNameKey(chosen.name) !== key) {
      return { ok: false, reason: "not-listed" };
    }
    return { ok: true, providerId: chosen.providerId, modelId: chosen.modelId };
  }
  const serving = models.filter((model) => model.listed && onList.has(model.providerId) && modelNameKey(model.name) === key);
  const providers = new Set(serving.map((model) => model.providerId));
  const [only] = [...serving].sort(byPlainRowFirst);
  if (only === undefined || providers.size !== 1) {
    return { ok: false, reason: "no-provider" };
  }
  return { ok: true, providerId: only.providerId, modelId: only.modelId };
};

/** A `:variant` tag on an endpoint's model ID (`:batch`, `:free`), which the catalog match ignores. */
const VARIANT_TAG = /:[^/:]+$/;

/**
 * One provider's rows for one name, the plain one first: an endpoint that lists `x` and `x:batch`
 * serves the name from `x`, and otherwise from its lowest row ID, so it never moves on its own.
 */
const byPlainRowFirst = (a: ListedModel, b: ListedModel): number => {
  const tagged = Number(VARIANT_TAG.test(a.endpointModelId)) - Number(VARIANT_TAG.test(b.endpointModelId));
  if (tagged !== 0) {
    return tagged;
  }
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
};

/** Every model name some row of these providers lists, once, in a stable order. */
const namesOf = (models: readonly ListedModel[]): readonly ModelName[] => {
  const seen = new Map<string, ModelName>();
  for (const model of models) {
    const key = modelNameKey(model.name);
    if (!seen.has(key)) {
      seen.set(key, model.name);
    }
  }
  return [...seen.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, name]) => name);
};

export type ProviderChangeLine = {
  readonly name: ModelName;
  readonly before: { readonly providerId: ProviderId; readonly modelId: ModelId } | null;
  readonly after: { readonly providerId: ProviderId; readonly modelId: ModelId } | null;
  /** `keeps` its provider, `moves` to another, `loses` its provider, or `gains` one it lacked. */
  readonly change: "keeps" | "moves" | "loses" | "gains";
};

export type ProviderChangePlan = {
  /** Every model name the change touches, with what serves it before and after. */
  readonly lines: readonly ProviderChangeLine[];
  /** The choices the keep rule records: a model that would get a second provider keeps the one serving it. */
  readonly keep: readonly ModelChoiceRow[];
  /** Choices whose row's provider leaves the list: dropped with it. */
  readonly drop: readonly string[];
};

/**
 * What a list change does to every model (ADR 0065): which keep, move, lose or gain a provider,
 * and the choices to record so nothing moves on its own. A save shows the lines first and applies
 * only them.
 */
export const planProviderChange = (
  before: { readonly list: readonly ProviderId[]; readonly choices: readonly ModelChoiceRow[] },
  after: readonly ProviderId[],
  models: readonly ListedModel[],
): ProviderChangePlan => {
  const afterSet = new Set<string>(after);
  const rowsById = new Map(models.map((model) => [model.modelId, model] as const));
  const drop = before.choices.filter((choice) => {
    const row = rowsById.get(choice.modelId);
    return row === undefined || !afterSet.has(row.providerId);
  });
  const dropped = new Set(drop.map((choice) => choice.modelKey));
  const kept = before.choices.filter((choice) => !dropped.has(choice.modelKey));
  const keep: ModelChoiceRow[] = [];
  const lines: ProviderChangeLine[] = [];
  const touched = models.filter((model) => before.list.includes(model.providerId) || afterSet.has(model.providerId));
  for (const name of namesOf(touched)) {
    const was = resolveProjectModel(before.list, before.choices, models, name);
    let now = resolveProjectModel(after, kept, models, name);
    if (was.ok && afterSet.has(was.providerId) && (!now.ok || now.providerId !== was.providerId)) {
      // The keep rule: the provider serving it stays its provider.
      keep.push({ modelKey: modelNameKey(name), modelId: was.modelId });
      now = { ok: true, providerId: was.providerId, modelId: was.modelId };
    }
    const beforeServed = was.ok ? { providerId: was.providerId, modelId: was.modelId } : null;
    const afterServed = now.ok ? { providerId: now.providerId, modelId: now.modelId } : null;
    const change =
      beforeServed === null
        ? afterServed === null
          ? null
          : "gains"
        : afterServed === null
          ? "loses"
          : afterServed.providerId === beforeServed.providerId
            ? "keeps"
            : "moves";
    if (change !== null) {
      lines.push({ name, before: beforeServed, after: afterServed, change });
    }
  }
  return { lines, keep, drop: drop.map((choice) => choice.modelKey) };
};

/**
 * The keep rule for a provider's daily model refresh: on each list, a model the refresh gives a
 * second provider keeps the one serving it, recorded as a choice.
 */
export const keepChoicesOnRefresh = <L extends { readonly list: readonly ProviderId[]; readonly choices: readonly ModelChoiceRow[] }>(
  lists: readonly L[],
  before: readonly ListedModel[],
  after: readonly ListedModel[],
): readonly { readonly list: L; readonly keep: readonly ModelChoiceRow[] }[] =>
  lists.map((list) => {
    const keep: ModelChoiceRow[] = [];
    for (const name of namesOf(after)) {
      const was = resolveProjectModel(list.list, list.choices, before, name);
      const now = resolveProjectModel(list.list, list.choices, after, name);
      if (was.ok && (!now.ok || now.providerId !== was.providerId) && after.some((model) => model.modelId === was.modelId && model.listed)) {
        keep.push({ modelKey: modelNameKey(name), modelId: was.modelId });
      }
    }
    return { list, keep };
  });

export type ProviderGate =
  | { readonly kind: "open" }
  /** The project now serves the model from another provider: the next turn starts in a fresh box on it. */
  | { readonly kind: "moved"; readonly providerId: ProviderId; readonly modelId: ModelId }
  /** Nothing on the project's list serves it any more: no turn starts. */
  | { readonly kind: "none"; readonly modelName: ModelName };

/**
 * The check every turn start makes (ADR 0065): a turn never starts on a provider its project no
 * longer allows. `session` is what the session recorded at its start.
 */
export const providerGate = (
  session: { readonly providerId: ProviderId; readonly modelId: ModelId; readonly modelName: ModelName },
  project: { readonly list: readonly ProviderId[]; readonly choices: readonly ModelChoiceRow[]; readonly models: readonly ListedModel[] },
): ProviderGate => {
  const now = resolveProjectModel(project.list, project.choices, project.models, session.modelName);
  if (!now.ok) {
    return { kind: "none", modelName: session.modelName };
  }
  return now.providerId === session.providerId && now.modelId === session.modelId ? { kind: "open" } : { kind: "moved", providerId: now.providerId, modelId: now.modelId };
};
