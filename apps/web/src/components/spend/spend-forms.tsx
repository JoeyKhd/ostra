"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ModelId, ProjectId } from "@ostra/protocol";

import { projectColour } from "@/components/shell/project-colour";
import { PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { formatTokenCount } from "@/components/insights/insights-words";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { Budget } from "./spend-view";
import { dayMonth, dollarsText, formatShare, formatUsd, parseDollars, parsePrice } from "./spend-words";

// The Spend page's properties panel (spend-budgets.md, "The properties panel"): a project's or the
// organization's monthly budget, and a model's four prices. Each save is an organization admin's,
// and the page's one primary button.

const Eyebrow = ({ children }: { readonly children: ReactNode }) => <div className="text-xs font-medium text-faint">{children}</div>;

/** A 34px input with a `$` prefix and an optional suffix, the value in mono. */
const MoneyInput = ({ id, value, onChange, placeholder, suffix, readOnly = false, invalid = false }: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly suffix?: string;
  readonly readOnly?: boolean;
  readonly invalid?: boolean;
}) => (
  <div className={cn(fieldClass, "flex h-[34px] items-center gap-2 font-mono text-[14px]", readOnly && "text-muted", invalid && "border-red")}>
    <span aria-hidden className="text-faint">
      $
    </span>
    <input
      id={id}
      inputMode="decimal"
      value={value}
      readOnly={readOnly}
      aria-invalid={invalid}
      placeholder={placeholder}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={cn("min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans placeholder:text-faint", readOnly ? "text-muted" : "text-text")}
    />
    {suffix === undefined ? null : (
      <span aria-hidden className="font-sans text-sm text-faint">
        {suffix}
      </span>
    )}
  </div>
);

export type BudgetTarget =
  | { readonly kind: "organization"; readonly name: string }
  | { readonly kind: "project"; readonly projectId: ProjectId; readonly name: string };

