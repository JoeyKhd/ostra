"use client";

import { BanIcon, ClockIcon, PauseIcon, PencilLineIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { PropRow } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";

import { adminNames } from "./no-key-words";

// "No key for this model in this project" (F-135, app-targets/m4/no-key-for-model.md): the same
// sentence on New task, a queued task, a held message and Home's needs-you row. It names who can
// fix it and never falls back to another key (ADR 0065).

export type NoKey = {
  /** The model's display name, or a custom model's endpoint ID (`mono`). */
  readonly model: string;
  readonly mono: boolean;
  readonly projectName: string;
};

const ModelWord = ({ noKey }: { readonly noKey: NoKey }) => (noKey.mono ? <span className="font-mono">{noKey.model}</span> : <>{noKey.model}</>);

/** `No key for {model} in {project}.` with the model and the project in their own type. */
export const NoKeySentence = ({ noKey }: { readonly noKey: NoKey }) => {
  const [before = "", middle = "", after = ""] = t("noKey.sentence").split(/\{model\}|\{project\}/);
  return (
    <>
      {before}
      <ModelWord noKey={noKey} />
      {middle}
      <span className="font-mono">{noKey.projectName}</span>
      {after}
    </>
  );
};

/** `An organization admin picks one in Models and keys.`, the last words a link for an organization admin. */
export const WhoPicks = ({ projectId, organizationAdmin, suffix }: { readonly projectId: string; readonly organizationAdmin: boolean; readonly suffix?: string }) => {
  const [before = "", after = ""] = t("noKey.whoPicks").split("{place}");
  return (
    <>
      {before}
      {organizationAdmin ? (
        <Link href={`/projects/${projectId}/settings/models`} className="text-teal hover:underline">{t("noKey.place")}</Link>
      ) : (
        t("noKey.place")
      )}
      {after}
      {suffix === undefined ? null : ` ${suffix}`}
    </>
  );
};

/** New task's reason line under the composer, and who can fix it. */
export const NoKeyReason = ({ id, noKey, projectId, organizationAdmin, admins }: {
  readonly id: string;
  readonly noKey: NoKey;
  readonly projectId: string;
  readonly organizationAdmin: boolean;
  readonly admins: readonly string[];
}) => (
  <div className="mt-3" data-testid="no-key">
    <p id={id} role="status" className="flex items-start gap-2 text-body">
      <BanIcon aria-hidden className="mt-[3px] size-[15px] shrink-0 stroke-[1.75] text-muted" />
      <span>
        <span className="text-text"><NoKeySentence noKey={noKey} /></span>{" "}
        <span className="text-muted"><WhoPicks projectId={projectId} organizationAdmin={organizationAdmin} /></span>
      </span>
    </p>
    {organizationAdmin || admins.length === 0 ? null : <p className="mt-1 pl-[23px] text-sm text-faint">{adminNames(admins)}</p>}
  </div>
);

const NextRow = ({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) => (
  <li className="flex min-h-[38px] items-center gap-3 py-1.5 text-body text-muted">
    <span className="flex w-[15px] shrink-0 [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">{icon}</span>
    <span className="min-w-0 break-words">{children}</span>
  </li>
);

/** What happens next while no key serves the model: nothing starts; pick another profile; the draft stays. */
export const NoKeyNext = ({ noKey }: { readonly noKey: NoKey }) => {
  const [before = "", middle = "", after = ""] = t("noKey.next.nothing").split(/\{project\}|\{model\}/);
  return (
    <ul className="rows" data-testid="what-happens-next">
      <NextRow icon={<ClockIcon aria-hidden />}>
        {before}
        <span className="font-mono">{noKey.projectName}</span>
        {middle}
        <ModelWord noKey={noKey} />
        {after}
      </NextRow>
      <NextRow icon={<SlidersHorizontalIcon aria-hidden />}>{t("noKey.next.otherProfile")}</NextRow>
      <NextRow icon={<PencilLineIcon aria-hidden />}>{t("noKey.next.draftStays")}</NextRow>
    </ul>
  );
};

/** The panel's `Key` row: the serving key in mono, or `None in {project}` in `--red`. */
export const KeyRow = ({ providerName, projectName }: { readonly providerName: string | null; readonly projectName: string }) => (
  <PropRow label={t("noKey.keyLabel")}>
    {providerName === null ? (
      <span className="truncate text-red" data-testid="task-key">{t("noKey.noneIn", { project: projectName })}</span>
    ) : (
      <span className="truncate font-mono text-ui" data-testid="task-key">{providerName}</span>
    )}
  </PropRow>
);

/**
 * A held message's marker (no-key-for-model.md, section 3): under the member's message on a task
 * whose key left the list, in the budget hold's form. Nothing starts until a key serves the model.
 */
export const HeldNoKey = ({ noKey }: { readonly noKey: NoKey }) => {
  const [before = "", middle = "", after = ""] = t("noKey.held").split(/\{model\}|\{project\}/);
  return (
    <p className="flex items-start gap-2 py-1 pl-10 text-sm text-muted" data-testid="held-no-key">
      <PauseIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-faint" />
      <span>
        {before}
        <ModelWord noKey={noKey} />
        {middle}
        <span className="font-mono">{noKey.projectName}</span>
        {after}
      </span>
    </p>
  );
};
