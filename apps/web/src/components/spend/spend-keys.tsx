"use client";

import { ArrowRightIcon, CircleAlertIcon, CpuIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { ModelId, ProviderId } from "@ostra/protocol";

import { formatTokenCount } from "@/components/insights/insights-words";
import { formatLabel } from "@/components/models/add-provider-form";
import { KeyLogo } from "@/components/models/keys-sections";
import { projectColour } from "@/components/shell/project-colour";
import { PropRow } from "@/components/shell/page-frame";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import type { SpendMonth } from "./spend-view";
import { formatShare, formatUsd, monthName } from "./spend-words";

// Organization › Spend, Keys (spend-keys.md, F-135/c13, ADR 0055 "Spend per key"): one row per model
// provider, each one client's key, with the month's four token kinds and its spend, as `spend.month`'s
// `byProvider` gives them (every key, one that spent nothing at $0.00), and the panel a row opens:
// the key's month, the models it served, the projects that use it, and that budgets stay per project.
// The host, the format and the projects come from `providers.list` (the page is an admin's).

type KeyLine = SpendMonth["byProvider"][number];
type Provider = RouterOutputs["providers"]["list"][number];

/** One row of the Keys table: the month's figures for a key, and the key as Models lists it. */
export type KeyRow = {
  readonly line: KeyLine;
  /** `undefined` while `providers.list` loads, or if it failed: the row draws without its host. */
  readonly provider: Provider | undefined;
};

export const keyRowsOf = (
  data: SpendMonth,
  providers: readonly Provider[] | undefined,
): readonly KeyRow[] =>
  data.byProvider.map((line) => ({
    line,
    provider: providers?.find((provider) => provider.id === line.providerId),
  }));

const tokensOf = (
  line: Pick<KeyLine, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): number => line.inputTokens + line.outputTokens + line.cacheReadTokens + line.cacheWriteTokens;

/** The models on a key whose tokens this month had no price. */
const unpricedModelsOf = (
  data: SpendMonth,
  providerId: ProviderId,
): readonly SpendMonth["byModel"][number][] =>
  data.byModel.filter((model) => model.providerId === providerId && model.unpricedTokens > 0);

const unpricedTitle = (data: SpendMonth, line: KeyLine): string =>
  t("spend.keys.unpricedTitle", {
    tokens: formatTokenCount(line.unpricedTokens),
    models: unpricedModelsOf(data, line.providerId)
      .map((model) => model.name)
      .join(", "),
  });

/** A token figure, or a `--faint` `–` for none. */
const TokenFigure = ({ n }: { readonly n: number }) =>
  n === 0 ? <span className="text-faint">–</span> : <>{formatTokenCount(n)}</>;

/** The Spent figure: `$0.00` in `--faint` for none, and the no-price mark before a key with unpriced tokens. */
const SpentFigure = ({ data, line }: { readonly data: SpendMonth; readonly line: KeyLine }) => {
  const amount = formatUsd(line.spentMicroUsd);
  if (line.unpricedTokens > 0) {
    const title = unpricedTitle(data, line);
    return (
      <Tooltip content={title}>
        <span className="inline-flex items-center gap-1.5" data-testid="key-unpriced">
          <CircleAlertIcon
            role="img"
            aria-label={title}
            className="size-[13px] shrink-0 stroke-[1.75] text-red"
          />
          {amount}
        </span>
      </Tooltip>
    );
  }
  return line.spentMicroUsd === 0 ? <span className="text-faint">{amount}</span> : <>{amount}</>;
};

/** The Key cell: the logo, the name, and the host where the column has room for it. */
const KeyName = ({ row }: { readonly row: KeyRow }) => (
  <span className="flex min-w-0 items-center gap-2.5">
    {row.provider === undefined ? (
      <span aria-hidden className="size-[15px] shrink-0" />
    ) : (
      <KeyLogo host={row.provider.host} />
    )}
    <span className="min-w-0 max-w-full shrink-0 truncate font-mono text-ui text-text">
      {row.line.name}
    </span>
    {row.provider === undefined ? null : (
      // The host gives way first, as on Models: shown from 1600px wide, or below 1280px where no panel sits beside the table.
      <span className="hidden min-w-0 truncate font-mono text-[12.5px] text-faint max-[1279px]:block min-[1600px]:block">
        {row.provider.host}
      </span>
    )}
  </span>
);

const numberCell = "pr-4 text-[13.5px]";

/** Four 40px rows of bars where the keys will go, under the table's head (spend-keys.md, Loading). */
export const KeysSkeleton = () => (
  <div data-testid="spend-keys-loading">
    <div className="md:hidden">
      <SkeletonRows rows={4} height="h-[58px]" />
    </div>
    <Table className="hidden md:table" aria-busy>
      <KeysColumns />
      <KeysHead />
      <TableBody>
        {["w-[170px]", "w-[200px]", "w-[160px]", "w-[140px]"].map((width) => (
          <TableRow key={width} className="h-10">
            <TableCell className="pl-1.5">
              <Skeleton className={width} />
            </TableCell>
            {["w-[44px]", "w-[36px]", "w-[44px]", "w-[40px]"].map((bar, i) => (
              <TableCell
                key={`${bar}-${String(i)}`}
                className={cn("pr-4", i === 0 ? "" : "hidden min-[1100px]:table-cell")}
              >
                <Skeleton className={cn("ml-auto", bar)} />
              </TableCell>
            ))}
            <TableCell className="pr-1.5">
              <Skeleton className="ml-auto w-[60px]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

/** `Key` 1fr, the four token kinds (92, 72, 90, 94px; below 1100px one 96px `Tokens`), `Spent` 104px. */
const KeysColumns = () => (
  <colgroup>
    <col />
    <col className="hidden w-[92px] min-[1100px]:table-column" />
    <col className="hidden w-[72px] min-[1100px]:table-column" />
    <col className="hidden w-[90px] min-[1100px]:table-column" />
    <col className="hidden w-[94px] min-[1100px]:table-column" />
    <col className="w-[96px] min-[1100px]:hidden" />
    <col className="w-[104px]" />
  </colgroup>
);

const KeysHead = () => (
  <TableHeader>
    <TableRow>
      <TableHead className="pl-1.5">{t("spend.keys.col")}</TableHead>
      <TableHead num className="hidden pr-4 min-[1100px]:table-cell">
        {t("spend.colFresh")}
      </TableHead>
      <TableHead num className="hidden pr-4 min-[1100px]:table-cell">
        {t("spend.colOutput")}
      </TableHead>
      <TableHead num className="hidden pr-4 min-[1100px]:table-cell">
        {t("spend.colCacheRead")}
      </TableHead>
      <TableHead num className="hidden pr-4 min-[1100px]:table-cell">
        {t("spend.colCacheWrite")}
      </TableHead>
      <TableHead num className="pr-4 min-[1100px]:hidden">
        {t("spend.colTokens")}
      </TableHead>
      <TableHead num className="pr-1.5">
        {t("spend.colSpent")}
      </TableHead>
    </TableRow>
  </TableHeader>
);

/** The Keys table, and at phone width its two-line rows. A row selects its key in the panel. */
export const KeysTable = ({
  data,
  rows,
  selected,
  onSelect,
}: {
  readonly data: SpendMonth;
  readonly rows: readonly KeyRow[];
  readonly selected: ProviderId | null;
  readonly onSelect: (providerId: ProviderId) => void;
}) => (
  <>
    <Table className="hidden md:table" data-testid="spend-keys">
      <KeysColumns />
      <KeysHead />
      <TableBody>
        {rows.map((row) => {
          const { line } = row;
          const isSelected = selected === line.providerId;
          const select = (): void => {
            onSelect(line.providerId);
          };
          return (
            <TableRow
              key={line.providerId}
              data-key={line.name}
              aria-pressed={isSelected}
              tabIndex={0}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select();
                }
              }}
              className={cn(
                "h-10 cursor-pointer hover:bg-hover",
                isSelected &&
                  "hover:bg-transparent [&>td]:bg-sel [&>td:first-child]:rounded-l-[6px] [&>td:last-child]:rounded-r-[6px]",
              )}
            >
              <TableCell
                className="pl-1.5"
                {...(row.provider === undefined ? {} : { title: row.provider.host })}
              >
                <KeyName row={row} />
              </TableCell>
              <TableCell num className={cn(numberCell, "hidden min-[1100px]:table-cell")}>
                <TokenFigure n={line.inputTokens} />
              </TableCell>
              <TableCell num className={cn(numberCell, "hidden min-[1100px]:table-cell")}>
                <TokenFigure n={line.outputTokens} />
              </TableCell>
              <TableCell num className={cn(numberCell, "hidden min-[1100px]:table-cell")}>
                <TokenFigure n={line.cacheReadTokens} />
              </TableCell>
              <TableCell num className={cn(numberCell, "hidden min-[1100px]:table-cell")}>
                <TokenFigure n={line.cacheWriteTokens} />
              </TableCell>
              <TableCell num className={cn(numberCell, "min-[1100px]:hidden")}>
                <TokenFigure n={tokensOf(line)} />
              </TableCell>
              <TableCell num className="pr-1.5 text-[13.5px]" data-testid="key-spent">
                <SpentFigure data={data} line={line} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    {/* Phone and narrow: each key a two-line row, its host and tokens under its name. */}
    <ul className="md:hidden" data-testid="spend-keys-narrow">
      {rows.map((row) => {
        const { line } = row;
        const tokens = tokensOf(line);
        const isSelected = selected === line.providerId;
        return (
          <li key={line.providerId} className="border-b border-line">
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => {
                onSelect(line.providerId);
              }}
              className={cn(
                "grid w-full grid-cols-[15px_minmax(0,1fr)_auto] items-center gap-x-[15px] rounded-[6px] px-1 py-2.5 text-left",
                isSelected && "bg-sel",
              )}
            >
              {row.provider === undefined ? (
                <span aria-hidden className="size-[15px]" />
              ) : (
                <KeyLogo host={row.provider.host} />
              )}
              <span className="min-w-0 truncate font-mono text-[15px] leading-5 text-text">
                {line.name}
              </span>
              <span className="font-mono text-[15px] leading-5 text-text">
                <SpentFigure data={data} line={line} />
              </span>
              <span className="col-start-2 col-end-4 mt-1 truncate font-mono text-[12.5px] leading-4 text-faint">
                {row.provider === undefined ? null : <>{row.provider.host} · </>}
                {tokens === 0
                  ? t("spend.keys.phoneNothing")
                  : t("spend.keys.phoneTokens", { tokens: formatTokenCount(tokens) })}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  </>
);

/** A group of the panel: a hairline, 16px above and below, and its 12px heading with a count. */
const Group = ({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) => (
  <div className="mt-4 border-t border-line pt-4">
    <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-faint">
      {title}
      {count === undefined ? null : <span className="font-mono">{count}</span>}
    </h3>
    {children}
  </div>
);

const Prop = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  // 104px from the key to the value, as Spend's panel type draws it: PropRow's 8px gap is inside.
  <PropRow label={label} labelWidth={96} className="min-h-7">
    {children}
  </PropRow>
);

/** Splits a message around one `{name}` placeholder, so the value can take its own style. */
const around = (text: string): readonly [string, string] => {
  const [before = "", after = ""] = text.split("\u0000");
  return [before, after];
};

/**
 * The panel for a key (spend-keys.md, "The panel: a key selected"): read-only, since a key has no
 * budget in v1 (ADR 0055). Its month, the models it served, the projects that use it, and a link to it on Models.
 */
export const KeyPanel = ({
  data,
  row,
  providers,
  onPrice,
}: {
  readonly data: SpendMonth;
  readonly row: KeyRow;
  readonly providers: readonly Provider[] | undefined;
  readonly onPrice: (modelId: ModelId) => void;
}) => {
  const { line, provider } = row;
  const share = data.total.spentMicroUsd === 0 ? 0 : line.spentMicroUsd / data.total.spentMicroUsd;
  const models = data.byModel.filter((model) => model.providerId === line.providerId);
  const unpriced = unpricedModelsOf(data, line.providerId);
  const firstUnpriced = unpriced[0];
  const projects = provider?.projects ?? [];
  // A project's spend is this key's only when the project uses this one key (spend-keys.md, Data).
  const keysOf = (projectId: string): number =>
    (providers ?? []).filter((candidate) =>
      candidate.projects.some((project) => project.projectId === projectId),
    ).length;
  const spentOf = (projectId: string): number | null => {
    if (keysOf(projectId) !== 1) return null;
    const found = data.byProject.find(
      (project) => project.line.kind === "project" && project.line.projectId === projectId,
    );
    return found === undefined || found.spentMicroUsd === 0 ? null : found.spentMicroUsd;
  };
  const budgets = data.budgets.flatMap((budget) =>
    budget.scope.kind === "project" &&
    projects.some(
      (project) => budget.scope.kind === "project" && project.projectId === budget.scope.projectId,
    )
      ? [{ name: budget.scope.name, monthly: budget.monthlyMicroUsd }]
      : [],
  );
  const oneBudget = budgets.length === 1 ? budgets[0] : undefined;
  const [tokensBefore, tokensAfter] = around(t("spend.keys.unpricedTokens", { tokens: "\u0000" }));
  const [shareBefore, shareAfter] = around(t("spend.keys.share", { share: "\u0000" }));

  return (
    <div data-testid="key-panel">
      <div className="text-xs leading-4 font-medium text-faint">{t("spend.keys.eyebrow")}</div>
      <h2 className="mt-1 truncate font-mono text-[15px] font-semibold leading-5 text-text">
        {line.name}
      </h2>
      {provider === undefined ? null : (
        <p className="mt-1 text-[13.5px] leading-[18px] text-muted">
          <span className="font-mono text-sm">{provider.host}</span> ·{" "}
          {formatLabel(provider.apiFormat)}
        </p>
      )}
      <Group title={monthName(data.month)}>
        <Prop label={t("spend.colSpent")}>
          <span className="font-mono" data-testid="key-panel-spent">
            {formatUsd(line.spentMicroUsd)}
          </span>
        </Prop>
        <Prop label={t("spend.keys.shareLabel")}>
          {shareBefore.trim() === "" ? null : <span>{shareBefore.trim()}</span>}
          <span className="font-mono">{formatShare(share)}</span>{" "}
          <span className="truncate text-sm text-faint">{shareAfter.trim()}</span>
        </Prop>
        <Prop label={t("spend.keys.tasks")}>
          <span className="font-mono" data-testid="key-panel-tasks">
            {line.taskCount}
          </span>
        </Prop>
        {line.unpricedTokens > 0 ? (
          <Prop label={t("spend.keys.unpriced")}>
            <CircleAlertIcon aria-hidden className="shrink-0 stroke-[1.75] !text-red" />
            <span>
              {tokensBefore}
              <span className="font-mono">{formatTokenCount(line.unpricedTokens)}</span>
              {tokensAfter}
            </span>
          </Prop>
        ) : null}
        {firstUnpriced === undefined ? null : (
          <p className="mt-1 text-sm text-faint" data-testid="key-panel-unpriced">
            {unpriced.length === 1
              ? t("spend.keys.unpricedLine", {
                  model: firstUnpriced.name,
                  amount: formatUsd(line.spentMicroUsd),
                })
              : t("spend.keys.unpricedLineMany", {
                  n: unpriced.length,
                  amount: formatUsd(line.spentMicroUsd),
                })}{" "}
            {unpriced.length === 1 ? (
              <button
                type="button"
                className="text-teal hover:underline"
                onClick={() => {
                  onPrice(firstUnpriced.modelId);
                }}
              >
                {t("spend.enterPrice")}
              </button>
            ) : null}
          </p>
        )}
      </Group>
      <Group title={t("spend.keys.models")} count={models.length}>
        {models.length === 0 ? (
          <p className="text-sm text-faint">
            {t("spend.keys.modelsNone", { month: monthName(data.month) })}
          </p>
        ) : (
          <ul data-testid="key-panel-models">
            {models.map((model) => (
              <li
                key={model.modelId}
                className="grid min-h-[30px] grid-cols-[22px_minmax(0,1fr)_auto] items-center text-ui"
              >
                {model.logoPath === null ? (
                  <CpuIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                ) : (
                  <img src={model.logoPath} alt="" className="size-[15px] opacity-75 invert" />
                )}
                <span className={cn("truncate text-text", model.custom && "font-mono")}>
                  {model.name}
                </span>
                {model.unpricedTokens > 0 && model.spentMicroUsd === 0 ? (
                  <span className="pl-3 text-red">{t("spend.noPrice")}</span>
                ) : (
                  <span className="pl-3 font-mono text-[13.5px] text-text">
                    {formatUsd(model.spentMicroUsd)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Group>
      <Group title={t("spend.keys.usedBy")} count={projects.length}>
        {projects.length === 0 ? (
          <p className="text-sm text-faint">{t("models.keys.onNoList")}</p>
        ) : (
          <ul data-testid="key-panel-projects">
            {projects.map((project) => {
              const spent = spentOf(project.projectId);
              return (
                <li
                  key={project.projectId}
                  className="grid min-h-[30px] grid-cols-[22px_minmax(0,1fr)_auto] items-center text-ui"
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-[2px]"
                    style={{ background: projectColour(project.projectId) }}
                  />
                  <span className="truncate font-mono text-[13.5px] text-text">{project.name}</span>
                  <span className="pl-3 text-sm text-faint">
                    {project.via === "own" ? t("models.keys.viaOwn") : t("models.keys.viaDefault")}
                    {spent === null ? null : (
                      <>
                        {" · "}
                        <span className="font-mono">{formatUsd(spent)}</span>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-1.5 text-sm text-faint" data-testid="key-panel-budgets">
          {oneBudget === undefined ? (
            budgets.length === 0 ? (
              t("spend.keys.noBudget")
            ) : (
              t("spend.keys.budgetsMany")
            )
          ) : (
            <BudgetsOne project={oneBudget.name} amount={formatUsd(oneBudget.monthly)} />
          )}
        </p>
      </Group>
      <Link
        href={`/organization/models?provider=${line.providerId}`}
        className="mt-3.5 inline-flex items-center gap-1 text-ui text-teal hover:underline"
      >
        {t("spend.keys.onModels")}
        <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
      </Link>
    </div>
  );
};

/** `Budgets stay per project: northwind-portal's is $800.00. …`, the amount in mono. */
const BudgetsOne = ({ project, amount }: { readonly project: string; readonly amount: string }) => {
  const [before, after] = around(t("spend.keys.budgetsOne", { project, amount: "\u0000" }));
  return (
    <>
      {before}
      <span className="font-mono">{amount}</span>
      {after}
    </>
  );
};