/** The budget form, for a project or the organization. */
export const BudgetForm = ({ target, budget, spentMicroUsd, current }: {
  readonly target: BudgetTarget;
  readonly budget: Budget | null;
  readonly spentMicroUsd: number;
  readonly current: boolean;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [text, setText] = useState(budget === null ? "" : dollarsText(budget.monthlyMicroUsd));
  const typed = parseDollars(text);
  const changed = typed !== null && typed !== budget?.monthlyMicroUsd;
  const projectId = target.kind === "project" ? target.projectId : null;
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: trpc.spend.pathKey() });
  };
  const save = useMutation(trpc.budgets.set.mutationOptions({ onSuccess: refresh }));
  const clear = useMutation(
    trpc.budgets.clear.mutationOptions({
      onSuccess: async () => {
        setText("");
        await refresh();
      },
    }),
  );
  const spent = formatUsd(spentMicroUsd);
  const share = budget?.share ?? null;
  const setBy = budget?.setBy ?? null;
  const status =
    budget === null
      ? target.kind === "project"
        ? t("budgets.statusNone", { spent })
        : t("budgets.statusNoneOrg", { spent })
      : budget.state === "reached"
        ? budget.reachedAt === null
          ? t("budgets.statusReachedNoDate", { spent })
          : t("budgets.statusReached", { spent, date: dayMonth(budget.reachedAt) })
        : t(budget.state === "warn" ? "budgets.statusWarned" : "budgets.statusUnder", { spent, share: share === null ? "–" : formatShare(share) });
  const below = typed !== null && changed && typed <= spentMicroUsd;
  const afterRaise = typed === null || typed === 0 ? null : spentMicroUsd / typed;
  const error = save.error ?? clear.error;
  const pending = save.isPending || clear.isPending;

  return (
    <form
      className="space-y-4"
      data-testid="budget-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed === null || !changed || !current) return;
        save.mutate({ projectId, monthlyUsd: typed / 1_000_000 });
      }}
    >
      <div>
        <Eyebrow>{target.kind === "project" ? t("budgets.eyebrowProject") : t("budgets.eyebrowOrg")}</Eyebrow>
        <h2 className="mt-1 flex items-center gap-2.5 text-[15px] font-semibold text-text">
          {target.kind === "project" ? <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(target.projectId) }} /> : null}
          <span className="truncate">{target.name}</span>
        </h2>
        <p className="mt-1 text-sm text-muted" data-testid="budget-status-line">
          {status}
        </p>
      </div>
      <div>
        <label htmlFor="budget-monthly" className="mb-1.5 block text-[12.5px] font-medium text-muted">
          {t("budgets.monthly")}
        </label>
        <MoneyInput id="budget-monthly" value={text} onChange={setText} placeholder={t("budgets.placeholder")} suffix="USD" readOnly={!current} invalid={text.trim() !== "" && typed === null} />
        <p className="mt-1.5 text-sm text-faint">{target.kind === "project" ? t("budgets.help") : t("budgets.helpOrg")}</p>
        {text.trim() !== "" && typed === null ? <p className="mt-1 text-[12.5px] text-red">{t("budgets.invalid")}</p> : null}
        {below ? <p className="mt-1 text-[12.5px] text-red" data-testid="budget-below">{t("budgets.belowSpend", { spent })}</p> : null}
        {current ? null : <p className="mt-1 text-[12.5px] text-faint">{t("budgets.pastMonth")}</p>}
      </div>
      {budget !== null && budget.state === "reached" && current ? (
        <div className="border-t border-line pt-3.5" data-testid="budget-waiting">
          <h3 className="mb-1 text-[12.5px] font-medium text-muted">{t("budgets.waiting")}</h3>
          <PropRow label={t("budgets.heldTurns")} labelWidth={120}>
            <span className="font-mono" data-testid="budget-held">{budget.heldTurns}</span>
          </PropRow>
          <PropRow label={t("budgets.queuedTasks")} labelWidth={120}>
            <span className="font-mono" data-testid="budget-queued">{budget.queuedTasks}</span>
          </PropRow>
          {changed && afterRaise !== null ? (
            <PropRow label={t("budgets.afterRaise")} labelWidth={120}>
              {afterRaise >= 1 ? <span className="text-red">{t("budgets.stillReached")}</span> : <span className="font-mono">{t("spend.used", { share: formatShare(afterRaise) })}</span>}
            </PropRow>
          ) : null}
        </div>
      ) : null}
      {setBy === null ? null : (
        <p className="border-t border-line pt-3.5 text-[12.5px] text-faint">
          {t("budgets.setBy", { name: setBy.name, date: dayMonth(setBy.at) })} · <span className="font-mono">{formatUsd(budget?.monthlyMicroUsd ?? 0)}</span>
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-[12.5px] text-red">
          {errorText(error)}
        </p>
      )}
      {current ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!changed || pending}>
            {save.isPending ? t("budgets.saving") : t("budgets.save")}
          </Button>
          {budget === null ? null : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" disabled={pending}>
                  {t("budgets.remove")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title={t("budgets.removeTitle", { name: target.name })}
                body={t("budgets.removeBody")}
                cancel={t("common.cancel")}
                action={t("budgets.remove")}
                onAction={() => {
                  clear.mutate({ projectId });
                }}
              />
            </AlertDialog>
          )}
        </div>
      ) : null}
    </form>
  );
};

type PriceKey = "inputPerMTok" | "outputPerMTok" | "cacheReadPerMTok" | "cacheWritePerMTok";
const PRICE_KEYS: readonly { readonly key: PriceKey; readonly label: "prices.fresh" | "prices.output" | "prices.cacheRead" | "prices.cacheWrite" }[] = [
  { key: "inputPerMTok", label: "prices.fresh" },
  { key: "outputPerMTok", label: "prices.output" },
  { key: "cacheReadPerMTok", label: "prices.cacheRead" },
  { key: "cacheWritePerMTok", label: "prices.cacheWrite" },
];

const priceText = (value: number | null): string => (value === null ? "" : String(value));

/** A model's four prices per million tokens, and where they came from. */
export const PriceForm = ({ modelId, month }: { readonly modelId: ModelId; readonly month: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useQuery(trpc.spend.modelPrice.queryOptions({ modelId, month }));
  const [texts, setTexts] = useState<Record<PriceKey, string> | null>(null);
  const [override, setOverride] = useState(false);
  const save = useMutation(
    trpc.providers.setModelPrice.mutationOptions({
      onSuccess: async () => {
        setOverride(false);
        setTexts(null);
        await queryClient.invalidateQueries({ queryKey: trpc.spend.pathKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.providers.models.pathKey() });
      },
    }),
  );
  const data = view.data;
  if (data === undefined) {
    return view.error === null ? (
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-[34px] w-full" />
      </div>
    ) : (
      <p role="alert" className="text-sm text-red">
        {errorText(view.error)}
      </p>
    );
  }
  const values: Record<PriceKey, string> = texts ?? {
    inputPerMTok: priceText(data.prices.inputPerMTok),
    outputPerMTok: priceText(data.prices.outputPerMTok),
    cacheReadPerMTok: priceText(data.prices.cacheReadPerMTok),
    cacheWritePerMTok: priceText(data.prices.cacheWritePerMTok),
  };
  const fromSource = data.priceSource === "endpoint" || data.priceSource === "catalog";
  const readOnly = fromSource && !override;
  const parsed = PRICE_KEYS.map(({ key }) => [key, parsePrice(values[key])] as const);
  const invalid = parsed.some(([, value]) => !value.ok);
  const priceOf = (key: PriceKey): number | null => {
    const found = parsed.find(([k]) => k === key)?.[1];
    return found?.ok === true ? found.value : null;
  };
  const missing = priceOf("inputPerMTok") === null || priceOf("outputPerMTok") === null;
  const changed = texts !== null;
  const provider = data.providerName;
  const sourceLine =
    data.priceSource === "endpoint"
      ? t("prices.sourceEndpoint", { provider })
      : data.priceSource === "catalog"
        ? t("prices.sourceCatalog", { provider })
        : data.priceSource === "admin"
          ? t("prices.sourceAdmin", { provider, date: data.priceChangedAt === null ? "" : dayMonth(data.priceChangedAt) })
          : t("prices.sourceNoneLine", { provider });
  const sourceShort =
    data.priceSource === "endpoint" ? t("prices.sourceEndpointShort") : data.priceSource === "catalog" ? t("prices.sourceCatalogShort") : data.priceSource === "admin" ? t("prices.sourceAdminShort") : null;
  const tokens = formatTokenCount(data.unpricedTokens);

  return (
    <form
      className="space-y-4"
      data-testid="price-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid || missing || !changed) return;
        save.mutate({
          modelId,
          inputPerMTok: priceOf("inputPerMTok"),
          outputPerMTok: priceOf("outputPerMTok"),
          cacheReadPerMTok: priceOf("cacheReadPerMTok"),
          cacheWritePerMTok: priceOf("cacheWritePerMTok"),
        });
      }}
    >
      <div>
        <Eyebrow>{t("prices.eyebrow")}</Eyebrow>
        <h2 className="mt-1 flex min-w-0 items-center gap-2.5 text-[15px] font-semibold text-text">
          {data.logoPath === null ? <CpuIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" /> : <img src={data.logoPath} alt="" className="size-[15px] shrink-0 opacity-75 invert" />}
          <span className={cn("truncate", data.custom && "font-mono")}>{data.custom ? data.endpointModelId : data.name}</span>
          {data.custom ? <Chip className="shrink-0">{t("spend.custom")}</Chip> : null}
        </h2>
        <p className="mt-1 text-sm text-muted">{sourceLine}</p>
      </div>
      <div>
        <PropRow label={t("prices.source")} labelWidth={150}>
          {sourceShort === null ? <span className="font-mono text-faint">{t("prices.sourceNone")}</span> : <span data-testid="price-source">{sourceShort}</span>}
        </PropRow>
        {data.unpricedTokens > 0 ? (
          <PropRow label={t("prices.unpriced")} labelWidth={150}>
            <span className="font-mono">{t("prices.unpricedTokens", { tokens })}</span>
          </PropRow>
        ) : null}
      </div>
      <div className="border-t border-line pt-3.5">
        <h3 className="mb-2.5 text-[12.5px] font-medium text-muted">{t("prices.group")}</h3>
        <div className="grid grid-cols-2 gap-3">
          {PRICE_KEYS.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`price-${key}`} className="mb-1.5 block text-[12.5px] font-medium text-muted">
                {t(label)}
              </label>
              <MoneyInput
                id={`price-${key}`}
                value={values[key]}
                readOnly={readOnly}
                invalid={!(parsed.find(([k]) => k === key)?.[1].ok ?? true)}
                onChange={(value) => {
                  setTexts({ ...values, [key]: value });
                }}
              />
            </div>
          ))}
        </div>
        {readOnly ? (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { setOverride(true); }}>
            {t("prices.override")}
          </Button>
        ) : null}
        <p className="mt-2.5 text-sm text-faint">{data.unpricedTokens > 0 ? t("prices.helpTokens", { tokens }) : t("prices.help")}</p>
        {invalid ? <p className="mt-1 text-[12.5px] text-red">{t("prices.invalid")}</p> : changed && missing ? <p className="mt-1 text-[12.5px] text-red">{t("prices.required")}</p> : null}
      </div>
      {save.error === null ? null : (
        <p role="alert" className="text-[12.5px] text-red">
          {errorText(save.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={!changed || invalid || missing || save.isPending || readOnly}>
        {save.isPending ? t("budgets.saving") : t("prices.save")}
      </Button>
    </form>
  );
};
